/**
 * Canonical CINEVISION readback error taxonomy (FASE 1, reads only).
 *
 * Cause and effect certainty are independent: a classified cause never
 * implies the provider-side effect. Reads have no side effects, so only
 * transport errors carry `effectCertainty: "UNKNOWN"` (post-send state
 * could not be observed); every other read error is effect-free.
 *
 * `AUTH_FAILED` and `UNKNOWN_EFFECT` belong to the login/write phases
 * and are reserved here for a single shared union — readers never emit
 * them. A 403/404 is NEVER called Cloudflare without observable
 * evidence in the body or headers (see `isChallengeBody`).
 */

export const CINEVISION_ERROR_CODES = [
  "CHALLENGE",
  "AUTH_FAILED",
  "SESSION_EXPIRED",
  "PERMISSION_DENIED",
  "INTEGRATION_INACTIVE",
  "RATE_LIMITED",
  "HTTP_FAILURE",
  "BAD_RESPONSE",
  "UNKNOWN_EFFECT",
  "TRANSPORT",
] as const;

export type CinevisionErrorCode = (typeof CINEVISION_ERROR_CODES)[number];

/** Schema validation state attached to sanitized read evidence. */
export type ReaderEvidenceSchema = "ok" | "BAD_RESPONSE" | "NOT_EVALUATED";

/**
 * Sanitized read evidence. No tokens, no PII beyond non-sensitive ids
 * already present in the relative `path`. `status` is null when no HTTP
 * response was observed (transport failure).
 */
export interface ReaderEvidence {
  status: number | null;
  contentType: string;
  path: string;
  durationMs: number;
  schema: ReaderEvidenceSchema;
}

export interface CinevisionReaderError {
  code: CinevisionErrorCode;
  /** Fixed words only — never echoes provider bodies or secrets. */
  detail: string;
  evidence: ReaderEvidence;
  /**
   * Reads never have effects, so this is set only on transport errors
   * (post-send state unobservable). Absent everywhere else.
   */
  effectCertainty?: "UNKNOWN";
}

export type ReaderResult<T> =
  | { ok: true; data: T; evidence: ReaderEvidence }
  | { ok: false; error: CinevisionReaderError };

/** Known interstitial titles (localized, lowercased match). */
const CHALLENGE_TITLES = [
  "just a moment",
  "just-a-moment",
  "um momento",
  "checking your browser",
  "attention required",
  "verify you are human",
  "verifique que",
] as const;

/** Script markers proving challenge-platform instrumentation. */
const CHALLENGE_SCRIPT_MARKERS = ["challenge-platform", "turnstile", "cf-challenge"] as const;

/**
 * Interstitial/form markers (must accompany a script for a challenge).
 * Intentionally disjoint from `CHALLENGE_SCRIPT_MARKERS`: a lone
 * `<script>` tag for any script family never satisfies both families.
 */
const INTERSTITIAL_MARKERS = [
  "cf-mitigated",
  "<form",
  "checking your browser",
  "verify you are human",
  "attention required",
] as const;

/** Structured challenge evidence computed in-page (never raw HTML). */
export interface HtmlChallengeSignals {
  title: string;
  hasChallengeScript: boolean;
  markers: string[];
}

/**
 * True when structured signals prove an interstitial: a known localized
 * title, or a challenge script plus interstitial/form markers. An
 * isolated challenge-platform script alone is NOT a challenge, and neither
 * is any script-family string sitting in `markers` (marker families are
 * disjoint from script families — only structural markers count).
 */
export function isChallengeSignals(signals: HtmlChallengeSignals): boolean {
  const title = signals.title.toLowerCase();
  if (CHALLENGE_TITLES.some((marker) => title.includes(marker))) return true;
  if (!signals.hasChallengeScript) return false;
  const structural = signals.markers.filter((marker) =>
    (INTERSTITIAL_MARKERS as readonly string[]).includes(marker),
  );
  return structural.length > 0;
}

