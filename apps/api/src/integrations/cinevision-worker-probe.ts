import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * S4A CINEVISION live validate (Issue #88, etapas 1-2):
 * `integration.test` (cinevision) resolves the tenant binding + secrets
 * from the vault and spawns the browser-worker CLI for a real read-only
 * validation (identity + servers). NADA de write; nenhum bypass de
 * challenge/CAPTCHA/2FA — qualquer bloqueio vira HUMAN_REQUIRED.
 *
 * Fail-closed shape:
 * - fixed read-only command allowlist (`read-identity`, `list-servers`);
 *   anything else is never spawned;
 * - per-invocation child env carries ONLY the necessary vars (deployment
 *   worker config + the tenant's `CINEVISION_EMAIL`/`CINEVISION_PASSWORD`
 *   for this invocation) — parent `INFISICAL_*`/tenant secrets never leak
 *   in; values are NEVER logged (this module has no logger);
 * - tenant/account-isolated profile root: `hash(tenantId)` under the base
 *   (raw ids never appear in the path; the worker appends its own
 *   `hash(tenant,account)` leaf, so concurrent tenants never share a
 *   session);
 * - bounded spawn timeout with SIGKILL + awaited close (no orphan;
 *   `detached: false` so no process group is left behind);
 * - origin allowlist stays fixed on the worker side
 *   (`CINEVISION_ALLOWED_ORIGIN`) — the API never passes URLs, so there is
 *   no SSRF surface: the panel URL comes from the worker's own vault ref;
 * - every outcome maps to `CONNECTED_READ_ONLY` or `TESTING` + a sanitized
 *   code — never an empty 500. The human instruction for each code lives
 *   in `CINEVISION_MANUAL_GUIDANCE` (pt-BR, docs + web reuse).
 */

// ---------------------------------------------------------------------------
// Fixed probe surface (never caller-supplied).
// ---------------------------------------------------------------------------

/** Read-only worker subcommands the probe may spawn. Fixed by contract. */
export const CINEVISION_PROBE_COMMANDS = ["read-identity", "list-servers"] as const;

export type CinevisionProbeCommand = (typeof CINEVISION_PROBE_COMMANDS)[number];

/** Total probe budget for BOTH reads (`CINEVISION_WORKER_TIMEOUT_MS`). */
export const CINEVISION_WORKER_TIMEOUT_MS_DEFAULT = 120_000;
export const CINEVISION_WORKER_TIMEOUT_MS_MIN = 10_000;
export const CINEVISION_WORKER_TIMEOUT_MS_MAX = 300_000;

/** Cap on captured child output (one JSON line is expected; no dumps). */
export const WORKER_OUTPUT_CAP = 1_000_000;

/** Parent env keys the child inherits (config only; never tenant secrets). */
const PASSTHROUGH_ENV_KEYS = [
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  "XDG_STATE_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "PLAYWRIGHT_BROWSERS_PATH",
  "BROWSER_WORKER_ENABLED",
  "BROWSER_WORKER_PROVIDER",
  "BROWSER_WORKER_HEADLESS",
  "BROWSER_WORKER_CHANNEL",
  "BROWSER_WORKER_CHALLENGE_WAIT_SECONDS",
  "BROWSER_WORKER_COMMAND_TIMEOUT_MS",
  "BROWSER_WORKER_LAUNCH_SETTLE_MS",
  "CINEVISION_ALLOWED_ORIGIN",
  "CINEVISION_LOGIN_PATH",
  "BROWSER_INFISICAL_SITE_URL",
  "BROWSER_INFISICAL_PROJECT_ID",
  "BROWSER_INFISICAL_CLIENT_ID",
  "BROWSER_INFISICAL_CLIENT_SECRET",
] as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Errors → sanitized codes + manual guidance.
// ---------------------------------------------------------------------------

export type CinevisionProbeCode =
  | "INVALID_CREDENTIALS"
  | "CHALLENGE_DETECTED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE";

export type CinevisionProbeOutcome = { ok: true } | { ok: false; code: CinevisionProbeCode };

/**
 * Manual instruction per code (pt-BR). The `test` response carries only the
 * code; this map is the operator/runbook-facing instruction the UI and docs
 * render for it. HUMAN_REQUIRED nunca é resolvido por bypass.
 */
export const CINEVISION_MANUAL_GUIDANCE: Record<CinevisionProbeCode, string> = {
  INVALID_CREDENTIALS:
    "Credencial rejeitada pelo painel CINEVISION. Confira usuário/senha no painel e reconfigure a integração (Conectar novamente); depois repita o teste.",
  CHALLENGE_DETECTED:
    "O painel exigiu verificação humana (challenge/CAPTCHA/2FA/Cloudflare). Conclua o acesso manualmente no painel CINEVISION e repita o teste — sem bypass.",
  TIMEOUT:
    "A leitura excedeu o tempo limite. Tente novamente; se persistir, verifique se o painel CINEVISION está acessível (inclusive bloqueios Cloudflare).",
  PROVIDER_UNAVAILABLE:
    "Não foi possível concluir a leitura no provedor. Aguarde e tente novamente; se persistir, acione o operador da plataforma.",
};

// ---------------------------------------------------------------------------
// Timeout parsing (bounded, fail-closed defaults).
// ---------------------------------------------------------------------------

export function parseWorkerTimeoutMs(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value.length === 0) return CINEVISION_WORKER_TIMEOUT_MS_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n)) return CINEVISION_WORKER_TIMEOUT_MS_DEFAULT;
  return Math.min(
    CINEVISION_WORKER_TIMEOUT_MS_MAX,
    Math.max(CINEVISION_WORKER_TIMEOUT_MS_MIN, n),
  );
}

