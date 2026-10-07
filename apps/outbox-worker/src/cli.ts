/**
 * CLI entry — `outbox-worker`.
 *
 * Subcommands:
 *   `check`      boot rehearsal with ZERO claims: config → connect →
 *                roleGuard → activation gate. Exit 0 ready, 2 not-ready,
 *                1 invalid invocation.
 *   `run [--once]` claim→publish→complete/fail loop (`--once` runs a single
 *                batch — staging smoke). SIGTERM/SIGINT drains gracefully.
 *
 * stdout/stderr: one compact JSON status line. Exit 0 on ok, 2 on not-ready
 * operational results, 1 on invalid invocation. Values are never echoed
 * (no URLs, tokens, ids, or argv fragments in output or errors).
 */

import { ActivationError, checkActivationGate } from "./activation.js";
import { ConfigError, isOutboxWorkerEnabled, resolveOutboxWorkerConfig } from "./config.js";
import type { OutboxWorkerConfig } from "./config.js";
import { closePool, createOutboxWorkerPool } from "./db.js";
import { assertOutboxWorkerIdentity } from "./roleGuard.js";
import { PgOutboxRpc } from "./rpc.js";
import { LocalTransport } from "./transport.js";
import { OutboxWorker } from "./worker.js";

type Subcommand = "check" | "run";

interface ParsedArgs {
  help: boolean;
  subcommand: Subcommand | null;
  once: boolean;
}

function usage(): string {
  return "usage: outbox-worker <check|run [--once]> [--help]";
}

function failClosed(detail: string): never {
  // Fixed words only — never echo argv values.
  throw new ConfigError(detail);
}

export function parseArgs(argv: string[]): ParsedArgs {
  let help = false;
  let subcommand: Subcommand | null = null;
  let once = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "check" || arg === "run") {
      if (subcommand !== null) failClosed("a single subcommand is required");
      subcommand = arg;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    failClosed("unsupported argument");
  }
  if (help) return { help: true, subcommand, once };
  if (subcommand === null) failClosed("a single subcommand is required");
  if (once && subcommand !== "run") failClosed("unsupported argument");
  return { help: false, subcommand, once };
}

function statusLine(payload: Record<string, string | number | boolean | string[]>): string {
  return JSON.stringify(payload);
}

function notReady(code: string): void {
  process.stderr.write(`${statusLine({ status: "not-ready", code })}\n`);
  process.exitCode = 2;
}

interface ActivationEnv {
  legacyQuiesced: boolean;
  legacyDrainEnabled: boolean | null;
  legacyInFlight: number | null;
}

/** Read the activation-gate inputs from env (quiescence comes from config). */
function readActivationEnv(env: NodeJS.ProcessEnv): ActivationEnv {
  const drainRaw = (env["OUTBOX_LEGACY_DRAIN_ENABLED"] ?? "").trim();
  let legacyDrainEnabled: boolean | null = null;
  if (drainRaw === "1") legacyDrainEnabled = true;
  else if (drainRaw === "0") legacyDrainEnabled = false;
  else if (drainRaw !== "") {
    throw new ConfigError("OUTBOX_LEGACY_DRAIN_ENABLED must be 1, 0, or unset");
  }
  const inFlightRaw = (env["OUTBOX_LEGACY_IN_FLIGHT"] ?? "").trim();
  let legacyInFlight: number | null = null;
  if (inFlightRaw !== "") {
    const n = Number(inFlightRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new ConfigError("OUTBOX_LEGACY_IN_FLIGHT must be a non-negative integer or unset");
    }
    legacyInFlight = n;
  }
  return {
    legacyQuiesced: (env["OUTBOX_LEGACY_QUIESCED"] ?? "") === "1",
    legacyDrainEnabled,
    legacyInFlight,
  };
}

/** Shared boot path: config → connect → roleGuard → activation. Zero claims. */
async function boot(env: NodeJS.ProcessEnv): Promise<OutboxWorkerConfig> {
  if (!isOutboxWorkerEnabled(env)) {
    throw new ConfigError("DISABLED (OUTBOX_WORKER_ENABLED must be 1)");
  }
  const config = resolveOutboxWorkerConfig(env);
  const pool = createOutboxWorkerPool(config.databaseUrl);
  try {
    await pool.query("SELECT 1");
    await assertOutboxWorkerIdentity((sql, params) =>
      pool.query(sql, params as unknown[] | undefined).then((res) => ({ rows: res.rows })),
    );
  } finally {
    await closePool(pool);
  }
  const activation = readActivationEnv(env);
  checkActivationGate(activation);
  return config;
}

async function runCheck(): Promise<void> {
  let config: OutboxWorkerConfig;
  try {
    config = await boot(process.env);
  } catch (err) {
    if (err instanceof ActivationError) {
      notReady(err.code);
      return;
    }
    notReady(err instanceof ConfigError ? "INVALID_CONFIG" : "BOOT_FAILED");
    return;
  }
  process.stdout.write(
    `${statusLine({ status: "ready", worker: config.workerId, checks: ["config", "connect", "role", "activation"] })}\n`,
  );
}

async function runWorker(once: boolean): Promise<void> {
  let config: OutboxWorkerConfig;
  try {
    config = await boot(process.env);
  } catch (err) {
    if (err instanceof ActivationError) {
      notReady(err.code);
      return;
    }
    notReady(err instanceof ConfigError ? "INVALID_CONFIG" : "BOOT_FAILED");
    return;
  }
  const pool = createOutboxWorkerPool(config.databaseUrl, config.maxConcurrency + 2);
  const rpc = new PgOutboxRpc((sql, params) =>
    pool.query(sql, params as unknown[] | undefined).then((res) => ({ rows: res.rows })),
  );
  const transport = new LocalTransport();
  const worker = new OutboxWorker({ config, rpc, transport });
  const shutdown = (): void => {
    void worker.stop().finally(() => closePool(pool).catch(() => undefined));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    if (once) {
      const outcome = await worker.runOnce();
      process.stdout.write(`${statusLine({ status: "ok", ...outcome })}\n`);
      return;
    }
    await worker.start();
    process.stdout.write(`${statusLine({ status: "ok", stopped: true })}\n`);
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    await closePool(pool).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch {
    process.stderr.write(`${statusLine({ error: "INVALID_INVOCATION" })}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help || parsed.subcommand === null) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.subcommand === "check") {
    await runCheck();
    return;
  }
  await runWorker(parsed.once);
}

// Only auto-run as a CLI entry point (importable without side effects).
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // Fixed codes only — never print err.message (pg errors can carry the
    // host/query). ConfigError means a fixed-words message, but the code
    // alone is enough for triage here; details stay in `check` output.
    const code = err instanceof ConfigError ? "INVALID_CONFIG" : "TRANSPORT";
    process.stderr.write(`${statusLine({ status: "not-ready", code })}\n`);
    process.exitCode = 2;
  });
}

export { usage };
