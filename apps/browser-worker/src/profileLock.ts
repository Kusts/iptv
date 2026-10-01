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
 * Stale recovery (F1): the lock file records the owner PID. When
 * acquisition collides, the existing PID is read; when it parses as a
 * live PID the collision fails closed, but when the PID is demonstrably
 * dead (`process.kill(pid, 0)` → ESRCH) the stale file is unlinked and
 * acquisition is retried once — so a holder that died (or a previous
 * execution that deliberately HELD the lock fail-closed because a
 * canceled launch was still pending) does not wedge the profile
 * forever. Unparseable content or an alive/undeterminable PID fails
 * closed. PID reuse is fail-closed by construction (a reused PID looks
 * alive, so the second holder collides instead of stealing).
 *
 * Notes:
 * - On Windows, profile isolation additionally relies on the
 *   `%LOCALAPPDATA%` user-container ACLs (see `config.ts`); the lock only
 *   serializes same-user concurrency, it is not a sandbox.
 * - A crashed holder used to require manual removal; stale PID recovery
 *   now handles the demonstrably-dead case, otherwise the operator
 *   removes the file after confirming no worker is running (README).
 */

import { open, readFile, unlink } from "node:fs/promises";
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

/** True when `pid` belongs to a live process (fail-closed on EPERM/unknown). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // EPERM: process exists but we may not signal it — treat as alive.
    if (code === "EPERM") return true;
    // ESRCH: no such process — demonstrably dead. Any other shape is
    // fail-closed (assume alive so we collide instead of stealing).
    if (code === "ESRCH") return false;
    return true;
  }
}

/** Read the owner PID recorded in an existing lock file, if parseable. */
async function readOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const first = raw.split("\n", 1)[0]?.trim() ?? "";
    if (!/^[1-9][0-9]{0,9}$/.test(first)) return null;
    const pid = Number(first);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/** Acquire the exclusive lock. Throws `ProfileLockError` on collision. */
export async function acquireProfileLock(profileDir: string): Promise<ProfileLock> {
  const lockPath = lockPathFor(profileDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch {
      // Collision: steal ONLY a demonstrably-stale (dead-owner) lock,
      // otherwise fail closed so two executions never share a profile.
      const owner = await readOwnerPid(lockPath);
      if (owner !== null && !isPidAlive(owner)) {
        try {
          await unlink(lockPath);
        } catch {
          throw new ProfileLockError();
        }
        continue;
      }
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
  throw new ProfileLockError();
}
