/**
 * Explicit path-semantics layer for profile-path validation.
 *
 * `node:path` picks win32 vs posix rules from the HOST OS, but profile-root
 * policy must validate a Windows deployment path (`C:/...`, `\\srv\share`)
 * identically on Windows, on Linux CI and in unit tests. This wraps the two
 * native tables behind an explicit PathApi and infers semantics from
 * unambiguous Windows markers; everything else uses the host default.
 *
 * Detection (fail-closed):
 * - /^[A-Za-z]:[\\/]/ (drive + separator) or /^\\\\/ (UNC) → "windows" on every host.
 * - Anything else → host default (win32 on win32, posix elsewhere). Rooted
 *   no-drive forms (`\tmp`) and drive-relative forms (`C:tmp`) stay on the
 *   host table and keep failing closed exactly as before.
 *
 * Consequence (deliberate): on a posix host, a windows-semantics path is
 * validated purely in the Windows namespace (shape, fs root, container
 * policy). Host-fs comparisons (repo checkout, home dir) only apply when
 * the semantics matches the host namespace, because `C:/...` can never
 * denote a location inside a posix checkout and vice versa.
 */
import { platform } from "node:os";
import * as nodePath from "node:path";

export type PathSemantics = "windows" | "posix";

export interface PathApi {
  readonly semantics: PathSemantics;
  isAbsolute(p: string): boolean;
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
  relative(from: string, to: string): string;
  parse(p: string): nodePath.ParsedPath;
}

/** Unambiguous Windows markers: drive + separator, or a UNC prefix. */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_RE = /^\\\\/;

/**
 * True when the string carries an unambiguous Windows marker, independent of
 * the host. Exposed so callers can read env vars (e.g. `LOCALAPPDATA`)
 * without inheriting the host default in their inference.
 */
export function hasWindowsPathMarker(candidate: string): boolean {
  return WINDOWS_DRIVE_RE.test(candidate) || WINDOWS_UNC_RE.test(candidate);
}

/** Namespace implied by the host OS: win32 on Windows, posix elsewhere. */
function hostSemantics(hostPlatform: NodeJS.Platform): PathSemantics {
  return hostPlatform === "win32" ? "windows" : "posix";
}

/**
 * Semantics for a candidate path: windows when it carries an unambiguous
 * Windows marker, otherwise the host default (fail-closed: rooted no-drive
 * and drive-relative forms keep the host table).
 */
export function detectPathSemantics(
  candidate: string,
  hostPlatform: NodeJS.Platform = platform(),
): PathSemantics {
  return hasWindowsPathMarker(candidate) ? "windows" : hostSemantics(hostPlatform);
}

/** Both native tables behind the explicit `PathApi` surface. */
export const PATH_APIS: Record<PathSemantics, PathApi> = {
  windows: {
    semantics: "windows",
    isAbsolute: (p: string) => nodePath.win32.isAbsolute(p),
    resolve: (...segments: string[]) => nodePath.win32.resolve(...segments),
    join: (...segments: string[]) => nodePath.win32.join(...segments),
    relative: (from: string, to: string) => nodePath.win32.relative(from, to),
    parse: (p: string) => nodePath.win32.parse(p),
  },
  posix: {
    semantics: "posix",
    isAbsolute: (p: string) => nodePath.posix.isAbsolute(p),
    resolve: (...segments: string[]) => nodePath.posix.resolve(...segments),
    join: (...segments: string[]) => nodePath.posix.join(...segments),
    relative: (from: string, to: string) => nodePath.posix.relative(from, to),
    parse: (p: string) => nodePath.posix.parse(p),
  },
};

/** The api bound to one namespace. */
export function pathApiFor(semantics: PathSemantics): PathApi {
  return PATH_APIS[semantics];
}

/** Sugar: detect the semantics of a path, then return its api. */
export function pathApiForPath(
  candidate: string,
  hostPlatform: NodeJS.Platform = platform(),
): PathApi {
  return pathApiFor(detectPathSemantics(candidate, hostPlatform));
}