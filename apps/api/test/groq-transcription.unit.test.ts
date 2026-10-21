import { describe, expect, it } from "vitest";
import {
  GroqTranscriptionAdapter,
  GroqTranscriptionError,
  groqApiKeyFromEnv,
  groqSttModelFromEnv,
  groqTranscriptionPortFromEnv,
  GROQ_STT_DEFAULT_MODEL,
  latestTranscriptRow,
  nextTranscriptAttempt,
  TRANSCRIPTION_MAX_ATTEMPTS,
  TRANSCRIPTION_STATUS_CLAIMED,
  TRANSCRIPTION_STATUS_FAILED,
  TRANSCRIPTION_STATUS_TRANSCRIBED,
  transcribedTextOf,
  transcriptEligibility,
  type TranscriptRow,
} from "../src/communications/groq-transcription.port.js";

/**
 * Groq STT unit suite (TRANSCRICAO-FIX-063-20261021): no DB, no network —
 * every fetch is a controlled stub double. Fixture keys only, never real
 * credentials; error paths assert the key never leaks into messages.
 * The state machine is pure over transcript ROW LISTS (append-only model):
 * no message UPDATE exists anywhere in this suite.
 */

const FIXTURE_KEY = "groq-stt fixture key, not a credential";

function stubFetch(
  handler: (url: string, init: RequestInit) => unknown,
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: { ...(init ?? {}) } });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

function okResponse(text: string): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ text }),
  };
}

