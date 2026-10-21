/**
 * Groq speech-to-text port for inbound audio transcription
 * (TRANSCRICAO-GROQ-20261021, retrabalho append-only TRANSCRICAO-FIX-063).
 *
 * Bounded seam: the scheduler tick lists AUDIO messages whose
 * `metadata_json.transcription.status` is `PENDING_FOLLOW_UP` (that marker is
 * INSERT-time evidence from `mediaMetadataFor` and is NEVER mutated —
 * `communication.messages` is append-only), resolves the real bytes behind
 * the tenant-scoped `platform.inbound_attachments` ref, and transcribes them
 * here. Transcription STATE lives in the append-only
 * `platform.message_transcripts` event log (migration 063): one row per
 * event, latest row per (message_id, created_at DESC, id DESC) wins.
 *
 * - Transport is the native `fetch` + `FormData` only — no new npm
 *   dependency. Endpoint: `POST
 *   https://api.groq.com/openai/v1/audio/transcriptions` (OpenAI-compatible),
 *   model `whisper-large-v3-turbo` (override `GROQ_STT_MODEL`), `language: pt`,
 *   `response_format: json`, timeout 120 s.
 * - `GROQ_API_KEY` follows the WAHA/Asaas env-direct pattern (NOT Infisical:
 *   Infisical refs are for provider credentials per ADR-0014; service API
 *   keys like `WAHA_API_KEY`/`ASAAS_API_KEY` read env directly). Empty means
 *   absent (repo rule) → `groqTranscriptionPortFromEnv` returns null and the
 *   drain skips silently with a log, keeping messages unclaimed.
 * - The key travels ONLY as the `Authorization: Bearer` header value; it is
 *   never logged (only presence is observable) and never appears in error
 *   text. Transcripts are never logged either — logs carry refs/sizes only.
 */

export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_STT_DEFAULT_MODEL = "whisper-large-v3-turbo";
export const GROQ_STT_TIMEOUT_MS = 120_000;

export interface TranscriptionInput {
  /** Real audio bytes (resolved tenant-scoped, never a URL). */
  bytes: Uint8Array;
  mime: string;
  fileName?: string | null;
}

export interface TranscriptionResult {
  text: string;
  engine: "groq";
  model: string;
}

export interface TranscriptionPort {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export interface GroqTranscriptionOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Sanitized transcription failure (finding 3, MEDIUM). The adapter NEVER
 * propagates provider body text, transport messages, or any dynamic content:
 * every failure maps to a fixed local `code` with a fixed local message.
 * The service persists/logs ONLY the code (+ attempt) — never `err.message`
 * raw, never the transcript, never the key.
 */
export type GroqTranscriptionErrorCode =
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "TIMEOUT"
  | "NETWORK"
  | "PARSE"
  | "EMPTY"
  | "INTERNAL";

const GROQ_ERROR_MESSAGES: Record<GroqTranscriptionErrorCode, string> = {
  HTTP_4XX: "groq transcription refused by provider (client error)",
  HTTP_5XX: "groq transcription failed (provider error)",
  TIMEOUT: "groq transcription timed out",
  NETWORK: "groq transcription transport failed",
  PARSE: "groq transcription returned an unreadable payload",
  EMPTY: "groq transcription returned empty text",
  INTERNAL: "transcription failed before provider call",
};

export class GroqTranscriptionError extends Error {
  readonly code: GroqTranscriptionErrorCode;

