import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProfileLock, lockPathFor, ProfileLockError } from "../src/profileLock.js";

describe("profile lock", () => {
  it("grants the first holder and collides for the second", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bw-lock-")), "p-x");
    const first = await acquireProfileLock(dir);
    await expect(acquireProfileLock(dir)).rejects.toBeInstanceOf(ProfileLockError);
    await first.release();
    expect(existsSync(lockPathFor(dir))).toBe(false);
    // Re-acquirable after release.
    const second = await acquireProfileLock(dir);
    await second.release();
  });

  it("release is idempotent", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bw-lock-")), "p-y");
    const lock = await acquireProfileLock(dir);
    await lock.release();
    await lock.release();
  });
});
