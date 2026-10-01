/**
 * Shared read-operation helpers (no browser I/O here).
 *
 * `ensureProfileDir`, `extractIdentityField` and `identityEquals` live
 * here so both the legacy `readIdentity` probe and the V2 command runner
 * use the same implementation without a module cycle.
 */

import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { platform } from "node:os";

/** Extract a comparable identity string from `/api/auth/me` JSON, if present. */
export function extractIdentityField(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["email", "username", "login", "user"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)["email"];
      if (typeof nested === "string" && nested.length > 0) return nested;
    }
  }
  return null;
}

/** Timing-safe string equality (length-mismatch safe). */
export function identityEquals(expected: string, observed: string | null): boolean {
  if (observed === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(observed, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Ensure the profile root + dir exist with `0700`. `mkdir(mode)` only
 * applies on creation, so on POSIX an EXISTING dir is re-chmodded to
 * `0700` explicitly. Throws on failure (caller fails closed).
 */
export async function ensureProfileDir(profileRoot: string, profileDir: string): Promise<void> {
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") {
    // On Windows isolation relies on the %LOCALAPPDATA% container ACLs.
    const fix = async (path: string): Promise<void> => {
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o700) await chmod(path, 0o700);
    };
    await fix(profileRoot);
    await fix(profileDir);
  }
}
