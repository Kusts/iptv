import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords.js";

describe("password hashing", () => {
  it("hashes and verifies, rejecting wrong passwords", async () => {
    const hash = await hashPassword("correct-horse-8");
    expect(hash).not.toContain("correct-horse-8");
    expect(await verifyPassword("correct-horse-8", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("uses random salts", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
  });

  it("rejects short passwords and malformed stored hashes", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
    expect(await verifyPassword("anything-123", "not-a-hash")).toBe(false);
  });
});
