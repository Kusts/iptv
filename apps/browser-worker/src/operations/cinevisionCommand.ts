/**
 * V2 semantic read-only command runner (`cinevision-browser-v2`).
 *
 * One certified read per invocation: session acquisition is reused from
 * the `readIdentity` probe (login + bounded challenge wait + token
 * in-page), then a single Fase-1 reader runs through the SAME
 * self-contained `fetchProjectedInPage` closure `fetchCapability` uses
 * (imported, never duplicated). The adapter below fail-closes on any
 * other in-page function (`{ kind: "denied" }` without touching storage).
 *
 * Rules: GET-only capabilities, no writes, no new endpoints, no
 * configurable paths/URLs/methods (CLI args are numeric ids/pagination
 * only, validated before dispatch). On a classified `SESSION_EXPIRED`
 * (401) the runner performs AT MOST ONE bounded reauthentication and
 * retries the read once (SPEC §20); the envelope records whether a
 * reauth happened. The session token never leaves the page. A total
 * per-command budget (`BROWSER_WORKER_COMMAND_TIMEOUT_MS`, default 60s)
 * fails closed with INCONCLUSIVE/TRANSPORT — no unbounded execution.
 */

import { assertSecretUrlAllowed, type WorkerConfig } from "../config.js";
import type { CinevisionOperation, WorkerErrorCode, WorkerStatus } from "../constants.js";
import {
  newResult,
  withExecutionMetadata,
  type WorkerEvidence,
  type WorkerResult,
} from "../output.js";
import { normalizeLoginPath } from "../policy.js";
import { acquireProfileLock, ProfileLockError } from "../profileLock.js";
import { SubmitAbortedError } from "../browser.js";
import type { BrowserOpenOptions } from "./readIdentity.js";
import { CredentialError, resolveCredentials } from "../secrets.js";
import {
  fetchProjectedInPage,
  type CinevisionInPage,
  type InPageRequest,
  type InPageResult,
} from "../providers/cinevision/api-client.js";
import type {
  CinevisionErrorCode,
  CinevisionReaderError,
  ReaderResult,
} from "../providers/cinevision/errors.js";
import {
  listCustomers,
  listIntegrations,
  listPackagePrices,
  listServers,
  readConnections,
  readCreditBalance,
  readCustomer,
  readCustomerStatus,
  readIdentity,
  readLiveConnections,
  readServerStatus,
  type ListArgs,
  type ReaderDeps,
} from "../providers/cinevision/readers.js";
import type { IdentityResult } from "../providers/cinevision/schemas.js";
import type { SecretsPort } from "@iptv/secrets";
import { ensureProfileDir, identityEquals } from "./shared.js";
import type { ReadIdentityPage } from "./readIdentity.js";

/** Page surface a V2 command needs: session flow + capability reads. */
export interface CinevisionCommandPage extends ReadIdentityPage {
  /**
   * Run one capability read inside the page. Real impl delegates to
   * `page.evaluate(fetchProjectedInPage, req)` — the Fase-1 closure.
   */
  evaluateCapability(req: InPageRequest): Promise<InPageResult>;
  /**
   * Arm the single bounded reauth login POST window (policy F4).
   * Returns false when already armed/consumed — at most one reauth
   * POST per command lifetime.
   */
  armReauthWindow(): boolean;
}

export interface CinevisionCommandBrowser {
  open(
    profileDir: string,
    allowedOrigin: string,
    loginPath: string,
    opts?: BrowserOpenOptions,
  ): Promise<CinevisionCommandPage>;
}

export interface CinevisionCommandDeps {
  secrets: SecretsPort;
  browser: CinevisionCommandBrowser;
}

/** Narrow CLI args: numeric ids/pagination only, pre-validated by `cli.ts`. */
export interface CommandArgs {
  id?: string;
  serverId?: string;
  page?: number;
  perPage?: number;
}

interface Outcome {
  status: WorkerStatus;
  errorCode: WorkerErrorCode;
  identityMatched?: boolean;
  readbackMatched?: boolean;
  needsHuman?: boolean;
  data?: unknown;
  evidence?: WorkerEvidence;
}

function outcome(
  status: WorkerStatus,
  errorCode: WorkerErrorCode,
  extra: Omit<Outcome, "status" | "errorCode"> = {},
): Outcome {
  return { status, errorCode, ...extra };
}

function needsHumanFor(status: WorkerStatus, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return status === "HUMAN_REQUIRED";
}

