/**
 * CLI entry — `browser-worker` (V2 semantic read-only CLI).
 *
 * One subcommand per certified read capability (see
 * `CINEVISION_READ_COMMANDS`): `read-identity`, `read-credit-balance`,
 * `list-customers`, `read-customer --id X`, `read-customer-status --id X`,
 * `read-connections --id X`, `list-servers`, `read-server-status`,
 * `list-package-prices`, `read-live-connections --server-id X`,
 * `list-integrations`. Pagination via `--page N`/`--per-page M` where
 * accepted. No write commands exist; no path/URL/method/selector flags
 * exist — args are numeric ids/pagination only, validated fail-closed.
 * Any unknown `--*` flag or unexpected value fails closed WITHOUT
 * echoing the raw value, and any DOM-selection attempt fails closed
 * with `DOM_NOT_CERTIFIED` (DOM reads are not certified).
 *
 * stdout/stderr: one compact JSON envelope (see `output.ts`). Exit 0 on
 * READ_CONFIRMED, 2 on HUMAN_REQUIRED/INCONCLUSIVE operational results,
 * 1 on invalid invocation.
 */

import { ConfigError, isWorkerEnabled, resolveWorkerConfig } from "./config.js";
import {
  CINEVISION_READ_COMMANDS,
  FIXED_OPERATION,
  type CinevisionOperation,
  type CinevisionSubcommand,
} from "./constants.js";
import { PlaywrightBrowser } from "./browser.js";
import { formatResult, newResult, withExecutionMetadata } from "./output.js";
import {
  runCinevisionCommand,
  type CommandArgs,
} from "./operations/cinevisionCommand.js";
import { buildWorkerSecretsPort } from "./secrets.js";

/** DOM-selection attempts fail closed with an explicit code (never run). */
export class DomRequestError extends Error {
  constructor() {
    super("browser-worker cli: DOM strategy not certified (API_IN_BROWSER only)");
    this.name = "DomRequestError";
  }
}

/** Flags that select DOM (uncertified strategy) — never accepted. */
const DOM_FLAGS = ["--selector", "--dom", "--xpath", "--css", "--strategy"] as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ParsedCommand {
  help: boolean;
  subcommand: CinevisionSubcommand;
  operation: CinevisionOperation;
  args: CommandArgs;
}

function usage(): string {
  const commands = CINEVISION_READ_COMMANDS.map((c) => c.subcommand).join(", ");
  return `usage: browser-worker <command> [args] [--help]\ncommands: ${commands}\nargs: --id X, --server-id X, --page N, --per-page M (only where the command accepts them)`;
}

function failClosed(detail: string): never {
  // Fixed words only — never echo argv values (LOW finding: untrusted
  // argv must not be reproduced on stdout/stderr).
  throw new ConfigError(detail);
}

function parsePositiveInt(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim().length === 0) failClosed(`missing ${name} (fixed inputs only)`);
  const n = Number((raw as string).trim());
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    failClosed(`invalid ${name} (fixed inputs only)`);
  }
  return n;
}

function parseId(raw: string | undefined, name: string): string {
  if (raw === undefined || raw.trim().length === 0) failClosed(`missing ${name} (fixed inputs only)`);
  const value = (raw as string).trim();
  if (!ID_RE.test(value)) failClosed(`invalid ${name} (fixed inputs only)`);
  return value;
}

/** Resolve a CLI token (kebab subcommand or dotted operation) to a command. */
function resolveCommandToken(token: string): (typeof CINEVISION_READ_COMMANDS)[number] | null {
  for (const entry of CINEVISION_READ_COMMANDS) {
    if (token === entry.subcommand || token === entry.operation) return entry;
  }
  return null;
}

