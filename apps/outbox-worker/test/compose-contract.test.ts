import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(here, "..", "..", "..", "deploy", "staging", "docker-compose.staging.yml");

/** Slice the compose text from the outbox-worker service header to the next top-level service. */
function outboxWorkerBlock(text: string): string {
  const start = text.indexOf("  outbox-worker:");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const nextService = rest.slice("  outbox-worker:".length).search(new RegExp("\\n {2}[a-z][\\w-]*:"));
  return nextService === -1 ? rest : rest.slice(0, "  outbox-worker:".length + nextService);
}

describe("staging compose outbox-worker contract", () => {
  it("restarts the long-running loop and never forces --help", () => {
    const text = readFileSync(COMPOSE, "utf8");
    const block = outboxWorkerBlock(text);
    expect(block).toContain("restart: unless-stopped");
    expect(block).not.toMatch(/restart:\s*["']?no["']?/);
    // No command override: the image default (ENTRYPOINT cli.js + CMD run)
    // is the loop. An explicit `command:` forcing --help would park the
    // container on usage output instead of draining.
    expect(block).not.toMatch(/command:\s*\[.*--help.*\]/);
    expect(block).toContain('profiles: ["outbox"]');
    // SIGKILL grace must cover OUTBOX_WORKER_SHUTDOWN_TIMEOUT_MS (max 120s).
    expect(block).toMatch(/stop_grace_period:\s*130s/);
  });
});