/**
 * Fase-1 taxonomy → CLI envelope codes. Equivalent outcomes reuse the
 * legacy codes (CHALLENGE→CHALLENGE_DETECTED, AUTH_FAILED→IDENTITY_MISMATCH,
 * TRANSPORT→TRANSPORT); taxonomy members with no legacy equivalent keep
 * their own code (added to `constants.ts` in the same style).
 */
export function mapReaderError(error: CinevisionReaderError): {
  status: WorkerStatus;
  errorCode: WorkerErrorCode;
} {
  const code: CinevisionErrorCode = error.code;
  switch (code) {
    case "CHALLENGE":
      return { status: "HUMAN_REQUIRED", errorCode: "CHALLENGE_DETECTED" };
    case "AUTH_FAILED":
      return { status: "HUMAN_REQUIRED", errorCode: "IDENTITY_MISMATCH" };
    case "SESSION_EXPIRED":
      return { status: "HUMAN_REQUIRED", errorCode: "SESSION_EXPIRED" };
    case "PERMISSION_DENIED":
      return { status: "HUMAN_REQUIRED", errorCode: "PERMISSION_DENIED" };
    case "INTEGRATION_INACTIVE":
      return { status: "HUMAN_REQUIRED", errorCode: "INTEGRATION_INACTIVE" };
    case "RATE_LIMITED":
      return { status: "INCONCLUSIVE", errorCode: "RATE_LIMITED" };
    case "HTTP_FAILURE":
      return { status: "INCONCLUSIVE", errorCode: "HTTP_FAILURE" };
    case "BAD_RESPONSE":
      return { status: "INCONCLUSIVE", errorCode: "BAD_RESPONSE" };
    case "TRANSPORT":
    case "UNKNOWN_EFFECT":
      return { status: "INCONCLUSIVE", errorCode: "TRANSPORT" };
  }
}

function toWorkerEvidence(error: CinevisionReaderError): WorkerEvidence {
  return {
    status: error.evidence.status,
    path: error.evidence.path,
    durationMs: error.evidence.durationMs,
  };
}

/**
 * Fail-closed in-page adapter: only the Fase-1 `fetchProjectedInPage`
 * closure (by identity) reaches the real page. Anything else is denied
 * before storage is touched — the in-page gate then re-validates origin
 * and exact path itself (defense in depth). Exported for unit tests.
 */