// ---------------------------------------------------------------------------
// Child env (per tenant/account; secrets by invocation only).
// ---------------------------------------------------------------------------

export interface CinevisionProbeInput {
  tenantId: string;
  providerAccountId: string;
  username: string;
  password: string;
}

function sha32(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * Tenant-scoped profile root: `<base>/t-<sha256(tenantId)>`. Raw ids never
 * appear in the path. The worker appends its own `p-<sha256(tenant,account)>`
 * leaf, so profiles are isolated per (tenant, account) even under one base.
 */
export function cinevisionProfileRoot(base: string, tenantId: string): string {
  if (!isAbsolute(base)) {
    throw new Error("cinevision worker profile base must be an absolute path");
  }
  return join(resolve(base), `t-${sha32(tenantId)}`);
}

export function workerProfileBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env["CINEVISION_WORKER_PROFILE_BASE"] ?? "").trim();
  if (raw.length > 0) return raw;
  return join(tmpdir(), "iptv-cinevision-profiles");
}

/**
 * Build the restricted child env. ONLY the documented keys pass through
 * from the parent (deployment worker config + OS basics like
 * `LOCALAPPDATA` that profile resolution requires); the tenant credential
 * travels ONLY via `CINEVISION_EMAIL`/`CINEVISION_PASSWORD` for this
 * invocation. Parent `INFISICAL_*` (API vault identity) and any other
 * secret-bearing vars are never inherited.
 */
export function buildCinevisionWorkerEnv(
  input: CinevisionProbeInput,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!ID_RE.test(input.tenantId) || !ID_RE.test(input.providerAccountId)) {
    throw new Error("cinevision probe: invalid tenant/account identity");
  }
  if (input.username.trim().length === 0 || input.password.length === 0) {
    throw new Error("cinevision probe: empty credential");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env["BROWSER_WORKER_ENABLED"] = "1";
  env["BROWSER_WORKER_PROVIDER"] = "CINEVISION";
  env["BROWSER_WORKER_TENANT_ID"] = input.tenantId;
  env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] = input.providerAccountId;
  env["BROWSER_WORKER_PROFILE_ROOT"] = cinevisionProfileRoot(
    workerProfileBase(parent),
    input.tenantId,
  );
  env["CINEVISION_EMAIL"] = input.username;
  env["CINEVISION_PASSWORD"] = input.password;
  return env;
}

// ---------------------------------------------------------------------------
// Worker envelope parsing (sanitized; never throws secret material).
// ---------------------------------------------------------------------------

interface WorkerEnvelope {
  status?: unknown;
  errorCode?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse one worker invocation output. The envelope is stdout on exit 0 and
 * stderr otherwise (CLI contract); the last non-empty line wins. Anything
 * unparseable or off-contract maps to PROVIDER_UNAVAILABLE — never throws,
 * never echoes the raw output (it could carry panel PII in a bug).
 */
export function parseWorkerEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): { status: string; errorCode: string } | null {
  const text = exitCode === 0 ? stdout : stderr.length > 0 ? stderr : stdout;
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const envelope = parsed as WorkerEnvelope;
    if (typeof envelope["status"] !== "string" || typeof envelope["errorCode"] !== "string") {
      continue;
    }
    return { status: envelope["status"], errorCode: envelope["errorCode"] };
  }
  return null;
}

/**
 * Map one worker envelope to a probe outcome. Both commands must confirm
 * for CONNECTED_READ_ONLY; the caller combines them.
 */