  constructor(code: GroqTranscriptionErrorCode) {
    super(GROQ_ERROR_MESSAGES[code]);
    this.name = "GroqTranscriptionError";
    this.code = code;
  }
}

export class GroqTranscriptionAdapter implements TranscriptionPort {
  readonly name = "groq-stt";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GroqTranscriptionOptions) {
    this.apiKey = options.apiKey;
    const model = options.model?.trim() ?? "";
    this.model = model.length > 0 ? model : GROQ_STT_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? GROQ_STT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getModel(): string {
    return this.model;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (input.bytes.length === 0) {
      throw new Error("groq transcription refused: attachment has no bytes");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const fileName = input.fileName?.trim() ? input.fileName.trim() : "audio.ogg";
      // Copy into a detached ArrayBuffer: the `Blob` lib typing in this
      // toolchain does not accept a bare `Uint8Array` part.
      const view = input.bytes;
      const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
      const form = new FormData();
      form.append("file", new Blob([copy], { type: input.mime }), fileName);
      form.append("model", this.model);
      form.append("language", "pt");
      form.append("response_format", "json");
      let res: Response;
      try {
        res = await this.fetchImpl(GROQ_TRANSCRIPTIONS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new GroqTranscriptionError("TIMEOUT");
        }
        throw new GroqTranscriptionError("NETWORK");
      }
      if (!res.ok) {
        throw new GroqTranscriptionError(res.status >= 500 ? "HTTP_5XX" : "HTTP_4XX");
      }
      // The body is NEVER propagated: parse failure and shape mismatch both
      // map to fixed local codes (no response text in any message).
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new GroqTranscriptionError("PARSE");
      }
      const text =
        body !== null && typeof body === "object" && typeof (body as { text?: unknown }).text === "string"
          ? (body as { text: string }).text.trim()
          : "";
      if (text === "") {
        throw new GroqTranscriptionError("EMPTY");
      }
      return { text, engine: "groq", model: this.model };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Env wiring (`TRANSCRIPTION_PORT` provider). Empty `GROQ_API_KEY` means
 * absent (repo rule) → null, so the drain skips silently. `GROQ_STT_MODEL`
 * overrides the default model; blank falls back to the default.
 */
export function groqApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["GROQ_API_KEY"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  return raw;
}

export function groqSttModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["GROQ_STT_MODEL"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return GROQ_STT_DEFAULT_MODEL;
  }
  return raw.trim();
}

export function groqTranscriptionPortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): TranscriptionPort | null {
  const apiKey = groqApiKeyFromEnv(env);
  if (apiKey === null) {
    return null;
  }
  return new GroqTranscriptionAdapter({ apiKey, model: groqSttModelFromEnv(env), fetchImpl });
}

export const TranscriptionPortProvider = {
  provide: "TRANSCRIPTION_PORT",
  useFactory: (): TranscriptionPort | null => groqTranscriptionPortFromEnv(),
};

// ---------------------------------------------------------------------------
// `platform.message_transcripts` row model (pure, unit-tested).
//
// `communication.messages` is append-only (trigger `messages_append_only`,
// migration 009): the drain NEVER updates it. Transcription state is an
// event log — one row per CLAIMED/TRANSCRIBED/FAILED event; the latest row
// per (message_id, created_at DESC, id DESC) is authoritative.
//
// - Claim: INSERT CLAIMED with `attempt` = prior CLAIMED count + 1, guarded
//   by the partial unique index (at most one CLAIMED per message × cycle)
//   via `ON CONFLICT DO NOTHING` — the loser inserts 0 rows and skips. A
//   CLAIMED older than STALE_AFTER_MIN is presumed orphaned and becomes
//   eligible again at the next attempt number.
// - Success: INSERT TRANSCRIBED (same attempt; carries engine/model/
//   transcript). Terminal: latest row TRANSCRIBED.
// - Failure: INSERT FAILED (same attempt; carries the sanitized error
//   CODE only). Retryable while latest is FAILED with `attempt < MAX`;
//   terminal once the latest FAILED reaches `attempt >= MAX` (never claimed
//   again). A late outcome (a newer CLAIMED exists) is fenced at INSERT time
//   and never recorded.
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_STATUS_PENDING = "PENDING_FOLLOW_UP";
export const TRANSCRIPTION_STATUS_CLAIMED = "CLAIMED";
export const TRANSCRIPTION_STATUS_TRANSCRIBED = "TRANSCRIBED";
export const TRANSCRIPTION_STATUS_FAILED = "FAILED";
export const TRANSCRIPTION_MAX_ATTEMPTS = 5;

/** Minimal row shape the drain logic reasons over (DB row or test double). */
export interface TranscriptRow {
  id: string;
  status: string;
  attempt: number;
  transcript?: string | null;
  created_at: Date | string;
}

function rowTime(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Latest row wins: `created_at` DESC, `id` DESC as a deterministic tiebreak
 * (successive drain events land in separate transactions, so timestamps
 * differ in practice; the tiebreak only orders the pathological case).
 */
export function latestTranscriptRow(rows: TranscriptRow[]): TranscriptRow | null {
  let best: TranscriptRow | null = null;
  for (const row of rows) {
    if (best === null) {
      best = row;
      continue;
    }
    const time = rowTime(row.created_at) - rowTime(best.created_at);
    if (time > 0 || (time === 0 && row.id > best.id)) {
      best = row;
    }
  }
  return best;
}

/** Next cycle number: prior CLAIMED count + 1 (claim and outcome share it). */
export function nextTranscriptAttempt(rows: TranscriptRow[]): number {
  let claims = 0;
  for (const row of rows) {
    if (row.status === TRANSCRIPTION_STATUS_CLAIMED) {
      claims += 1;
    }
  }
  return claims + 1;
}

export type TranscriptEligibility =
  | { eligible: true; attempt: number }
  | { eligible: false; reason: "in_flight" | "transcribed" | "terminal" };

/**
 * Pure claim gate over a message's transcript history, staleness-aware
 * (finding 2, HIGH): eligible when no history exists, when the latest row is
 * a retryable FAILED (`attempt < MAX`), or when the latest row is a STALE
 * CLAIMED (older than `staleAfterMin` — the owning tick is presumed dead and
 * the cycle is retried at the next attempt number). A FRESH CLAIMED (another
 * tick owns it), a TRANSCRIBED, or a FAILED at/over budget never re-claims.
 *
 * Mirrors the SQL candidate predicate in `TranscriptionService`: the SQL
 * narrows the set before LIMIT (anti-starvation), this gate re-confirms
 * per message inside the claim transaction (defense in depth).
 */
export function transcriptEligibility(
  rows: TranscriptRow[],
  now: Date = new Date(),
  staleAfterMin = 30,
): TranscriptEligibility {
  const latest = latestTranscriptRow(rows);
  if (latest === null) {
    return { eligible: true, attempt: 1 };
  }
  if (latest.status === TRANSCRIPTION_STATUS_CLAIMED) {
    const ageMs = now.getTime() - rowTime(latest.created_at);
    if (ageMs >= staleAfterMin * 60_000) {
      const attempt = nextTranscriptAttempt(rows);
      return attempt > TRANSCRIPTION_MAX_ATTEMPTS
        ? { eligible: false, reason: "terminal" }
        : { eligible: true, attempt };
    }
    return { eligible: false, reason: "in_flight" };
  }
  if (latest.status === TRANSCRIPTION_STATUS_TRANSCRIBED) {
    return { eligible: false, reason: "transcribed" };
  }
  if (latest.status === TRANSCRIPTION_STATUS_FAILED) {
    if (latest.attempt < TRANSCRIPTION_MAX_ATTEMPTS) {
      const attempt = nextTranscriptAttempt(rows);
      return attempt > TRANSCRIPTION_MAX_ATTEMPTS
        ? { eligible: false, reason: "terminal" }
        : { eligible: true, attempt };
    }
    return { eligible: false, reason: "terminal" };
  }
  return { eligible: false, reason: "terminal" };
}

/**
 * Transcript text for agent evaluation: non-blank `transcript` ONLY when the
 * latest row is TRANSCRIBED — never a guess, never a log line. Null
 * otherwise.
 */
export function transcribedTextOf(rows: TranscriptRow[]): string | null {
  const latest = latestTranscriptRow(rows);
  if (latest === null || latest.status !== TRANSCRIPTION_STATUS_TRANSCRIBED) {
    return null;
  }
  const raw = latest.transcript;
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  return raw;
}
