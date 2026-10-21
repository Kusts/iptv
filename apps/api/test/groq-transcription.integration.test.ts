import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import { TranscriptionService } from "../src/communications/groq-transcription.service.js";
import {
  GroqTranscriptionError,
  TRANSCRIPTION_STATUS_CLAIMED,
  TRANSCRIPTION_STATUS_FAILED,
  TRANSCRIPTION_STATUS_PENDING,
  TRANSCRIPTION_STATUS_TRANSCRIBED,
  type TranscriptionPort,
} from "../src/communications/groq-transcription.port.js";
import {
  MemoryInboundAttachmentStore,
  resetInboundAttachmentStoreForTests,
  setInboundAttachmentStoreForTests,
} from "../src/communications/waha-inbound-attachments.js";

/**
 * Groq transcription drain (requires TEST_DATABASE_URL, append-only model
 * TRANSCRICAO-FIX-063-20261021).
 *
 * Service-level with a mocked `TranscriptionPort` (zero live Groq calls):
 * - PENDING AUDIO + valid port → INSERT CLAIMED + TRANSCRIBED rows carrying
 *   the pt transcript; the message row itself is NEVER mutated (its
 *   `metadata_json.transcription` marker stays PENDING_FOLLOW_UP forever —
 *   the append-only trigger would reject any UPDATE);
 * - null port (no `GROQ_API_KEY`) → zeros, no transcript rows, marker intact;
 * - failing port → FAILED rows attempts 1–5, terminal afterwards, never
 *   claimed again, tick never crashes.
 *
 * Tenant-scoped per call (`drainPending(10, { tenantId })`) so parallel
 * suites sharing the database never touch each other's rows.
 * Deterministic fixtures: counters only, never UUID-head slices.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const OGG_BYTES = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 7, 7, 7]);

let counter = 0;
function tag(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

function mockPort(text = "bom dia, quero renovar meu plano"): TranscriptionPort {
  return {
    name: "mock-stt",
    async transcribe() {
      return { text, engine: "groq", model: "whisper-large-v3-turbo" };
    },
  };
}

function failingPort(): TranscriptionPort {
  return {
    name: "failing-stt",
    async transcribe(): Promise<never> {
      // Fixed local code only: no provider body, no transcript, no key.
      throw new GroqTranscriptionError("HTTP_5XX");
    },
  };
}

describe.skipIf(!hasDb)("groq transcription drain (requires TEST_DATABASE_URL)", () => {
  const db = createDb({ connectionString: connectionString as string });

  let store: MemoryInboundAttachmentStore;

  interface TenantGraph {
    tenantId: string;
    personId: string;
    conversationId: string;
  }

  async function newTenantGraph(): Promise<TenantGraph> {
    const tenantId = newId();
    await db
      .insertInto("control.tenants")
      .values({
        id: tenantId,
        slug: tag("groq-stt"),
        name: "Groq STT Tenant",
        status: "ACTIVE",
        default_currency: "BRL",
        timezone: "America/Sao_Paulo",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const personId = newId();
    await db
      .insertInto("identity.persons")
      .values({
        id: personId,
        tenant_id: tenantId,
        status: "ACTIVE",
        canonical_name: "STT Customer",
        locale: null,
        timezone: null,
        created_at: new Date(),
        updated_at: new Date(),
        anonymized_at: null,
      })
      .execute();
    const conversationId = newId();
    await db
      .insertInto("communication.conversations")
      .values({
        id: conversationId,
        tenant_id: tenantId,
        person_id: personId,
        channel: "WHATSAPP",
        external_thread_id: `${tag("thread")}@c.us`,
        status: "OPEN",
        control_mode: "AI_CONTROL",
        last_message_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
        archived_at: null,
      })
      .execute();
    return { tenantId, personId, conversationId };
  }

  async function insertPendingAudio(graph: TenantGraph, externalId: string): Promise<string> {
    const created = await store.create(graph.tenantId, {
      kind: "AUDIO",
      mimeType: "audio/ogg",
      fileName: null,
      bytes: OGG_BYTES,
      durationSeconds: 12,
    });
    if (!created.ok) {
      throw new Error(`attachment create failed: ${created.message}`);
    }
    const messageId = newId();
    await db
      .insertInto("communication.messages")
      .values({
        id: messageId,
        tenant_id: graph.tenantId,
        conversation_id: graph.conversationId,
        person_id: graph.personId,
        direction: "INBOUND",
        channel: "WHATSAPP",
        sender_type: "PERSON",
        external_message_id: externalId,
        idempotency_key: null,
        content_type: "AUDIO",
        body_text: null,
        attachment_ref: created.ref,
        metadata_json: {
          provider: "waha",
          mediaKind: "AUDIO",
          mimeType: "audio/ogg",
          durationSeconds: 12,
          transcription: { status: TRANSCRIPTION_STATUS_PENDING, engine: null, transcriptRef: null },
        },
        occurred_at: new Date(),
        received_at: new Date(),
        created_at: new Date(),
      })
      .execute();
    return messageId;
  }

  async function transcriptRows(
    tenantId: string,
    messageId: string,
  ): Promise<Array<{ status: string; attempt: number; transcript: string | null }>> {
    return db
      .selectFrom("platform.message_transcripts")
      .select(["status", "attempt", "transcript"])
      .where("tenant_id", "=", tenantId)
      .where("message_id", "=", messageId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  async function metadataMarker(tenantId: string, messageId: string): Promise<unknown> {
    const row = await db
      .selectFrom("communication.messages")
      .select(["metadata_json"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", messageId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error(`message not found: ${messageId}`);
    }
    return (row.metadata_json as Record<string, unknown>)["transcription"];
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    store = new MemoryInboundAttachmentStore();
    setInboundAttachmentStoreForTests(store);
  }, 120_000);

  afterEach(() => {
    setInboundAttachmentStoreForTests(store);
  });

  afterAll(async () => {
    resetInboundAttachmentStoreForTests();
    await db.destroy().catch(() => undefined);
  });

  it("transcribes PENDING audio into CLAIMED + TRANSCRIBED rows, message row untouched", async () => {
    const graph = await newTenantGraph();
    const messageId = await insertPendingAudio(graph, tag("wamsg-stt"));
    const service = new TranscriptionService(db, mockPort());
    const outcome = await service.drainPending(10, { tenantId: graph.tenantId });
    expect(outcome).toEqual({ processed: 1, failed: 0 });
    const rows = await transcriptRows(graph.tenantId, messageId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "CLAIMED", attempt: 1 });
    expect(rows[1]).toMatchObject({
      status: TRANSCRIPTION_STATUS_TRANSCRIBED,
      attempt: 1,
      transcript: "bom dia, quero renovar meu plano",
    });
    // Append-only proof: the message row (incl. its ingest-time marker) was
    // never mutated — the trigger would have rejected any UPDATE.
    expect(await metadataMarker(graph.tenantId, messageId)).toEqual({
      status: TRANSCRIPTION_STATUS_PENDING,
      engine: null,
      transcriptRef: null,
    });
    // Terminal success is never re-claimed.
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 0 });
    expect(await transcriptRows(graph.tenantId, messageId)).toHaveLength(2);
  });

  it("skips silently without a key: zeros, no transcript rows, marker intact", async () => {
    const saved = process.env["GROQ_API_KEY"];
    delete process.env["GROQ_API_KEY"];
    try {
      const graph = await newTenantGraph();
      const messageId = await insertPendingAudio(graph, tag("wamsg-stt"));
      const service = new TranscriptionService(db, null);
      expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 0 });
      expect(await transcriptRows(graph.tenantId, messageId)).toHaveLength(0);
      expect(await metadataMarker(graph.tenantId, messageId)).toEqual({
        status: TRANSCRIPTION_STATUS_PENDING,
        engine: null,
        transcriptRef: null,
      });
    } finally {
      if (saved === undefined) {
        delete process.env["GROQ_API_KEY"];
      } else {
        process.env["GROQ_API_KEY"] = saved;
      }
    }
  });

  it("retries failures to terminal FAILED without crashing the tick", async () => {
    const graph = await newTenantGraph();
    const messageId = await insertPendingAudio(graph, tag("wamsg-stt"));
    const service = new TranscriptionService(db, failingPort());
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 1 });
      const rows = await transcriptRows(graph.tenantId, messageId);
      const latest = rows[rows.length - 1];
      // Only the fixed error CODE is persisted — never raw messages.
      expect(latest).toMatchObject({ status: TRANSCRIPTION_STATUS_FAILED, attempt });
      expect(latest?.transcript).toBeNull();
    }
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 1 });
    const terminal = await transcriptRows(graph.tenantId, messageId);
    expect(terminal[terminal.length - 1]).toMatchObject({ status: TRANSCRIPTION_STATUS_FAILED, attempt: 5 });
    for (const row of terminal) {
      expect(row.transcript).toBeNull();
    }
    // Terminal FAILED is never claimed again, and the message row is intact.
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 0 });
    expect(await metadataMarker(graph.tenantId, messageId)).toEqual({
      status: TRANSCRIPTION_STATUS_PENDING,
      engine: null,
      transcriptRef: null,
    });
  });

  it("does not starve: 11 audios converge in two ticks (10 + 1)", async () => {
    const graph = await newTenantGraph();
    const messageIds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      messageIds.push(await insertPendingAudio(graph, tag("wamsg-stt")));
    }
    const service = new TranscriptionService(db, mockPort());
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 10, failed: 0 });
    let pending = 0;
    for (const messageId of messageIds) {
      const rows = await transcriptRows(graph.tenantId, messageId);
      if (rows.length === 0) {
        pending += 1;
      } else {
        expect(rows[rows.length - 1]?.status).toBe(TRANSCRIPTION_STATUS_TRANSCRIBED);
      }
    }
    expect(pending).toBe(1);
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 1, failed: 0 });
    for (const messageId of messageIds) {
      const rows = await transcriptRows(graph.tenantId, messageId);
      expect(rows[rows.length - 1]?.status).toBe(TRANSCRIPTION_STATUS_TRANSCRIBED);
    }
  });

  it("re-claims a stale orphaned CLAIMED at the next attempt number", async () => {
    const graph = await newTenantGraph();
    const messageId = await insertPendingAudio(graph, tag("wamsg-stt"));
    // Orphaned claim from a dead tick (31 min old, no outcome ever recorded).
    await db
      .insertInto("platform.message_transcripts")
      .values({
        id: newId(),
        tenant_id: graph.tenantId,
        message_id: messageId,
        status: TRANSCRIPTION_STATUS_CLAIMED,
        attempt: 1,
        engine: null,
        model: null,
        transcript: null,
        error: null,
        created_at: new Date(Date.now() - 31 * 60_000),
      })
      .execute();
    const service = new TranscriptionService(db, mockPort());
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 1, failed: 0 });
    const rows = await transcriptRows(graph.tenantId, messageId);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 2 });
    expect(rows[2]).toMatchObject({
      status: TRANSCRIPTION_STATUS_TRANSCRIBED,
      attempt: 2,
      transcript: "bom dia, quero renovar meu plano",
    });
  });

  it("fences a late outcome: a superseded claim records nothing and counts nothing", async () => {
    const graph = await newTenantGraph();
    const messageId = await insertPendingAudio(graph, tag("wamsg-stt"));
    const racingPort: TranscriptionPort = {
      name: "racing-stt",
      async transcribe() {
        // A concurrent tick re-claims (stale window) while this tick is
        // still transcribing: the in-flight outcome becomes late.
        await db
          .insertInto("platform.message_transcripts")
          .values({
            id: newId(),
            tenant_id: graph.tenantId,
            message_id: messageId,
            status: TRANSCRIPTION_STATUS_CLAIMED,
            attempt: 2,
            engine: null,
            model: null,
            transcript: null,
            error: null,
            created_at: new Date(),
          })
          .execute();
        return { text: "late transcript, must be dropped", engine: "groq", model: "whisper-large-v3-turbo" };
      },
    };
    const service = new TranscriptionService(db, racingPort);
    // The service's own claim is attempt 1; the raced CLAIMED(2) supersedes
    // it before the outcome lands → fenced, counts nothing.
    expect(await service.drainPending(10, { tenantId: graph.tenantId })).toEqual({ processed: 0, failed: 0 });
    const rows = await transcriptRows(graph.tenantId, messageId);
    expect(rows).toHaveLength(2);
    // Order-agnostic (same-ms ties break by id): both cycles claimed, no
    // outcome recorded for the superseded cycle.
    expect(rows.filter((row) => row.status === TRANSCRIPTION_STATUS_CLAIMED).map((row) => row.attempt).sort()).toEqual([
      1, 2,
    ]);
    expect(rows.some((row) => row.status === TRANSCRIPTION_STATUS_TRANSCRIBED)).toBe(false);
    expect(rows.some((row) => row.status === TRANSCRIPTION_STATUS_FAILED)).toBe(false);
  });
});