export function mapWorkerOutcome(
  envelope: { status: string; errorCode: string } | null,
  timedOut: boolean,
): CinevisionProbeOutcome {
  if (timedOut) {
    return { ok: false, code: "TIMEOUT" };
  }
  if (envelope === null) {
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
  if (envelope.status === "READ_CONFIRMED") {
    return { ok: true };
  }
  if (envelope.status === "HUMAN_REQUIRED") {
    switch (envelope.errorCode) {
      case "IDENTITY_MISMATCH":
      case "SESSION_EXPIRED":
      case "SECRET_UNAVAILABLE":
        return { ok: false, code: "INVALID_CREDENTIALS" };
      case "CHALLENGE_DETECTED":
        return { ok: false, code: "CHALLENGE_DETECTED" };
      default:
        return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }
  }
  // INCONCLUSIVE: the worker hit its own command budget without an answer
  // (TRANSPORT) → TIMEOUT; anything else is provider-side noise.
  if (envelope.status === "INCONCLUSIVE" && envelope.errorCode === "TRANSPORT") {
    return { ok: false, code: "TIMEOUT" };
  }
  return { ok: false, code: "PROVIDER_UNAVAILABLE" };
}

// ---------------------------------------------------------------------------
// Spawn (bounded; SIGKILL + awaited close; no orphan).
// ---------------------------------------------------------------------------

export interface WorkerSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn one worker read with a hard timeout. On expiry the child is
 * SIGKILLed and the close is awaited (bounded grace) — the process never
 * outlives the call, and `detached: false` keeps it in this process group
 * (no orphan). Output is capped; spawn errors resolve (never throw) so the
 * caller always maps to a sanitized code.
 */
export function runWorkerCommand(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<WorkerSpawnResult> {
  const { argv, env, timeoutMs } = options;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: WorkerSpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(process.execPath, argv, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch {
      done({ stdout: "", stderr: "", exitCode: null, timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone — the close handler below resolves.
      }
      // Bounded grace: if the child ignores SIGKILL, resolve anyway after
      // 5s (the process group stays attached; the OS reaps it on exit).
      setTimeout(() => {
        done({ stdout, stderr, exitCode: null, timedOut });
      }, 5000).unref?.();
    }, Math.max(1, timeoutMs));
    // `timeout` option intentionally unused: the manual timer above owns
    // the kill so SIGKILL (not SIGTERM) is guaranteed on every platform.
    void timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < WORKER_OUTPUT_CAP) {
        stdout += chunk.toString("utf8").slice(0, WORKER_OUTPUT_CAP - stdout.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < WORKER_OUTPUT_CAP) {
        stderr += chunk.toString("utf8").slice(0, WORKER_OUTPUT_CAP - stderr.length);
      }
    });
    child.on("error", () => {
      done({ stdout, stderr, exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      done({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI resolution (deployment-owned; never caller-supplied).
// ---------------------------------------------------------------------------

/**
 * Resolve the worker CLI entry (`browser-worker/dist/cli.js`). Explicit
 * `CINEVISION_WORKER_CLI` (absolute) wins; otherwise probe the conventional
 * layouts (API running from `apps/api` or repo-root tooling). Missing CLI
 * throws — the handler maps it to TESTING + PROVIDER_UNAVAILABLE (never a
 * 500). The CLI path is deployment config, never request data (no SSRF).
 */
export function resolveWorkerCli(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env["CINEVISION_WORKER_CLI"] ?? "").trim();
  if (explicit.length > 0) {
    if (!isAbsolute(explicit)) {
      throw new Error("cinevision worker CLI must be an absolute path");
    }
    return explicit;
  }
  const candidates = [
    resolve(process.cwd(), "..", "browser-worker", "dist", "cli.js"),
    resolve(process.cwd(), "apps", "browser-worker", "dist", "cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("cinevision worker CLI is not available (set CINEVISION_WORKER_CLI)");
}

// ---------------------------------------------------------------------------
// Probe runner (injectable; the test double replaces the spawn).
// ---------------------------------------------------------------------------

export interface CinevisionWorkerRunner {
  runProbe(input: CinevisionProbeInput): Promise<CinevisionProbeOutcome>;
}

/**
 * Real runner: `read-identity` (auth gate) then `list-servers` (second
 * certified read). BOTH must confirm for `ok`. The total budget splits
 * across the two spawns so the probe never exceeds ~timeoutMs + grace.
 * No writes exist on this path — only the fixed read allowlist is spawned.
 */
export class SpawnCinevisionWorkerRunner implements CinevisionWorkerRunner {
  private readonly timeoutMs: number;
  private readonly cliPath: string;

  constructor(options: { timeoutMs?: number; cliPath?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    this.timeoutMs =
      options.timeoutMs ?? parseWorkerTimeoutMs(env["CINEVISION_WORKER_TIMEOUT_MS"]);
    this.cliPath = options.cliPath ?? resolveWorkerCli(env);
  }

  async runProbe(input: CinevisionProbeInput): Promise<CinevisionProbeOutcome> {
    let env: NodeJS.ProcessEnv;
    try {
      env = buildCinevisionWorkerEnv(input);
    } catch {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }
    const perCommandMs = Math.max(
      CINEVISION_WORKER_TIMEOUT_MS_MIN,
      Math.ceil(this.timeoutMs / CINEVISION_PROBE_COMMANDS.length),
    );
    for (const command of CINEVISION_PROBE_COMMANDS) {
      let result: WorkerSpawnResult;
      try {
        result = await runWorkerCommand({
          argv: [this.cliPath, command],
          env,
          timeoutMs: perCommandMs,
        });
      } catch {
        return { ok: false, code: "PROVIDER_UNAVAILABLE" };
      }
      const outcome = mapWorkerOutcome(
        parseWorkerEnvelope(result.stdout, result.stderr, result.exitCode),
        result.timedOut,
      );
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  }
}