export function toCinevisionInPage(page: CinevisionCommandPage): CinevisionInPage {
  return {
    evaluate: async (
      fn: (req: InPageRequest) => Promise<InPageResult>,
      req: InPageRequest,
    ): Promise<InPageResult> => {
      if (fn !== fetchProjectedInPage) return { kind: "denied" };
      return page.evaluateCapability(req);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Totally-budget abort: thrown at step boundaries once the command
 * budget expired so late-resolving work performs NO further steps
 * (no login, no reads) and unwinds to bounded cleanup. Never surfaced:
 * the caller already holds the timeout outcome.
 */
class CommandAbortedError extends Error {
  constructor() {
    super("browser-worker command: budget exceeded");
    this.name = "CommandAbortedError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CommandAbortedError();
}

/** Fresh abort read (no narrowing): safe at any step boundary. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Handles shared with the timeout owner so budget expiry can clean up. */
interface CommandHandles {
  page: { close(): Promise<void> } | null;
  lock: { release(): Promise<void> } | null;
  /**
   * F1 launch quiescence (settle of the pending launch + close of any
   * tardy context), registered by the browser synchronously during
   * `open`. Null for fake/test browsers that never launch. The lock is
   * never released while this is still pending: release waits for it
   * boundedly, and HOLDS the lock fail-closed when the bound expires
   * (stale-PID recovery in `profileLock.ts` frees it once this process
   * exits; same-process contenders keep colliding fail-closed).
   */
  pendingLaunch: Promise<void> | null;
}

/** Launch-quiescence bound for one command (configurable, default 3s). */
function launchSettleMsFor(config: WorkerConfig): number {
  const candidate = config.launchSettleMs;
  if (candidate === undefined) return 3000;
  if (!Number.isInteger(candidate)) return 3000;
  return Math.min(15_000, Math.max(500, candidate));
}

/**
 * Bounded quiescence wait (F1): true when the pending launch settled
 * (and any tardy context closed) within the bound. Null counts as
 * settled (nothing pending).
 */
async function awaitLaunchQuiescence(
  pending: Promise<void> | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (pending === null || pending === undefined) return true;
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([pending, sleep(timeoutMs)]);
  return settled;
}

/** Bounded close: never lets a wedged context outlive the budget. */
async function closeBounded(
  page: { close(): Promise<void> } | null,
  timeoutMs: number,
): Promise<void> {
  if (page === null) return;
  try {
    await Promise.race([page.close(), sleep(timeoutMs)]);
  } catch {
    // ignore
  }
}

interface SessionCredentials {
  panelUrl: string;
  email: string;
  password: string;
}

/**
 * Establish the session: navigate, bounded challenge wait, strict-unique
 * login submit only (same flow as the `readIdentity` probe). Never
 * bypasses challenges; ambiguous DOM refuses without clicking.
 */
async function establishSession(
  page: CinevisionCommandPage,
  credentials: SessionCredentials,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<Outcome | null> {
  throwIfAborted(signal);
  await page.goto(credentials.panelUrl);
  throwIfAborted(signal);
  const challengeDeadline = Date.now() + config.challengeWaitSeconds * 1000;
  while (await page.detectChallenge()) {
    throwIfAborted(signal);
    if (Date.now() >= challengeDeadline) {
      return outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED");
    }
    await sleep(2000);
  }
  throwIfAborted(signal);
  const form = await page.probeLoginForm();
  throwIfAborted(signal);
  if (form !== null) {
    const unique =
      form.forms === 1 &&
      form.emailInputs === 1 &&
      form.passwordInputs === 1 &&
      form.submitButtons === 1;
    if (!unique) {
      return outcome("HUMAN_REQUIRED", "AMBIGUOUS_LOGIN_FORM");
    }
    if (await page.detectChallenge()) {
      return outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED");
    }
    throwIfAborted(signal);
    const loggedIn = await page.submitLogin(credentials.email, credentials.password, signal);
    throwIfAborted(signal);
    if (!loggedIn) {
      return outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH");
    }
    if (await page.detectChallenge()) {
      return outcome("HUMAN_REQUIRED", "CHALLENGE_DETECTED");
    }
  }
  return null;
}

/**
 * Single bounded reauthentication after a classified 401: arm the ONE
 * policy reauth window, revisit the panel, submit only through the
 * strict-unique form, succeed or fail fast. Returns true when the
 * caller may retry the read exactly once.
 */
async function reauthenticateOnce(
  page: CinevisionCommandPage,
  credentials: SessionCredentials,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    page.armReauthWindow();
    throwIfAborted(signal);
    await page.goto(credentials.panelUrl);
    throwIfAborted(signal);
    if (await page.detectChallenge()) return false;
    const form = await page.probeLoginForm();
    throwIfAborted(signal);
    if (form === null) return true;
    const unique =
      form.forms === 1 &&
      form.emailInputs === 1 &&
      form.passwordInputs === 1 &&
      form.submitButtons === 1;
    if (!unique) return false;
    throwIfAborted(signal);
    return await page.submitLogin(credentials.email, credentials.password, signal);
  } catch (err) {
    if (err instanceof CommandAbortedError || err instanceof SubmitAbortedError) {
      throw new CommandAbortedError();
    }
    return false;
  }
}

/** Build reader pagination args without `undefined` values (exact-optional). */
function paginationArgs(args: CommandArgs): ListArgs {
  const out: ListArgs = {};
  if (args.page !== undefined) out.page = args.page;
  if (args.perPage !== undefined) out.perPage = args.perPage;
  return out;
}

/** Dispatch one certified read (closed capability set, GET only). */
function dispatchReader(
  deps: ReaderDeps,
  command: CinevisionOperation,
  args: CommandArgs,
): Promise<ReaderResult<unknown>> {
  switch (command) {
    case "cinevision.readIdentity":
      return readIdentity(deps);
    case "cinevision.readCreditBalance":
      return readCreditBalance(deps);
    case "cinevision.listCustomers":
      return listCustomers(deps, paginationArgs(args));
    case "cinevision.readCustomer":
      return readCustomer(deps, { customerId: args.id ?? "" });
    case "cinevision.readCustomerStatus":
      return readCustomerStatus(deps, { customerId: args.id ?? "" });
    case "cinevision.readConnections":
      return readConnections(deps, { customerId: args.id ?? "" });
    case "cinevision.listServers":
      return listServers(deps);
    case "cinevision.readServerStatus":
      return readServerStatus(deps);
    case "cinevision.listPackagePrices":
      return listPackagePrices(deps);
    case "cinevision.readLiveConnections":
      return readLiveConnections(deps, { serverId: args.serverId ?? "", ...paginationArgs(args) });
    case "cinevision.listIntegrations":
      return listIntegrations(deps);
  }
}

/**
 * `readIdentity` on the Fase-1 reader: one projected read, timing-safe
 * compare against the deployment credential (never emitted), then a
 * repeat read for readback. Returns the envelope outcome (no identity
 * PII in `data` — same compatibility contract as the legacy probe).
 */
async function runIdentityRead(
  deps: ReaderDeps,
  credentials: SessionCredentials,
  reauth: { retried: () => Promise<boolean> },
  signal?: AbortSignal,
): Promise<Outcome> {
  const attempt = async (): Promise<ReaderResult<IdentityResult>> => readIdentity(deps);
  throwIfAborted(signal);
  let first = await attempt();
  throwIfAborted(signal);
  if (!first.ok && first.error.code === "SESSION_EXPIRED") {
    if (await reauth.retried()) {
      throwIfAborted(signal);
      first = await attempt();
      throwIfAborted(signal);
    }
  }
  if (!first.ok) {
    const mapped = mapReaderError(first.error);
    return outcome(mapped.status, mapped.errorCode, { evidence: toWorkerEvidence(first.error) });
  }
  const observed = first.data.username ?? first.data.id;
  if (!identityEquals(credentials.email, observed)) {
    return outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH");
  }
  let second = await readIdentity(deps);
  throwIfAborted(signal);
  if (!second.ok && second.error.code === "SESSION_EXPIRED") {
    if (await reauth.retried()) {
      throwIfAborted(signal);
      second = await readIdentity(deps);
      throwIfAborted(signal);
    }
  }
  if (!second.ok) {
    const mapped = mapReaderError(second.error);
    return outcome(mapped.status, mapped.errorCode, { evidence: toWorkerEvidence(second.error) });
  }
  if (JSON.stringify(first.data) !== JSON.stringify(second.data)) {
    return outcome("INCONCLUSIVE", "READ_MISMATCH");
  }
  return outcome("READ_CONFIRMED", "NONE", {
    identityMatched: true,
    readbackMatched: true,
    needsHuman: false,
    evidence: {
      status: first.evidence.status,
      path: first.evidence.path,
      durationMs: first.evidence.durationMs,
    },
  });
}

/**
 * Session identity gate for non-identity commands (F3): read the cheap
 * identity snapshot through the same in-page path and compare it against
 * the configured credential (same rule as `readIdentity`:
 * `username ?? id` vs vault email). The identity payload is NEVER
 * emitted — only the boolean match gates the requested read. A 401
 * consumes the single bounded reauth exactly like a reader 401.
 * Returns the fail-closed outcome, or null when the session matches.
 */
async function verifySessionIdentity(
  deps: ReaderDeps,
  credentials: SessionCredentials,
  reauth: { retried: () => Promise<boolean> },
  signal?: AbortSignal,
): Promise<Outcome | null> {
  throwIfAborted(signal);
  let id = await readIdentity(deps);
  throwIfAborted(signal);
  if (!id.ok && id.error.code === "SESSION_EXPIRED") {
    if (await reauth.retried()) {
      throwIfAborted(signal);
      id = await readIdentity(deps);
      throwIfAborted(signal);
    }
  }
  if (!id.ok) {
    const mapped = mapReaderError(id.error);
    return outcome(mapped.status, mapped.errorCode, { evidence: toWorkerEvidence(id.error) });
  }
  const observed = id.data.username ?? id.data.id;
  if (!identityEquals(credentials.email, observed)) {
    return outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH");
  }
  return null;
}

/**
 * Re-verify identity after a post-read reauth WITHOUT consuming another
 * reauth: the single bounded reauth is already spent. Any failure or
 * mismatch fails closed BEFORE the retried read — no data from a
 * foreign session is ever attributed to the configured account.
 */
async function reverifyIdentityAfterReauth(
  deps: ReaderDeps,
  credentials: SessionCredentials,
  signal?: AbortSignal,
): Promise<Outcome | null> {
  throwIfAborted(signal);
  let id: ReaderResult<IdentityResult>;
  try {
    id = await readIdentity(deps);
  } catch {
    return outcome("INCONCLUSIVE", "TRANSPORT");
  }
  throwIfAborted(signal);
  if (!id.ok) {
    const mapped = mapReaderError(id.error);
    return outcome(mapped.status, mapped.errorCode, { evidence: toWorkerEvidence(id.error) });
  }
  const observed = id.data.username ?? id.data.id;
  if (!identityEquals(credentials.email, observed)) {
    return outcome("HUMAN_REQUIRED", "IDENTITY_MISMATCH");
  }
  return null;
}

async function runBounded(
  config: WorkerConfig,
  deps: CinevisionCommandDeps,
  command: CinevisionOperation,
  args: CommandArgs,
  state: { reauthenticated: boolean },
  signal?: AbortSignal,
  shared?: CommandHandles,
): Promise<WorkerResult> {
  const done = (o: Outcome): WorkerResult =>
    withExecutionMetadata(
      newResult(config.providerAccountId, {
        status: o.status,
        identityMatched: o.identityMatched ?? false,
        readbackMatched: o.readbackMatched ?? false,
        needsHuman: needsHumanFor(o.status, o.needsHuman),
        errorCode: o.errorCode,
        ...(o.data !== undefined ? { data: o.data } : {}),
        ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
      }),
      command,
      state.reauthenticated,
    );

  try {
    normalizeLoginPath(config.loginPath);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "CONFIG"));
  }

  let credentials: SessionCredentials;
  try {
    credentials = await resolveCredentials(deps.secrets);
  } catch (err) {
    void err;
    return done(outcome("HUMAN_REQUIRED", "SECRET_UNAVAILABLE"));
  }
  if (credentials.panelUrl.length === 0 || credentials.email.length === 0) {
    return done(outcome("HUMAN_REQUIRED", "SECRET_UNAVAILABLE"));
  }

  try {
    assertSecretUrlAllowed(credentials.panelUrl, config.allowedOrigin);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "ORIGIN_MISMATCH"));
  }

  try {
    await ensureProfileDir(config.profileRoot, config.profileDir);
  } catch {
    return done(outcome("HUMAN_REQUIRED", "TRANSPORT"));
  }

  let lock: { release(): Promise<void> } | null = null;
  try {
    throwIfAborted(signal);
    lock = await acquireProfileLock(config.profileDir);
    if (isAborted(signal)) {
      // Budget expired during acquisition: release immediately so a
      // late holder never pins the profile for the next execution.
      try {
        await lock.release();
      } catch {
        // ignore
      }
      throw new CommandAbortedError();
    }
    if (shared !== undefined) shared.lock = lock;
  } catch (err) {
    void err;
    if (err instanceof ProfileLockError) {
      return done(outcome("HUMAN_REQUIRED", "PROFILE_LOCKED"));
    }
    return done(outcome("HUMAN_REQUIRED", "TRANSPORT"));
  }

  let page: CinevisionCommandPage | null = null;
  try {
    throwIfAborted(signal);
    // Cancelable, ownership-safe acquisition: the browser exposes its
    // context to the shared registry AS SOON as it exists (so the
    // timeout owner can close it mid-setup), registers its F1 launch
    // quiescence synchronously (so the lock is never released while a
    // launch is still pending), and a late resolution after cleanup is
    // closed boundedly instead of being assigned — it never becomes
    // `shared.page`, never runs steps.
    let openSettled = false;
    let opened: CinevisionCommandPage | null = null;
    try {
      opened = await deps.browser.open(config.profileDir, config.allowedOrigin, config.loginPath, {
        signal,
        launchSettleMs: launchSettleMsFor(config),
        onPendingLaunch: (quiescence) => {
          if (shared !== undefined) shared.pendingLaunch ??= quiescence;
        },
        onContext: (closable) => {
          if (shared === undefined) return;
          if (openSettled || isAborted(signal)) {
            void closable.close().catch(() => undefined);
            return;
          }
          shared.page ??= closable;
        },
      });
    } finally {
      openSettled = true;
    }
    if (isAborted(signal) || opened === null) {
      await closeBounded(opened, 2000);
      throw new CommandAbortedError();
    }
    page = opened;
    if (shared !== undefined) shared.page = page;
    throwIfAborted(signal);
    const sessionFailed = await establishSession(page, credentials, config, signal);
    if (sessionFailed !== null) return done(sessionFailed);

    const inPage = toCinevisionInPage(page);
    const readerDeps: ReaderDeps = { page: inPage, allowedOrigin: config.allowedOrigin };
    const reauth = {
      retried: async (): Promise<boolean> => {
        if (state.reauthenticated) return false;
        state.reauthenticated = true;
        return reauthenticateOnce(page as CinevisionCommandPage, credentials, signal);
      },
    };

    if (command === "cinevision.readIdentity") {
      return done(await runIdentityRead(readerDeps, credentials, reauth, signal));
    }

    // F3: identity gate BEFORE the requested read — a profile holding
    // another account's session fails closed with no data.
    const identityFailed = await verifySessionIdentity(readerDeps, credentials, reauth, signal);
    if (identityFailed !== null) return done(identityFailed);

    throwIfAborted(signal);
    let result = await dispatchReader(readerDeps, command, args);
    throwIfAborted(signal);
    if (!result.ok && result.error.code === "SESSION_EXPIRED" && (await reauth.retried())) {
      throwIfAborted(signal);
      // The reauth may have landed on a different account: re-verify
      // BEFORE retrying the read.
      const reverified = await reverifyIdentityAfterReauth(readerDeps, credentials, signal);
      if (reverified !== null) return done(reverified);
      throwIfAborted(signal);
      result = await dispatchReader(readerDeps, command, args);
      throwIfAborted(signal);
    }
    if (!result.ok) {
      const mapped = mapReaderError(result.error);
      return done(
        outcome(mapped.status, mapped.errorCode, {
          evidence: toWorkerEvidence(result.error),
        }),
      );
    }
    return done(
      outcome("READ_CONFIRMED", "NONE", {
        identityMatched: true,
        readbackMatched: true,
        needsHuman: false,
        data: result.data,
        evidence: {
          status: result.evidence.status,
          path: result.evidence.path,
          durationMs: result.evidence.durationMs,
        },
      }),
    );
  } catch {
    return done(outcome("INCONCLUSIVE", "TRANSPORT"));
  } finally {
    // Bounded close: a wedged context never outlives cleanup. F1: the
    // profile lock is released ONLY after the pending launch settled
    // (and any tardy context closed); when the quiescence bound expires
    // the lock is HELD fail-closed (never announced as available while
    // Chromium may still be starting on the profile) — stale-PID
    // recovery frees it once this process exits. The TRANSPORT outcome
    // above is already decided, so holding never hides success.
    await closeBounded(page, 2000);
    const settled = await awaitLaunchQuiescence(shared?.pendingLaunch, launchSettleMsFor(config));
    if (settled) {
      try {
        await lock?.release();
      } catch {
        // ignore
      }
    }
    credentials = { panelUrl: "", email: "", password: "" };
  }
}