/** True when `bodyText` carries structural challenge evidence (see above). */
export function isChallengeBody(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  // Challenge phrases count only inside a `<title>` tag — never in the
  // full body text (a lone script tag or stray words are not evidence).
  const titleMatch = lower.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  const titleText = titleMatch?.[1] ?? "";
  if (CHALLENGE_TITLES.some((marker) => titleText.includes(marker))) return true;
  // A script family counts only inside a real `<script>` block: the full
  // block (opening tag + content) is inspected so inline challenge code
  // is visible, while stray words without a script element are ignored.
  const fullBlocks = lower.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g) ?? [];
  const openTags = lower.match(/<script\b[^>]*>/g) ?? [];
  const hasScript =
    fullBlocks.some((block) =>
      CHALLENGE_SCRIPT_MARKERS.some((marker) => block.includes(marker)),
    ) ||
    openTags.some((tag) => CHALLENGE_SCRIPT_MARKERS.some((marker) => tag.includes(marker)));
  if (!hasScript) return false;
  // Structural markers must live OUTSIDE scripts: strip every script
  // block (and stray opening tags) before looking, and require a real
  // `<form>` opening tag — never a loose substring that could come from
  // a script attribute or JS string.
  const htmlNoScripts = lower
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/g, "")
    .replace(/<script\b[^>]*>/g, "");
  if (htmlNoScripts.includes("cf-mitigated")) return true;
  if (/<form[\s>/]/.test(htmlNoScripts)) return true;
  return (
    htmlNoScripts.includes("checking your browser") ||
    htmlNoScripts.includes("verify you are human") ||
    htmlNoScripts.includes("attention required")
  );
}

/** True when the content type is JSON (ignores charset suffix). */
export function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

export interface HttpFailureInput {
  status: number;
  contentType: string;
  /** Legacy raw text (prefer `html` signals; strict rule applies to both). */
  bodyText?: string;
  /** Structured in-page challenge evidence (never raw HTML). */
  html?: HtmlChallengeSignals | null;
}

/**
 * Classify a non-2xx HTTP response. Rules:
 * 401 -> SESSION_EXPIRED (in-page session expired);
 * 402 -> INTEGRATION_INACTIVE;
 * 403 with JSON body -> PERMISSION_DENIED;
 * 403 with HTML challenge evidence -> CHALLENGE;
 * 403 otherwise and any 404/5xx/unexpected -> HTTP_FAILURE;
 * 429 -> RATE_LIMITED.
 *
 * CHALLENGE needs structural interstitial evidence (known title, or
 * challenge script plus interstitial/form markers). An isolated
 * challenge-platform script is HTTP_FAILURE, never CHALLENGE.
 */
export function classifyHttpFailure(input: HttpFailureInput): CinevisionErrorCode {
  const { status, contentType } = input;
  if (status === 401) return "SESSION_EXPIRED";
  if (status === 402) return "INTEGRATION_INACTIVE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 403) {
    if (isJsonContentType(contentType)) return "PERMISSION_DENIED";
    if (input.html !== undefined && input.html !== null) {
      return isChallengeSignals(input.html) ? "CHALLENGE" : "HTTP_FAILURE";
    }
    if (typeof input.bodyText === "string" && isChallengeBody(input.bodyText)) {
      return "CHALLENGE";
    }
    return "HTTP_FAILURE";
  }
  return "HTTP_FAILURE";
}

/** Build a transport error (network abort/timeout/reset, pre-observation). */
export function transportError(path: string, durationMs: number): CinevisionReaderError {
  return {
    code: "TRANSPORT",
    detail: "network transport failed before observation",
    evidence: { status: null, contentType: "", path, durationMs, schema: "NOT_EVALUATED" },
    effectCertainty: "UNKNOWN",
  };
}

/** Build an HTTP/shape error with fixed words and sanitized evidence. */
export function httpError(
  code: CinevisionErrorCode,
  detail: string,
  evidence: ReaderEvidence,
): CinevisionReaderError {
  return { code, detail, evidence };
}
