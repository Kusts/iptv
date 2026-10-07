import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = join(here, "..", "Dockerfile");

describe("outbox-worker container default", () => {
  it("defaults to the long-running loop via CMD run", () => {
    const text = readFileSync(DOCKERFILE, "utf8");
    expect(text).toContain('ENTRYPOINT ["node", "apps/outbox-worker/dist/cli.js"]');
    expect(text).toContain('CMD ["run"]');
    expect(text).not.toContain('CMD ["--help"]');
  });

  it("parses explicit subcommands without container magic", () => {
    expect(parseArgs(["check"])).toMatchObject({ subcommand: "check", once: false, help: false });
    expect(parseArgs(["run", "--once"])).toMatchObject({ subcommand: "run", once: true, help: false });
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
  });

  it("keeps bare invocation invalid (default-run comes from CMD, not the parser)", () => {
    expect(() => parseArgs([])).toThrow();
  });
});