/**
 * Execute one certified read-only command within the total command
 * budget. Exceeding the budget fails closed (INCONCLUSIVE/TRANSPORT):
 * the budget abort stops the in-flight attempt at the next step
 * boundary (no further logins/reads), while the timeout owner performs
 * its own bounded close + lock release from the shared handles — so a
 * wedged `goto`/context cannot keep Chromium alive or the profile lock
 * held after the budget. No unbounded waits, no infinite loops.
 */
export async function runCinevisionCommand(
  config: WorkerConfig,
  deps: CinevisionCommandDeps,
  command: CinevisionOperation,
  args: CommandArgs = {},
): Promise<WorkerResult> {
  const state = { reauthenticated: false };
  const controller = new AbortController();
  const shared: CommandHandles = { page: null, lock: null, pendingLaunch: null };
  const timeoutResult = (): WorkerResult =>
    withExecutionMetadata(
      newResult(config.providerAccountId, {
        status: "INCONCLUSIVE",
        identityMatched: false,
        readbackMatched: false,
        needsHuman: false,
        errorCode: "TRANSPORT",
      }),
      command,
      state.reauthenticated,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = runBounded(config, deps, command, args, state, controller.signal, shared);
    const timeout = new Promise<WorkerResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(timeoutResult());
      }, config.commandTimeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (controller.signal.aborted) {
      // Budget won: bounded close + lock release only after launch
      // quiescence (F1). The attempt's own `finally` is idempotent, but
      // this owner must not free the profile while its launch is still
      // pending — when the bound expires the lock is HELD fail-closed
      // (stale-PID recovery frees it after process exit) and the
      // already-decided TRANSPORT outcome is returned.
      await closeBounded(shared.page, 2000);
      const settled = await awaitLaunchQuiescence(shared.pendingLaunch, launchSettleMsFor(config));
      if (settled) {
        try {
          await shared.lock?.release();
        } catch {
          // ignore
        }
      }
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export { CredentialError };
export { identityEquals };
