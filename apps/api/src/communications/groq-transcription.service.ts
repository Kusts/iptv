import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { sql, type Kysely, type Transaction } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import { AgentPipeline } from "../agent/pipeline.js";
import { currentInboundAttachmentStore } from "./waha-inbound-attachments.js";
import {
  GroqTranscriptionError,
  groqTranscriptionPortFromEnv,
  transcriptEligibility,
  TRANSCRIPTION_MAX_ATTEMPTS,
  TRANSCRIPTION_STATUS_CLAIMED,
  TRANSCRIPTION_STATUS_FAILED,
  TRANSCRIPTION_STATUS_PENDING,
  TRANSCRIPTION_STATUS_TRANSCRIBED,
  type TranscriptRow,
  type TranscriptionPort,
} from "./groq-transcription.port.js";

export interface TranscriptionDrainResult {
  processed: number;
  failed: number;
}

interface ClaimedAudio {
  messageId: string;
  conversationId: string;
  attachmentRef: string;
  attempt: number;
}

/** History rows for one message, latest first (service read order). */
type TranscriptHistory = Array<{
  id: string;
  status: string;
  attempt: number;
  transcript: string | null;
  created_at: Date;
}>;

function toRows(history: TranscriptHistory): TranscriptRow[] {
  return history.map((row) => ({
    id: row.id,
    status: row.status,
    attempt: row.attempt,
    transcript: row.transcript,
    created_at: row.created_at,
  }));
}

/**
 * Staleness budget for orphaned claims (finding 2, HIGH): a CLAIMED row older
 * than this is presumed dead (owning tick crashed between claim and outcome)
 * and becomes eligible again at the next attempt number. Named constant, no
 * new env (deliberate: operational tuning stays in code review, not config).
 */
export const STALE_AFTER_MIN = 30;

