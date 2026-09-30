/**
 * Per-profile exclusive lock (atomic, fail-closed).
 *
 * The profile dir is keyed by `sha256(tenantId + NUL + providerAccountId)`
 * but concurrent CLI runs for the SAME binding would otherwise share one
 * Chromium persistent profile. `acquireProfileLock` creates a sidecar
 * `<profileDir>.lock` file with `O_CREAT|O_EXCL` (`"wx"`), which the OS
 * guarantees atomically: the second concurrent holder gets
 * `ProfileLockError(PROFILE_LOCKED)` and fails closed without launching
 * a browser. The holder keeps the file handle open and removes the file
 * on `release()` (always called in a `finally`).
 *
 * Notes:
 * - On Windows, profile isolation additionally relies on the
 *   `%LOCALAPPDATA%` user-container ACLs (see `config.ts`); the lock only
 *   serializes same-user concurrency, it is not a sandbox.
 * - A crashed holder can leave a stale `.lock` file behind; the operator
 *   removes it after confirming no worker is running. This is documented
 *   in the package README.
 */

import { open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export class ProfileLockError extends Error {
  constructor(detail: string = "PROFILE_LOCKED") {
    super(`browser-worker profile lock: ${detail}`);
    this.name = "ProfileLockError";
  }
}

export interface ProfileLock {
  release(): Promise<void>;
}

export function lockPathFor(profileDir: string): string {
  return `${profileDir}.lock`;
}

/** Acquire the exclusive lock. Throws `ProfileLockError` on collision. */
export async function acquireProfileLock(profileDir: string): Promise<ProfileLock> {
  const lockPath = lockPathFor(profileDir);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ProfileLockError();
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } catch {
    // PID note is best-effort; the exclusivity is what matters.
  }
  let released = false;
  return {
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        await handle.close();
      } catch {
        // ignore
      }
      try {
        await unlink(lockPath);
      } catch {
        // ignore
      }
    },
  };
}