function parseArgs(argv: string[]): ParsedCommand {
  for (const arg of argv) {
    if ((DOM_FLAGS as readonly string[]).includes(arg)) throw new DomRequestError();
    if (arg.startsWith("--strategy=") || arg.startsWith("--selector=")) throw new DomRequestError();
  }
  const positional: string[] = [];
  const flags = new Map<string, string | null>();
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") return defaultCommand(true);
    if (arg === "--operation") {
      const value = argv[i + 1];
      if (value === undefined) failClosed("unsupported operation (fixed inputs only)");
      const entry = resolveCommandToken(value);
      if (entry === null) failClosed("unsupported operation (fixed inputs only)");
      positional.push(entry.subcommand);
      i += 2;
      continue;
    }
    if (arg.startsWith("--operation=")) {
      const entry = resolveCommandToken(arg.slice("--operation=".length));
      if (entry === null) failClosed("unsupported operation (fixed inputs only)");
      positional.push(entry.subcommand);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const value = argv[i + 1];
        flags.set(arg.slice(2), value !== undefined && !value.startsWith("--") ? value : null);
        if (value !== undefined && !value.startsWith("--")) i += 1;
      }
      i += 1;
      continue;
    }
    positional.push(arg);
    i += 1;
  }

  // Legacy forms: bare `browser-worker` and bare dotted operation.
  // A flag without a subcommand is NOT a legacy invocation — fail closed.
  if (positional.length === 0) {
    if (flags.size > 0) failClosed("unsupported flag (fixed inputs only)");
    return defaultCommand(false);
  }
  if (positional.length !== 1) failClosed("unsupported operation (fixed inputs only)");
  const entry = resolveCommandToken(positional[0] as string);
  if (entry === null) failClosed("unsupported operation (fixed inputs only)");

  const wantsId = (entry as { id?: boolean }).id === true;
  const wantsServerId = (entry as { serverId?: boolean }).serverId === true;
  const wantsPagination = (entry as { pagination?: boolean }).pagination === true;
  const args: CommandArgs = {};
  const consumed = new Set<string>();
  if (wantsId) {
    const raw = flags.get("id");
    if (raw === undefined) failClosed("missing --id (fixed inputs only)");
    args.id = parseId(raw ?? undefined, "--id");
    consumed.add("id");
  }
  if (wantsServerId) {
    const raw = flags.get("server-id");
    if (raw === undefined) failClosed("missing --server-id (fixed inputs only)");
    args.serverId = parseId(raw ?? undefined, "--server-id");
    consumed.add("server-id");
  }
  if (wantsPagination) {
    if (flags.has("page")) {
      args.page = parsePositiveInt(flags.get("page") ?? undefined, "--page");
      consumed.add("page");
    }
    if (flags.has("per-page")) {
      args.perPage = parsePositiveInt(flags.get("per-page") ?? undefined, "--per-page");
      consumed.add("per-page");
    }
  }
  // Any other flag is rejected fail-closed (no paths/URLs/methods).
  for (const key of flags.keys()) {
    if (!consumed.has(key)) failClosed("unsupported flag (fixed inputs only)");
  }
  return { help: false, subcommand: entry.subcommand, operation: entry.operation, args };
}

function defaultCommand(help: boolean): ParsedCommand {
  const entry = CINEVISION_READ_COMMANDS[0] as (typeof CINEVISION_READ_COMMANDS)[number];
  return { help, subcommand: entry.subcommand, operation: entry.operation, args: {} };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
  } catch (err) {
    if (err instanceof DomRequestError) {
      process.stderr.write(
        `${formatResult(
          withExecutionMetadata(
            newResult(process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown", {
              status: "HUMAN_REQUIRED",
              identityMatched: false,
              readbackMatched: false,
              needsHuman: true,
              errorCode: "DOM_NOT_CERTIFIED",
            }),
            "cinevision.readIdentity",
            false,
          ),
        )}\n`,
      );
      process.exitCode = 2;
      return;
    }
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
        withExecutionMetadata(
          newResult(tenant, {
            status: "HUMAN_REQUIRED",
            identityMatched: false,
            readbackMatched: false,
            needsHuman: true,
            errorCode: "DISABLED",
          }),
          parsed.operation,
          false,
        ),
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
        withExecutionMetadata(
          newResult(process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown", {
            status: "HUMAN_REQUIRED",
            identityMatched: false,
            readbackMatched: false,
            needsHuman: true,
            errorCode: "INVALID_CONFIG",
          }),
          parsed.operation,
          false,
        ),
      )}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const secrets = buildWorkerSecretsPort(config);
  const browser = new PlaywrightBrowser(config);
  const result = await runCinevisionCommand(config, { secrets, browser }, parsed.operation, parsed.args);
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
        withExecutionMetadata(
          newResult(process.env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"] ?? "unknown", {
            status: "INCONCLUSIVE",
            identityMatched: false,
            readbackMatched: false,
            needsHuman: false,
            errorCode: "TRANSPORT",
          }),
          "cinevision.readIdentity",
          false,
        ),
      )}\n`,
    );
    process.exitCode = 2;
  });
}

export { parseArgs, usage };
export { FIXED_OPERATION };