/**
 * Groq STT transcription drain (TRANSCRICAO-GROQ-20261021, append-only
 * retrabalho TRANSCRICAO-FIX-063-20261021 + review fixes
 * TRANSCRICAO-FIX-REVIEW-20261021). Runs inside the scheduler tick
 * (`transcription.drainPending`, N=10).
 *
 * Invariant: `communication.messages` is NEVER updated here (trigger
 * `messages_append_only`, migration 009 rejects every UPDATE/DELETE). The
 * ingest-time `metadata_json.transcription.status = PENDING_FOLLOW_UP`
 * marker is read-only candidacy evidence; transcription STATE is the
 * append-only `platform.message_transcripts` event log (migration 063):
 * claim = INSERT CLAIMED ... ON CONFLICT DO NOTHING (the partial unique
 * index admits at most one CLAIMED per message × cycle, so a concurrent tick
 * losing the race inserts 0 rows and skips), success = INSERT TRANSCRIBED,
 * failure = INSERT FAILED. Latest row per (message_id, created_at DESC, id
 * DESC) wins; retry while the latest FAILED sits below
 * TRANSCRIPTION_MAX_ATTEMPTS, terminal afterwards.
 *
 * - Eligibility lives in SQL BEFORE the LIMIT (finding 1, HIGH): one
 *   candidate query per tenant filters out TRANSCRIBED / terminal-FAILED /
 *   fresh-CLAIMED / over-budget messages set-wise, so eligible rows past the
 *   LIMIT window never starve. The pure JS gate re-confirms per message
 *   inside the claim transaction (defense in depth).
 * - A late outcome (a newer CLAIMED landed while this tick transcribed) is
 *   fenced at INSERT time via `WHERE NOT EXISTS` and never recorded — a
 *   fenced outcome counts NEITHER processed NOR failed (silent skip + log).
 * - Errors are codes only (finding 3, MEDIUM): the adapter maps every
 *   failure to a fixed `GroqTranscriptionErrorCode`; the service persists
 *   and logs ONLY the code (+ attempt) — never `err.message` raw, never the
 *   transcript, never the key, never provider body text.
 * - No key → skip silently with a log (nothing claimed, tick unaffected).
 * - A failing row never crashes the tick (per-row try/catch, like the
 *   scheduler's `runTask`); its outcome is recorded as a FAILED row.
 * - Success → best-effort `evaluateInbound` with the transcript text (the
 *   ingest-time evaluation only ever saw the empty PTT body); advisory, like
 *   the webhook path.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Optional() @Inject("TRANSCRIPTION_PORT") private readonly port?: TranscriptionPort | null,
    @Optional() @Inject(AgentPipeline) private readonly agents?: AgentPipeline | null,
  ) {}

  private resolvePort(): TranscriptionPort | null {
    return this.port ?? groqTranscriptionPortFromEnv();
  }

  async drainPending(limit = 10, opts?: { tenantId?: string }): Promise<TranscriptionDrainResult> {
    const result: TranscriptionDrainResult = { processed: 0, failed: 0 };
    if (this.db === null) {
      return result;
    }
    const port = this.resolvePort();
    if (port === null) {
      this.logger.log("transcription skipped: GROQ_API_KEY is not configured (audio stays PENDING_FOLLOW_UP)");
      return result;
    }
    const db = this.db;
    const tenants = opts?.tenantId !== undefined ? [opts.tenantId] : await this.listTenants(db);
    for (const tenantId of tenants) {
      if (result.processed + result.failed >= limit) {
        break;
      }
      const remaining = limit - (result.processed + result.failed);
      const claimed = await this.claimForTenant(db, tenantId, remaining);
      for (const row of claimed) {
        if (result.processed + result.failed >= limit) {
          break;
        }
        try {
          const record = await currentInboundAttachmentStore().resolve(tenantId, row.attachmentRef);
          if (record === null) {
            throw new GroqTranscriptionError("INTERNAL");
          }
          const outcome = await port.transcribe({
            bytes: record.bytes,
            mime: record.mimeType,
            fileName: record.fileName,
          });
          const recorded = await withTenantTransaction(db, tenantId, (trx) =>
            this.insertOutcome(trx, tenantId, {
              messageId: row.messageId,
              status: TRANSCRIPTION_STATUS_TRANSCRIBED,
              attempt: row.attempt,
              engine: "groq",
              model: outcome.model,
              transcript: outcome.text,
              error: null,
            }),
          );
          if (!recorded) {
            // Superseded while transcribing (a newer CLAIMED owns the
            // message now): the late outcome is dropped, counts nothing.
            this.logger.log(
              JSON.stringify({ task: "transcription.fenced", tenant: tenantId, messageId: row.messageId }),
            );
            continue;
          }
          result.processed += 1;
          try {
            await this.agents?.evaluateInbound({
              tenantId,
              conversationId: row.conversationId,
              inboundText: outcome.text,
            });
          } catch {
            // Agent evaluation is advisory; transcription is already persisted.
          }
        } catch (err) {
          // Codes only: Groq failures carry their fixed code; anything else
          // (missing bytes, unexpected throws) is INTERNAL. Raw messages,
          // provider bodies and transcripts never reach logs or rows.
          const code = err instanceof GroqTranscriptionError ? err.code : "INTERNAL";
          try {
            const recorded = await withTenantTransaction(db, tenantId, (trx) =>
              this.insertOutcome(trx, tenantId, {
                messageId: row.messageId,
                status: TRANSCRIPTION_STATUS_FAILED,
                attempt: row.attempt,
                engine: null,
                model: null,
                transcript: null,
                error: code,
              }),
            );
            if (recorded) {
              result.failed += 1;
            } else {
              this.logger.log(
                JSON.stringify({ task: "transcription.fenced", tenant: tenantId, messageId: row.messageId }),
              );
            }
          } catch (markErr) {
            const markMessage = markErr instanceof Error ? markErr.message : String(markErr);
            this.logger.error(
              JSON.stringify({ task: "transcription.markFailed", tenant: tenantId, messageId: row.messageId, error: markMessage }),
            );
          }
          this.logger.error(
            JSON.stringify({ task: "transcription.transcribe", tenant: tenantId, messageId: row.messageId, error: code }),
          );
        }
      }
    }
    return result;
  }

  private async listTenants(db: Kysely<Database>): Promise<string[]> {
    try {
      const rows = await sql<{ o_tenant_id: string }>`select * from control.list_scheduler_tenants()`.execute(db);
      return rows.rows.map((row) => row.o_tenant_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(JSON.stringify({ task: "transcription.listTenants", error: message }));
      return [];
    }
  }

  /**
   * Eligibility-first candidate selection (finding 1, HIGH): ONE query per
   * tenant applies every exclusion set-wise — TRANSCRIBED history, terminal
   * FAILED (attempt ≥ budget), a FRESH UNRESOLVED claim (a CLAIMED newer than
   * the staleness cutoff with no outcome at its attempt yet — a resolved
   * cycle never blocks its own retry), and the attempt budget — then orders
   * by `occurred_at` and caps at LIMIT. An eligible row past the window is
   * picked up by the NEXT tick instead of starving behind ineligible head
   * rows (no paginated scan in code). Each candidate is re-confirmed with the
   * pure JS gate inside the claim transaction (defense in depth) before the
   * fenced INSERT.
   */
  private async claimForTenant(db: Kysely<Database>, tenantId: string, limit: number): Promise<ClaimedAudio[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - STALE_AFTER_MIN * 60_000);
    let candidates: Array<{ id: string; conversation_id: string; attachment_ref: string | null }> = [];
    try {
      candidates = await withTenantTransaction(db, tenantId, (trx) =>
        sql<{ id: string; conversation_id: string; attachment_ref: string | null }>`
          SELECT m.id, m.conversation_id, m.attachment_ref
          FROM communication.messages AS m
          WHERE m.tenant_id = ${tenantId}
            AND m.content_type = 'AUDIO'
            AND m.metadata_json->'transcription'->>'status' = ${TRANSCRIPTION_STATUS_PENDING}
            AND m.attachment_ref IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM platform.message_transcripts AS t
              WHERE t.tenant_id = m.tenant_id AND t.message_id = m.id
                AND t.status = ${TRANSCRIPTION_STATUS_TRANSCRIBED}
            )
            AND NOT EXISTS (
              SELECT 1 FROM platform.message_transcripts AS f
              WHERE f.tenant_id = m.tenant_id AND f.message_id = m.id
                AND f.status = ${TRANSCRIPTION_STATUS_FAILED} AND f.attempt >= ${TRANSCRIPTION_MAX_ATTEMPTS}
            )
            AND NOT EXISTS (
              SELECT 1 FROM platform.message_transcripts AS c
              WHERE c.tenant_id = m.tenant_id AND c.message_id = m.id
                AND c.status = ${TRANSCRIPTION_STATUS_CLAIMED} AND c.created_at >= ${cutoff}
                AND NOT EXISTS (
                  SELECT 1 FROM platform.message_transcripts AS o
                  WHERE o.tenant_id = c.tenant_id AND o.message_id = c.message_id
                    AND o.status IN (${TRANSCRIPTION_STATUS_TRANSCRIBED}, ${TRANSCRIPTION_STATUS_FAILED})
                    AND o.attempt = c.attempt
                )
            )
            AND (
              SELECT count(*) FROM platform.message_transcripts AS c2
              WHERE c2.tenant_id = m.tenant_id AND c2.message_id = m.id
                AND c2.status = ${TRANSCRIPTION_STATUS_CLAIMED}
            ) < ${TRANSCRIPTION_MAX_ATTEMPTS}
          ORDER BY m.occurred_at ASC
          LIMIT ${limit}`.execute(trx).then((res) => res.rows),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(JSON.stringify({ task: "transcription.claim", tenant: tenantId, error: message }));
      return [];
    }
    const claimed: ClaimedAudio[] = [];
    for (const candidate of candidates) {
      if (candidate.attachment_ref === null) {
        continue;
      }
      try {
        const attempt = await withTenantTransaction(db, tenantId, (trx) =>
          this.tryClaim(trx, tenantId, candidate.id, now),
        );
        if (attempt !== null) {
          claimed.push({
            messageId: candidate.id,
            conversationId: candidate.conversation_id,
            attachmentRef: candidate.attachment_ref,
            attempt,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          JSON.stringify({ task: "transcription.claim", tenant: tenantId, messageId: candidate.id, error: message }),
        );
        continue;
      }
      if (claimed.length >= limit) {
        break;
      }
    }
    return claimed;
  }

  /**
   * Single-message claim: read history, apply the pure staleness-aware gate,
   * and INSERT the CLAIMED row. Returns the cycle attempt, or null when the
   * message must not be claimed (in-flight / done / terminal / lost the
   * unique race).
   */
  private async tryClaim(
    trx: Transaction<Database>,
    tenantId: string,
    messageId: string,
    now: Date,
  ): Promise<number | null> {
    const history = await this.readHistory(trx, tenantId, messageId);
    const gate = transcriptEligibility(toRows(history), now, STALE_AFTER_MIN);
    if (!gate.eligible) {
      return null;
    }
    const inserted = await trx
      .insertInto("platform.message_transcripts")
      .values({
        id: newId(),
        tenant_id: tenantId,
        message_id: messageId,
        status: TRANSCRIPTION_STATUS_CLAIMED,
        attempt: gate.attempt,
        engine: null,
        model: null,
        transcript: null,
        error: null,
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "message_id", "attempt"]).where("status", "=", TRANSCRIPTION_STATUS_CLAIMED).doNothing(),
      )
      .returning("id")
      .execute();
    if (inserted.length === 0) {
      return null;
    }
    return gate.attempt;
  }

  private async readHistory(
    trx: Transaction<Database>,
    tenantId: string,
    messageId: string,
  ): Promise<TranscriptHistory> {
    return trx
      .selectFrom("platform.message_transcripts")
      .select(["id", "status", "attempt", "transcript", "created_at"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", messageId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
  }

  /**
   * Late-outcome fence (finding 2, HIGH): the outcome row lands ONLY when no
   * NEWER CLAIMED row owns the message now (another tick re-claimed while
   * this tick transcribed). "Newer" is exact: claim attempts per message are
   * strictly increasing (each claim = prior CLAIMED count + 1, same-attempt
   * races collapse to one row via the partial unique index), so a CLAIMED
   * row with a HIGHER attempt supersedes this outcome. No timestamps, no
   * ties. Returns false when fenced — the caller drops the stale outcome
   * and counts nothing. Pure INSERT ... SELECT, no UPDATE.
   */
  private async insertOutcome(
    trx: Transaction<Database>,
    tenantId: string,
    outcome: {
      messageId: string;
      status: typeof TRANSCRIPTION_STATUS_TRANSCRIBED | typeof TRANSCRIPTION_STATUS_FAILED;
      attempt: number;
      engine: string | null;
      model: string | null;
      transcript: string | null;
      error: string | null;
    },
  ): Promise<boolean> {
    if (outcome.attempt < 1 || outcome.attempt > TRANSCRIPTION_MAX_ATTEMPTS) {
      throw new Error(`transcription outcome refused: attempt out of budget (${outcome.attempt})`);
    }
    const inserted = await sql<{ id: string }>`
      INSERT INTO platform.message_transcripts
        (id, tenant_id, message_id, status, attempt, engine, model, transcript, error, created_at)
      SELECT ${newId()}, ${tenantId}, ${outcome.messageId}, ${outcome.status}, ${outcome.attempt},
             ${outcome.engine}, ${outcome.model}, ${outcome.transcript}, ${outcome.error}, ${new Date()}
      WHERE NOT EXISTS (
        SELECT 1 FROM platform.message_transcripts AS t2
        WHERE t2.tenant_id = ${tenantId} AND t2.message_id = ${outcome.messageId}
          AND t2.status = ${TRANSCRIPTION_STATUS_CLAIMED}
          AND t2.attempt > ${outcome.attempt}
      )
      RETURNING id`.execute(trx);
    return inserted.rows.length > 0;
  }
}
