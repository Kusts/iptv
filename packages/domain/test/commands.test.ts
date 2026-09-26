import { describe, expect, it } from "vitest";
import {
  commandResultHttpStatus,
  idempotencyScopeOf,
  resultCode,
  type CommandResult,
} from "../src/commands.js";

describe("command primitives", () => {
  it("maps result codes to HTTP statuses without raw 500s", () => {
    const cases: Array<[CommandResult, number]> = [
      [{ ok: true, data: { id: 1 } }, 200],
      [{ ok: false, code: "validation_failed", message: "bad" }, 400],
      [{ ok: false, code: "forbidden", message: "no" }, 403],
      [{ ok: false, code: "not_found", message: "missing" }, 404],
      [{ ok: false, code: "precondition_failed", message: "stale" }, 409],
    ];
    for (const [result, status] of cases) {
      expect(commandResultHttpStatus(result)).toBe(status);
    }
    expect(resultCode({ ok: true, data: null })).toBe("ok");
    expect(resultCode({ ok: false, code: "not_found", message: "x" })).toBe("not_found");
  });

  it("defaults idempotency scope to the command name", () => {
    expect(idempotencyScopeOf({ name: "human_review.request", permission: "agent.review.request" })).toBe(
      "human_review.request",
    );
    expect(
      idempotencyScopeOf({ name: "human_review.request", permission: "agent.review.request", idempotencyScope: "hr" }),
    ).toBe("hr");
  });
});
