/**
 * CLI entry — `browser-worker`.
 *
 * Fixed inputs only: the operation is always `cinevision.readIdentity` and
 * identity comes from `BROWSER_WORKER_TENANT_ID` /
 * `BROWSER_WORKER_PROVIDER_ACCOUNT_ID`. No URL, ref, selector or script
 * flags exist; any unknown `--*` flag fails closed.
 *
 * stdout/stderr: one compact JSON envelope (see `output.ts`). Exit 0 on
 * READ_CONFIRMED, 2 on HUMAN_REQUIRED/INCONCLUSIVE config-transport
 * outcomes handled as operational results, 1 on invalid invocation.
 */

import { ConfigError, isWorkerEnabled, resolveWorkerConfig } from "./config.js";
import { FIXED_OPERATION } from "./constants.js";
import { PlaywrightBrowser } from "./browser.js";
import { formatResult, newResult } from "./output.js";
import { runReadIdentity } from "./operations/readIdentity.js";
import { buildWorkerSecretsPort } from "./secrets.js";

function usage(): string {
  return `usage: browser-worker [--operation cinevision.readIdentity] [--help]`;
}

function parseArgs(argv: string[]): { help: boolean } {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--operation") continue;
    if (arg === FIXED_OPERATION) continue;
    // Fixed inputs only: unknown flags/operations fail closed with a FIXED
    // code word. The raw argument value is NEVER echoed (LOW finding:
    // untrusted argv must not be reproduced on stderr).
    if (arg.startsWith("--")) {
      throw new ConfigError("unsupported flag (fixed inputs only)");
    }
    throw new ConfigError(`unsupported operation (only ${FIXED_OPERATION})`);
  }
  // `--operation <value>` pair form.
  const at = argv.indexOf("--operation");
  if (at !== -1) {
    const value = argv[at + 1];
    if (value !== FIXED_OPERATION) {
      throw new ConfigError(`unsupported operation (only ${FIXED_OPERATION})`);
    }
  }
  return { help: false };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid invocation";
    process.stderr.write(`${JSON.stringify({ error: "INVALID_CONFIG", detail: message })}\n`);
    process.exitCode = 1;
    return;
  }

  if (!isWorkerEnabled(process.env)) {
    // Fail closed WITHOUT launching a browser. Emit the sanitized envelope.
    const tenant = process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown";
    process.stderr.write(
      `${formatResult(
        newResult(tenant, {
          status: "HUMAN_REQUIRED",
          identityMatched: false,
          readbackMatched: false,
          needsHuman: true,
          errorCode: "DISABLED",
        }),
      )}\n`,
    );
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = resolveWorkerConfig(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid config";
    void message;
    process.stderr.write(
      `${formatResult(
        newResult(process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown", {
          status: "HUMAN_REQUIRED",
          identityMatched: false,
          readbackMatched: false,
          needsHuman: true,
          errorCode: "INVALID_CONFIG",
        }),
      )}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const secrets = buildWorkerSecretsPort(config);
  const browser = new PlaywrightBrowser(config);
  const result = await runReadIdentity(config, { secrets, browser });
  const line = `${formatResult(result)}\n`;
  if (result.status === "READ_CONFIRMED") {
    process.stdout.write(line);
    return;
  }
  process.stderr.write(line);
  process.exitCode = 2;
}

// Only auto-run as a CLI entry point (importable without side effects).
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write(
      `${formatResult(
        newResult(process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown", {
          status: "INCONCLUSIVE",
          identityMatched: false,
          readbackMatched: false,
          needsHuman: false,
          errorCode: "TRANSPORT",
        }),
      )}\n`,
    );
    process.exitCode = 2;
  });
}

export { parseArgs, usage };
