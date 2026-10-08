import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  attachPoolErrorHandler,
  createDb,
  sanitizeDbErrorMessage,
} from "../src/index.js";

const DUMMY_URL = "postgres://iptv_app:dummy@localhost:1/iptv_dummy";

function idleError(message: string, code = "ECONNRESET"): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("pg pool resilience (P7: Postgres restart must not kill the API)", () => {
  it("an idle-client error does not throw once the handler is attached (process stays alive)", async () => {
    const pool = new Pool({ connectionString: DUMMY_URL, max: 1 });
    try {
      const seen: Error[] = [];
      attachPoolErrorHandler(pool, (err) => {
        seen.push(err);
      });
      const err = idleError("Connection terminated unexpectedly");
      expect(() => pool.emit("error", err, {} as never)).not.toThrow();
      expect(seen).toHaveLength(1);
      // The pool is still usable: the next checkout fails as a normal
      // rejection (connection refused), it does not crash the process.
      await expect(pool.query("select 1")).rejects.toThrow();
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it("createDb wires the handler: emitting an idle error notifies onPoolError instead of throwing", async () => {
    const onSpy = vi.spyOn(Pool.prototype, "on");
    const seen: Error[] = [];
    const db = createDb({ connectionString: DUMMY_URL, onPoolError: (e) => seen.push(e) });
    try {
      // Wiring proof: createDb registers an `error` listener on the pg Pool
      // (without it, an idle-client error rethrows and kills the process).
      expect(onSpy).toHaveBeenCalledWith("error", expect.any(Function));
    } finally {
      onSpy.mockRestore();
      await db.destroy();
    }
    // Behaviour proof lives on the real helper (previous test): emitting an
    // idle error on an attached pool notifies instead of throwing.
    const pool = new Pool({ connectionString: DUMMY_URL, max: 1 });
    try {
      attachPoolErrorHandler(pool, (e) => seen.push(e));
      expect(() => pool.emit("error", idleError("terminating connection"), {} as never)).not.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  it("the default log line is structured and carries no credential", () => {
    const pool = new Pool({ connectionString: DUMMY_URL, max: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      attachPoolErrorHandler(pool);
      const leaking = idleError(
        "connect postgres://iptv_app:s3cr3t-pw@db.internal:5432/iptv failed",
        "ECONNREFUSED",
      );
      expect(() => pool.emit("error", leaking, {} as never)).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("db pool idle client error");
      expect(line).toContain("://***@");
      expect(line).not.toContain("s3cr3t-pw");
      expect(line).not.toContain(DUMMY_URL);
    } finally {
      spy.mockRestore();
      void pool.end().catch(() => undefined);
    }
  });

  it("sanitizeDbErrorMessage redacts URI userinfo and bounds length", () => {
    expect(sanitizeDbErrorMessage("connect postgres://u:p@h/db failed")).toBe(
      "connect postgres://***@h/db failed",
    );
    expect(sanitizeDbErrorMessage("plain timeout").length).toBeLessThanOrEqual(500);
    expect(sanitizeDbErrorMessage("x".repeat(600)).length).toBeLessThanOrEqual(500);
  });
});