describe("GroqTranscriptionAdapter (fetch double, no network)", () => {
  it("posts multipart audio to the Groq endpoint with pt + model", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => okResponse("  olá, renovar plano  "), calls),
    });
    const result = await port.transcribe({ bytes: new Uint8Array([1, 2, 3]), mime: "audio/ogg" });
    expect(result).toEqual({ text: "olá, renovar plano", engine: "groq", model: GROQ_STT_DEFAULT_MODEL });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const init = calls[0]?.init ?? {};
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${FIXTURE_KEY}`);
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("model")).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(body.get("language")).toBe("pt");
    expect(body.get("response_format")).toBe("json");
    const file = body.get("file");
    expect(file).toBeInstanceOf(Blob);
  });

  it("honors the GROQ_STT_MODEL override", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      model: "whisper-large-v3",
      fetchImpl: stubFetch(() => okResponse("oi"), calls),
    });
    const result = await port.transcribe({ bytes: new Uint8Array([9]), mime: "audio/mpeg" });
    expect(result.model).toBe("whisper-large-v3");
    expect((calls[0]?.init.body as FormData).get("model")).toBe("whisper-large-v3");
  });

  it("maps HTTP errors to fixed codes without leaking the key or body", async () => {
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({ ok: false, status: 401 })),
    });
    const outcome = await port.transcribe({ bytes: new Uint8Array([1]), mime: "audio/ogg" }).then(
      () => { throw new Error("expected throw"); },
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(GroqTranscriptionError);
    expect((outcome as GroqTranscriptionError).code).toBe("HTTP_4XX");
    const message = outcome instanceof Error ? outcome.message : String(outcome);
    expect(message).not.toContain(FIXTURE_KEY);
  });

  it("never reads the error body: HTTP 500 with a transcript-like body still yields only the code", async () => {
    const fakeTranscript = "transcript-like body text that must never surface";
    let bodyRead = false;
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({
        ok: false,
        status: 500,
        text: async () => {
          bodyRead = true;
          return fakeTranscript;
        },
      })),
    });
    const outcome = await port.transcribe({ bytes: new Uint8Array([1]), mime: "audio/ogg" }).then(
      () => { throw new Error("expected throw"); },
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(GroqTranscriptionError);
    expect((outcome as GroqTranscriptionError).code).toBe("HTTP_5XX");
    const message = outcome instanceof Error ? outcome.message : String(outcome);
    expect(message).not.toContain(fakeTranscript);
    expect(message).not.toContain(FIXTURE_KEY);
    expect(bodyRead).toBe(false);
  });

  it("maps an unreadable payload to PARSE and empty text to EMPTY", async () => {
    const parsePort = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("unexpected token");
        },
      })),
    });
    await expect(parsePort.transcribe({ bytes: new Uint8Array([1]), mime: "audio/ogg" })).rejects.toMatchObject({
      name: "GroqTranscriptionError",
      code: "PARSE",
    });
    const emptyPort = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => okResponse("   ")),
    });
    await expect(emptyPort.transcribe({ bytes: new Uint8Array([1]), mime: "audio/ogg" })).rejects.toMatchObject({
      name: "GroqTranscriptionError",
      code: "EMPTY",
    });
  });

  it("refuses empty byte input before any fetch", async () => {
    let calls = 0;
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      fetchImpl: stubFetch(() => {
        calls += 1;
        return okResponse("oi");
      }),
    });
    await expect(port.transcribe({ bytes: new Uint8Array([]), mime: "audio/ogg" })).rejects.toThrow(/no bytes/);
    expect(calls).toBe(0);
  });

  it("times out a hanging request (120s default, overridable)", async () => {
    const port = new GroqTranscriptionAdapter({
      apiKey: FIXTURE_KEY,
      timeoutMs: 20,
      fetchImpl: stubFetch((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })),
    });
    await expect(port.transcribe({ bytes: new Uint8Array([1]), mime: "audio/ogg" })).rejects.toMatchObject({
      name: "GroqTranscriptionError",
      code: "TIMEOUT",
    });
  });
});

describe("groq env wiring", () => {
  it("treats absent/blank GROQ_API_KEY as not configured (skip, keep PENDING)", () => {
    expect(groqApiKeyFromEnv({})).toBeNull();
    expect(groqApiKeyFromEnv({ GROQ_API_KEY: "" })).toBeNull();
    expect(groqApiKeyFromEnv({ GROQ_API_KEY: "   " })).toBeNull();
    expect(groqTranscriptionPortFromEnv({})).toBeNull();
    expect(groqTranscriptionPortFromEnv({ GROQ_API_KEY: "" })).toBeNull();
  });

  it("builds the port when the key is present", () => {
    const port = groqTranscriptionPortFromEnv({ GROQ_API_KEY: FIXTURE_KEY });
    expect(port).not.toBeNull();
    expect(port?.name).toBe("groq-stt");
  });

  it("defaults the model, honors a non-blank override", () => {
    expect(groqSttModelFromEnv({})).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(groqSttModelFromEnv({ GROQ_STT_MODEL: "" })).toBe(GROQ_STT_DEFAULT_MODEL);
    expect(groqSttModelFromEnv({ GROQ_STT_MODEL: "whisper-large-v3" })).toBe("whisper-large-v3");
  });
});

describe("transcript row model (pure, append-only)", () => {
  let rowCounter = 0;

  const FRESH = new Date();
  const STALE = new Date(Date.now() - 60 * 60 * 1000);

  function row(overrides: Partial<TranscriptRow> & { status: string }): TranscriptRow {
    rowCounter += 1;
    return {
      id: `row-${String(rowCounter).padStart(4, "0")}`,
      attempt: 1,
      transcript: null,
      created_at: new Date(FRESH),
      ...overrides,
    };
  }

  it("latest row wins by created_at, id breaks ties deterministically", () => {
    const older = row({ id: "row-a", status: TRANSCRIPTION_STATUS_CLAIMED, created_at: new Date("2026-10-21T10:00:00Z") });
    const newer = row({ id: "row-b", status: TRANSCRIPTION_STATUS_FAILED, created_at: new Date("2026-10-21T10:01:00Z") });
    expect(latestTranscriptRow([older, newer])?.id).toBe("row-b");
    expect(latestTranscriptRow([newer, older])?.id).toBe("row-b");
    expect(latestTranscriptRow([])).toBeNull();
    const tieA = row({ id: "row-a", status: TRANSCRIPTION_STATUS_FAILED, created_at: new Date("2026-10-21T10:00:00Z") });
    const tieB = row({ id: "row-b", status: TRANSCRIPTION_STATUS_FAILED, created_at: new Date("2026-10-21T10:00:00Z") });
    expect(latestTranscriptRow([tieA, tieB])?.id).toBe("row-b");
  });

  it("next attempt is prior CLAIMED count + 1", () => {
    expect(nextTranscriptAttempt([])).toBe(1);
    expect(
      nextTranscriptAttempt([
        row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 1 }),
        row({ status: TRANSCRIPTION_STATUS_FAILED, attempt: 1 }),
      ]),
    ).toBe(2);
  });

  it("claims fresh messages at attempt 1", () => {
    expect(transcriptEligibility([])).toEqual({ eligible: true, attempt: 1 });
  });

  it("never re-claims in-flight CLAIMED rows", () => {
    expect(transcriptEligibility([row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 2 })])).toEqual({
      eligible: false,
      reason: "in_flight",
    });
  });

  it("re-claims STALE orphaned claims at the next attempt number", () => {
    const history = [
      row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 1, created_at: new Date(STALE) }),
    ];
    expect(transcriptEligibility(history)).toEqual({ eligible: true, attempt: 2 });
  });

  it("caps stale re-claims at the attempt budget (terminal)", () => {
    const history: TranscriptRow[] = [];
    for (let attempt = 1; attempt <= TRANSCRIPTION_MAX_ATTEMPTS; attempt += 1) {
      history.push(row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt, created_at: new Date(STALE) }));
    }
    expect(transcriptEligibility(history)).toEqual({ eligible: false, reason: "terminal" });
  });

  it("never re-claims TRANSCRIBED messages", () => {
    const history = [
      row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 1 }),
      row({ status: TRANSCRIPTION_STATUS_TRANSCRIBED, attempt: 1, transcript: "oi" }),
    ];
    expect(transcriptEligibility(history)).toEqual({ eligible: false, reason: "transcribed" });
  });

  it("retries FAILED below the budget with the next cycle number", () => {
    const history = [
      row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 1 }),
      row({ status: TRANSCRIPTION_STATUS_FAILED, attempt: 1 }),
    ];
    expect(transcriptEligibility(history)).toEqual({ eligible: true, attempt: 2 });
  });

  it(`goes terminal at FAILED with attempt ${TRANSCRIPTION_MAX_ATTEMPTS}`, () => {
    const history: TranscriptRow[] = [];
    for (let attempt = 1; attempt <= TRANSCRIPTION_MAX_ATTEMPTS; attempt += 1) {
      history.push(row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt }));
      history.push(row({ status: TRANSCRIPTION_STATUS_FAILED, attempt }));
    }
    expect(transcriptEligibility(history)).toEqual({ eligible: false, reason: "terminal" });
  });

  it("exposes transcript text only for latest TRANSCRIBED rows", () => {
    expect(transcribedTextOf([])).toBeNull();
    expect(transcribedTextOf([row({ status: TRANSCRIPTION_STATUS_CLAIMED, attempt: 1 })])).toBeNull();
    expect(
      transcribedTextOf([row({ status: TRANSCRIPTION_STATUS_TRANSCRIBED, attempt: 1, transcript: "  " })]),
    ).toBeNull();
    expect(
      transcribedTextOf([row({ status: TRANSCRIPTION_STATUS_TRANSCRIBED, attempt: 1, transcript: "oi, tudo bem?" })]),
    ).toBe("oi, tudo bem?");
  });
});
