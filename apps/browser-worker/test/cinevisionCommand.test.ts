import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { BINDING_PROVIDER, FIXED_SECRET_REFS } from "../src/constants.js";
import { formatResult } from "../src/output.js";
import { acquireProfileLock } from "../src/profileLock.js";
import {
  mapReaderError,
  runCinevisionCommand,
  toCinevisionInPage,
  type CinevisionCommandBrowser,
  type CinevisionCommandPage,
  type CommandArgs,
} from "../src/operations/cinevisionCommand.js";
import {
  armReauthWindow,
  consumeLoginPost,
  decideRoutedRequest,
  initialPolicyState,
} from "../src/policy.js";
import {
  fetchProjectedInPage,
  type InPageRequest,
  type InPageResult,
} from "../src/providers/cinevision/api-client.js";
import type { CinevisionOperation } from "../src/constants.js";
import type { SecretsPort } from "@iptv/secrets";

const ALLOWED = "https://panel.example.test";
const SECRET_URL = "https://panel.example.test/";
const EMAIL = "operator@example.test";
const TOKEN = "session-token-value";
const PASSWORD = "pw-never-emitted";

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const root = mkdtempSync(join(tmpdir(), "bw-cmd-"));
  return {
    provider: BINDING_PROVIDER,
    tenantId: "tenant-a",
    providerAccountId: "acct-1",
    allowedOrigin: ALLOWED,
    loginPath: "/api/auth/login",
    infisicalSiteUrl: "https://infisical.example.test",
    infisicalProjectId: "proj-1",
    infisicalClientId: "id-1",
    infisicalClientSecret: "secret-1",
    headless: true,
    challengeWaitSeconds: 0,
    commandTimeoutMs: 60_000,
    profileRoot: root,
    profileDir: join(root, "p-test"),
    ...overrides,
  };
}

function fakeSecrets(): SecretsPort {
  const values: Record<string, string> = {
    [FIXED_SECRET_REFS[0]]: SECRET_URL,
    [FIXED_SECRET_REFS[1]]: EMAIL,
    [FIXED_SECRET_REFS[2]]: "pw-123",
  };
  return {
    name: "fake",
    getSecret: async (ref: string) => {
      const value = values[ref];
      if (value === undefined) throw new Error("not found");
      return value;
    },
  };
}

interface Script {
  form: { forms: number; emailInputs: number; passwordInputs: number; submitButtons: number } | null;
  /** Forms served after a reauth navigation (defaults to `form`). */
  formAfterReauth?: { forms: number; emailInputs: number; passwordInputs: number; submitButtons: number } | null;
  challenge?: boolean;
  loginResult?: boolean;
  /** In-page outcomes served to `evaluateCapability`, in order. */
  reads: InPageResult[];
}

interface Calls {
  opened: number;
  submitted: number;
  evaluates: number;
  closed: number;
  gotos: number;
}

function okData(data: unknown): InPageResult {
  return { kind: "ok", status: 200, contentType: "application/json", data };
}

/** Identity snapshot matching the configured vault email (F3 gate passes). */
function identityBody(email: string = EMAIL): unknown {
  return { id: "u-1", username: email, credits: 2 };
}

/** Identity snapshot for a FOREIGN account (F3 gate must fail closed). */
function foreignIdentityBody(): unknown {
  return { id: "u-9", username: "someone-else@example.test", credits: 7 };
}

function httpData(status: number, contentType: string, data: unknown): InPageResult {
  return { kind: "ok", status, contentType, data };
}

function fakeBrowser(script: Script, calls: Calls): CinevisionCommandBrowser {
  let navigations = 0;
  // Real policy state: the fake enforces the SAME single-POST + single
  // bounded reauth window as production (F4) instead of ignoring it.
  const policy = initialPolicyState();
  const page: CinevisionCommandPage = {
    currentUrl: () => `${ALLOWED}/#/dashboard`,
    goto: async () => {
      calls.gotos += 1;
      navigations += 1;
    },
    probeLoginForm: async () => (navigations > 1 && script.formAfterReauth !== undefined
      ? script.formAfterReauth
      : script.form),
    detectChallenge: async () => script.challenge ?? false,
    submitLogin: async () => {
      const decision = decideRoutedRequest({
        method: "POST",
        url: `${ALLOWED}/api/auth/login`,
        allowedOrigin: ALLOWED,
        mainPageUrl: `${ALLOWED}/#/sign-in`,
        isMainFrame: true,
        loginWindowOpen: true,
        loginPath: "/api/auth/login",
        loginPostUsed: policy.loginPostUsed,
        reauthArmed: policy.reauthArmed,
        reauthLoginPostUsed: policy.reauthLoginPostUsed,
      });
      if (decision !== "allow-login-post") return false;
      consumeLoginPost(policy);
      calls.submitted += 1;
      return script.loginResult ?? true;
    },
    armReauthWindow: () => armReauthWindow(policy),
    fetchIdentity: async () => {
      throw new Error("not used");
    },
    evaluateCapability: async (req: InPageRequest): Promise<InPageResult> => {
      // Mirror the real wiring: execute the Fase-1 closure in a stubbed
      // page scope so projections/gates run for real in tests.
      const scope = globalThis as unknown as Record<string, unknown>;
      const prevFetch = scope["fetch"];
      const prevStorage = scope["localStorage"];
      const prevLocation = scope["location"];
      const queued = script.reads.shift();
      scope["localStorage"] = { getItem: (key: string) => (key === "token" ? TOKEN : null) };
      scope["location"] = { origin: ALLOWED };
      scope["fetch"] = (async () => {
        if (queued === undefined) throw new Error("no more reads");
        if (queued.kind !== "ok") return queued;
        return {
          status: queued.status,
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? queued.contentType : null) },
          text: async () => JSON.stringify(queued.data),
        };
      }) as unknown as typeof fetch;
      try {
        return await fetchProjectedInPage(req);
      } finally {
        scope["fetch"] = prevFetch;
        scope["localStorage"] = prevStorage;
        scope["location"] = prevLocation;
      }
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  return {
    open: async () => {
      calls.opened += 1;
      const inner = page.evaluateCapability.bind(page);
      page.evaluateCapability = async (req) => {
        calls.evaluates += 1;
        return inner(req);
      };
      return page;
    },
  };
}

function serversBody(): unknown {
  return { data: [{ id: "s-1", name: "srv-a", token: TOKEN, password: PASSWORD }] };
}

async function run(
  command: CinevisionOperation,
  args: CommandArgs,
  script: Script,
  calls: Calls,
  cfg: WorkerConfig = config(),
) {
  return runCinevisionCommand(cfg, { secrets: fakeSecrets(), browser: fakeBrowser(script, calls) }, command, args);
}

function newCalls(): Calls {
  return { opened: 0, submitted: 0, evaluates: 0, closed: 0, gotos: 0 };
}

/**
 * Real `setTimeout`, taken from `node:timers` and captured at module
 * scope BEFORE any test — or any vitest `setupFiles` — installs fake
 * timers. The budget tests below fake `setTimeout`, so this reference is
 * the only way to wait on the real clock while the fake clock is
 * installed; binding it here, once at import time, keeps the wait immune
 * to a later `vi.useFakeTimers()` in this module.
 */
const realSetTimeout: typeof nodeSetTimeout = nodeSetTimeout;

/**
 * Bounded real-clock wait for `predicate` (1ms polls on the real timer).
 * Used with fake timers: the command budget is armed before the
 * production code performs real async fs work (`ensureProfileDir` +
 * `acquireProfileLock`), so the attempt only reaches `browser.open` after
 * that work finishes. Polling the real clock lets it finish without the
 * test guessing a duration, resolves the instant the condition holds,
 * and yields `false` after the bound — a regressed contract then fails on
 * an explicit assertion instead of hanging the suite under fake timers.
 */
function untilReal(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const started = Date.now();
    const poll = (): void => {
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      realSetTimeout(poll, 1);
    };
    poll();
  });
}

describe("V2 wiring", () => {
  it("runs listServers through the Fase-1 closure with execution metadata", async () => {
    const calls = newCalls();
    const result = await run("cinevision.listServers", {}, {
      form: null,
      // F3 identity gate first, then the requested read.
      reads: [okData(identityBody()), okData(serversBody())],
    }, calls);
    expect(result.status).toBe("READ_CONFIRMED");
    expect(result.errorCode).toBe("NONE");
    expect(result.command).toBe("cinevision.listServers");
    expect(result.executionChannel).toBe("BROWSER");
    expect(result.strategy).toBe("API_IN_BROWSER");
    expect(result.adapterVersion).toBe("cinevision-browser-v2");
    expect(result.reauthenticated).toBe(false);
    expect(result.data).toEqual([{ id: "s-1", name: "srv-a" }]);
    expect(result.evidence?.path).toBe("/api/servers");
    expect(result.evidence?.status).toBe(200);
    // Exactly 2 in-page reads: identity gate + requested read.
    expect(calls.evaluates).toBe(2);
    expect(calls.closed).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("dispatches every certified command to its closed path", async () => {
    const cases: Array<{ command: CinevisionOperation; args: CommandArgs; body: unknown }> = [
      { command: "cinevision.readCreditBalance", args: {}, body: { id: "u-1", credits: 5 } },
      {
        command: "cinevision.listCustomers",
        args: { page: 1, perPage: 1 },
        body: {
          data: [
            {
              id: "cust-1", user_id: "u-1", server_id: "s-1", package_id: "p-1",
              status: "active", is_trial: "false", connections: 1,
              has_multiple_connections: false, expires_at: null, plan_price: 9,
            },
          ],
          meta: { current_page: 1, last_page: 1, per_page: 1, total: 1 },
        },
      },
      {
        command: "cinevision.readCustomer",
        args: { id: "cust-1" },
        body: {
          data: {
            id: "cust-1", user_id: "u-1", server_id: "s-1", package_id: "p-1",
            status: "active", is_trial: "false", connections: 1,
            has_multiple_connections: false, expires_at: null, plan_price: 9,
          },
        },
      },
      {
        command: "cinevision.readCustomerStatus",
        args: { id: "cust-1" },
        body: {
          data: {
            id: "cust-1", user_id: "u-1", server_id: "s-1", package_id: "p-1",
            status: "active", is_trial: "true", connections: 1,
            has_multiple_connections: false, expires_at: "2026-10-30T00:00:00Z", plan_price: 9,
          },
        },
      },
      {
        command: "cinevision.readConnections",
        args: { id: "cust-1" },
        body: {
          data: {
            id: "cust-1", user_id: "u-1", server_id: "s-1", package_id: "p-1",
            status: "active", is_trial: "false", connections: 2,
            has_multiple_connections: true, expires_at: null, plan_price: 9,
          },
        },
      },
      { command: "cinevision.readServerStatus", args: {}, body: { data: [{ name: "srv-a" }] } },
      {
        command: "cinevision.listPackagePrices",
        args: {},
        body: { data: [{ id: "p-1", plan_price: 9 }] },
      },
      {
        command: "cinevision.readLiveConnections",
        args: { serverId: "srv-1", page: 1, perPage: 1 },
        body: {
          data: [
            {
              id: "sess-1", user_username: "user-1", max_connections: 2,
              reseller_username: "op", stream_display_name: "stream",
              user_agent: "agent", date_start_timestamp: 1727745600,
            },
          ],
          meta: { current_page: 1, last_page: 1, per_page: 1, total: 1 },
        },
      },
      {
        command: "cinevision.listIntegrations",
        args: {},
        body: { data: [{ id: "reseller-api", is_active: true }] },
      },
    ];
    for (const c of cases) {
      const calls = newCalls();
      const result = await run(
        c.command,
        c.args,
        // F3 identity gate first, then the requested read.
        { form: null, reads: [okData(identityBody()), okData(c.body)] },
        calls,
      );
      expect(result.status, c.command).toBe("READ_CONFIRMED");
      expect(result.command, c.command).toBe(c.command);
      expect(result.reauthenticated, c.command).toBe(false);
      expect(result.data, c.command).toBeDefined();
      // Identity gate + requested read, never more.
      expect(calls.evaluates, c.command).toBe(2);
    }
  });

  it("denies any in-page function other than the Fase-1 closure (fail-closed)", async () => {
    let delegated = 0;
    const stub = {
      evaluateCapability: async (): Promise<InPageResult> => {
        delegated += 1;
        return { kind: "ok", status: 200, contentType: "application/json", data: {} };
      },
    } as unknown as CinevisionCommandPage;
    const inPage = toCinevisionInPage(stub);
    const req: InPageRequest = {
      allowedOrigin: ALLOWED,
      path: "/api/servers",
      expectedPath: "/api/servers",
      projection: { pick: ["id"] },
      timeoutMs: 1000,
    };
    // Foreign closure: denied before the page is touched.
    const denied = await inPage.evaluate(async () => ({ kind: "transport" }), req);
    expect(denied).toEqual({ kind: "denied" });
    expect(delegated).toBe(0);
    // The Fase-1 closure (by identity): delegated to the page.
    await inPage.evaluate(fetchProjectedInPage, req);
    expect(delegated).toBe(1);
  });
});

describe("session reauth (bounded, once, real policy)", () => {
  const expired = (): InPageResult => ({ kind: "ok", status: 401, contentType: "application/json", data: {} });
  const loginForm = {
    forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons: 1,
  };

  it("retries once after a single bounded reauth on 401 and records it", async () => {
    const calls = newCalls();
    const result = await run("cinevision.listServers", {}, {
      // Initial strict-unique login consumes the first POST slot.
      form: loginForm,
      formAfterReauth: loginForm,
      // F3 identity 401 → bounded reauth login → identity match → read.
      reads: [expired(), okData(identityBody()), okData(serversBody())],
    }, calls);
    expect(result.status).toBe("READ_CONFIRMED");
    expect(result.reauthenticated).toBe(true);
    // Initial login + exactly one reauth login, never more.
    expect(calls.submitted).toBe(2);
    // Exactly 3 in-page reads: identity, identity retry, requested read.
    expect(calls.evaluates).toBe(3);
    expect(calls.gotos).toBe(2);
    expect(result.command).toBe("cinevision.listServers");
  });

  it("fails closed after a second 401 without further retries", async () => {
    const calls = newCalls();
    const result = await run("cinevision.listServers", {}, {
      form: loginForm,
      formAfterReauth: loginForm,
      // Identity recovers via the single reauth, then the read 401s
      // again with no retry budget left.
      reads: [expired(), okData(identityBody()), expired()],
    }, calls);
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("SESSION_EXPIRED");
    expect(result.reauthenticated).toBe(true);
    // Exactly 3 in-page reads: identity, identity retry, one read attempt.
    expect(calls.evaluates).toBe(3);
    // Initial login + one reauth login — no third POST was attempted.
    expect(calls.submitted).toBe(2);
    expect(result.command).toBe("cinevision.listServers");
  });

  it("reauthenticates readIdentity once on 401 and confirms", async () => {
    const calls = newCalls();
    const result = await run("cinevision.readIdentity", {}, {
      form: null,
      formAfterReauth: loginForm,
      reads: [
        expired(),
        okData({ id: "u-1", username: EMAIL, credits: 2 }),
        okData({ id: "u-1", username: EMAIL, credits: 2 }),
      ],
    }, calls);
    expect(result.status).toBe("READ_CONFIRMED");
    expect(result.reauthenticated).toBe(true);
    expect(result.identityMatched).toBe(true);
    // First attempt + retry + readback confirmation, exactly.
    expect(calls.evaluates).toBe(3);
    expect(calls.submitted).toBe(1);
  });
});

describe("session identity gate (F3, all commands)", () => {
  it("fails closed with IDENTITY_MISMATCH before reading a foreign session", async () => {
    const calls = newCalls();
    const result = await run("cinevision.listServers", {}, {
      form: null,
      reads: [okData(foreignIdentityBody())],
    }, calls);
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("IDENTITY_MISMATCH");
    expect(result.data).toBeUndefined();
    // Exactly 1 in-page read: the gate fired BEFORE the requested read.
    expect(calls.evaluates).toBe(1);
    expect(calls.closed).toBe(1);
  });

  it("detects an identity change after reauth before retrying the read", async () => {
    const calls = newCalls();
    const expired = (): InPageResult => ({ kind: "ok", status: 401, contentType: "application/json", data: {} });
    const result = await run("cinevision.listServers", {}, {
      form: null,
      formAfterReauth: {
        forms: 1, emailInputs: 1, passwordInputs: 1, submitButtons: 1,
      },
      // Gate matches, read 401s, reauth lands on a FOREIGN account.
      reads: [okData(identityBody()), expired(), okData(foreignIdentityBody())],
    }, calls);
    expect(result.status).toBe("HUMAN_REQUIRED");
    expect(result.errorCode).toBe("IDENTITY_MISMATCH");
    expect(result.data).toBeUndefined();
    expect(result.reauthenticated).toBe(true);
    // Gate + read + post-reauth re-verification, exactly.
    expect(calls.evaluates).toBe(3);
  });
});

describe("error mapping (Fase-1 taxonomy → envelope codes)", () => {
  it("maps classified causes to the documented envelope codes", () => {
    expect(mapReaderError({ code: "CHALLENGE", detail: "x", evidence: { status: 403, contentType: "", path: "p", durationMs: 1, schema: "NOT_EVALUATED" } }))
      .toEqual({ status: "HUMAN_REQUIRED", errorCode: "CHALLENGE_DETECTED" });
    expect(mapReaderError({ code: "SESSION_EXPIRED", detail: "x", evidence: { status: 401, contentType: "", path: "p", durationMs: 1, schema: "NOT_EVALUATED" } }))
      .toEqual({ status: "HUMAN_REQUIRED", errorCode: "SESSION_EXPIRED" });
    expect(mapReaderError({ code: "AUTH_FAILED", detail: "x", evidence: { status: 401, contentType: "", path: "p", durationMs: 1, schema: "NOT_EVALUATED" } }))
      .toEqual({ status: "HUMAN_REQUIRED", errorCode: "IDENTITY_MISMATCH" });
    expect(mapReaderError({ code: "RATE_LIMITED", detail: "x", evidence: { status: 429, contentType: "", path: "p", durationMs: 1, schema: "NOT_EVALUATED" } }))
      .toEqual({ status: "INCONCLUSIVE", errorCode: "RATE_LIMITED" });
    expect(mapReaderError({ code: "TRANSPORT", detail: "x", evidence: { status: null, contentType: "", path: "p", durationMs: 1, schema: "NOT_EVALUATED" }, effectCertainty: "UNKNOWN" }))
      .toEqual({ status: "INCONCLUSIVE", errorCode: "TRANSPORT" });
  });

  it("surfaces provider failures end-to-end with mapped codes", async () => {
    const bodies: Array<{ reads: InPageResult[]; code: string }> = [
      { reads: [httpData(403, "application/json", { message: "deny" })], code: "PERMISSION_DENIED" },
      { reads: [httpData(429, "application/json", {})], code: "RATE_LIMITED" },
      { reads: [httpData(500, "text/html", "<html></html>")], code: "HTTP_FAILURE" },
      { reads: [okData({ data: [{ id: "s-1", name: 42 }] })], code: "BAD_RESPONSE" },
    ];
    for (const b of bodies) {
      const calls = newCalls();
      // F3 identity gate passes, then the requested read fails as scripted.
      const result = await run(
        "cinevision.listServers",
        {},
        { form: null, reads: [okData(identityBody()), ...b.reads] },
        calls,
      );
      expect(result.errorCode, b.code).toBe(b.code);
      expect(result.command).toBe("cinevision.listServers");
      expect(calls.evaluates).toBe(2);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it("maps a rejected evaluate (closed page) to TRANSPORT", async () => {
    const calls = newCalls();
    const broken: CinevisionCommandBrowser = {
      open: async () => {
        calls.opened += 1;
        const page = await fakeBrowser({ form: null, reads: [] }, calls).open("p", ALLOWED, "/api");
        page.evaluateCapability = async () => {
          throw new Error("context destroyed");
        };
        return page;
      },
    };
    const result = await runCinevisionCommand(
      config(),
      { secrets: fakeSecrets(), browser: broken },
      "cinevision.listServers",
      {},
    );
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("TRANSPORT");
  });
});

describe("command budget (F2 cancellation)", () => {
  it("fails closed with TRANSPORT when the total budget is exceeded", async () => {
    // Fake timers, same rationale as the sibling budget test below: a
    // real 200ms budget would start BEFORE the profile setup
    // (`ensureProfileDir` + `acquireProfileLock`, real async fs) finishes,
    // so on a loaded machine it could expire before `browser.open` ever
    // ran and the attempt would never reach the wedged navigation. Here
    // the clock advances only after that navigation is in flight, so the
    // timeout is the only thing under test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const calls = newCalls();
      const hanging: CinevisionCommandBrowser = {
        open: async () => {
          calls.opened += 1;
          const page = await fakeBrowser({ form: null, reads: [] }, calls).open("p", ALLOWED, "/api");
          page.goto = async () => {
            calls.gotos += 1;
            await new Promise(() => undefined);
          };
          return page;
        },
      };
      const cfg = config({ commandTimeoutMs: 200 });
      const resultPromise = runCinevisionCommand(
        cfg,
        { secrets: fakeSecrets(), browser: hanging },
        "cinevision.listServers",
        {},
      );
      // The attempt reached the wedged navigation (open + goto) BEFORE the
      // budget is allowed to elapse — deterministic, no real 200ms race.
      // (`opened` is 2 here: this fake's own `open` plus the inner fake
      // browser's, same as before.)
      expect(await untilReal(() => calls.gotos === 1)).toBe(true);
      expect(calls.opened).toBe(2);
      expect(calls.closed).toBe(0);
      vi.advanceTimersByTime(cfg.commandTimeoutMs);
      const result = await resultPromise;
      expect(result.status).toBe("INCONCLUSIVE");
      expect(result.errorCode).toBe("TRANSPORT");
      // Bounded close + lock release happened even with work still pending.
      expect(calls.closed).toBeGreaterThanOrEqual(1);
      // The still-wedged navigation ran no step either.
      expect(calls.evaluates).toBe(0);
      expect(calls.submitted).toBe(0);
      const lock = await acquireProfileLock(cfg.profileDir);
      await lock.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs no further steps after the budget expires and frees the lock", async () => {
    // Fake timers: the budget elapses only when this test advances the
    // clock. A real 50ms timer would start BEFORE the profile setup
    // (`ensureProfileDir` + `acquireProfileLock`, real async fs) finishes,
    // so on a loaded machine it could expire before `browser.open` ever
    // ran and the attempt would never reach the wedged navigation below.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const calls = newCalls();
      let releaseGoto!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGoto = resolve;
      });
      let gotoResumes = 0;
      const hanging: CinevisionCommandBrowser = {
        open: async () => {
          calls.opened += 1;
          const page = await fakeBrowser({ form: null, reads: [] }, calls).open("p", ALLOWED, "/api");
          page.goto = async () => {
            calls.gotos += 1;
            await gate;
            gotoResumes += 1;
          };
          return page;
        },
      };
      const cfg = config({ commandTimeoutMs: 50 });
      const resultPromise = runCinevisionCommand(
        cfg,
        { secrets: fakeSecrets(), browser: hanging },
        "cinevision.listServers",
        {},
      );
      // The attempt reached the wedged navigation (open + goto) BEFORE the
      // budget is allowed to elapse — deterministic, no real 50ms race.
      // (`opened` is 2 here: this fake's own `open` plus the inner fake
      // browser's, same as before.)
      expect(await untilReal(() => calls.gotos === 1)).toBe(true);
      expect(calls.opened).toBe(2);
      expect(calls.closed).toBe(0);
      vi.advanceTimersByTime(cfg.commandTimeoutMs);
      const result = await resultPromise;
      expect(result.status).toBe("INCONCLUSIVE");
      expect(result.errorCode).toBe("TRANSPORT");
      // The budget owner closed the context boundedly and ran no reads.
      expect(calls.closed).toBeGreaterThanOrEqual(1);
      expect(calls.evaluates).toBe(0);
      // The wedged navigation resolves AFTER the budget: the late attempt
      // must perform no further step (no login, no reads).
      releaseGoto();
      expect(await untilReal(() => gotoResumes === 1)).toBe(true);
      expect(calls.evaluates).toBe(0);
      expect(calls.submitted).toBe(0);
      // The profile lock is free despite the late-resolving work.
      const lock = await acquireProfileLock(cfg.profileDir);
      await lock.release();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("open cancellation (N2 ownership-safe acquisition)", () => {
  it("timeout during open closes the early context, frees the lock, late resolution assigns nothing", async () => {
    // Fake timers (same rationale as the budget test): `open` is reached
    // only after real async fs work (profile dir + profile lock), so a
    // real 50ms budget could expire before the context exists and the
    // contract under test (early-exposed context closed by the timeout
    // owner) would never be exercised. Restored in `finally`, so a failed
    // assertion cannot leak fake timers into the rest of the suite.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const calls = newCalls();
      let releaseOpen!: (page: CinevisionCommandPage) => void;
      const openGate = new Promise<CinevisionCommandPage>((resolve) => {
        releaseOpen = resolve;
      });
      /** Early contexts exposed through `onContext`, before `open` resolves. */
      let exposedContexts = 0;
      // Signal-ignoring browser: pends like a wedged launch, but exposes
      // its context early via onContext (the contract under test).
      const pendingOpen: CinevisionCommandBrowser = {
        open: async (_dir, _origin, _login, opts) => {
          calls.opened += 1;
          opts?.onContext?.({
            close: async () => {
              calls.closed += 1;
            },
          });
          exposedContexts += 1;
          return openGate;
        },
      };
      const cfg = config({ commandTimeoutMs: 50 });
      const resultPromise = runCinevisionCommand(
        cfg,
        { secrets: fakeSecrets(), browser: pendingOpen },
        "cinevision.listServers",
        {},
      );
      // Proof the timeout is the thing under test: `open` ran and
      // `onContext` exposed the context BEFORE the budget is allowed to
      // elapse (bounded real-clock wait, not a wall-clock guess).
      expect(await untilReal(() => calls.opened === 1 && exposedContexts === 1)).toBe(true);
      expect(calls.closed).toBe(0);
      vi.advanceTimersByTime(cfg.commandTimeoutMs);
      const result = await resultPromise;
      expect(result.status).toBe("INCONCLUSIVE");
      expect(result.errorCode).toBe("TRANSPORT");
      // Timeout owner closed the early-exposed context boundedly.
      expect(calls.closed).toBeGreaterThanOrEqual(1);
      // Lock released: another execution can acquire it (no collision).
      const lock = await acquireProfileLock(cfg.profileDir);
      await lock.release();
      // Late launch resolves AFTER cleanup: the runner must close the
      // tardy page instead of assigning it, and run zero steps with it.
      const lateCalls = newCalls();
      const lateInner = await fakeBrowser({ form: null, reads: [] }, lateCalls).open("p", ALLOWED, "/api");
      const closedBefore = calls.closed;
      releaseOpen({ ...lateInner, close: async () => { calls.closed += 1; } });
      expect(await untilReal(() => calls.closed > closedBefore)).toBe(true);
      // The tardy page was closed instead of used.
      expect(calls.closed).toBeGreaterThan(closedBefore);
      expect(calls.gotos).toBe(0);
      expect(calls.evaluates).toBe(0);
      expect(calls.submitted).toBe(0);
      // The tardy page itself never ran a step either.
      expect(lateCalls.gotos).toBe(0);
      expect(lateCalls.evaluates).toBe(0);
      expect(lateCalls.submitted).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("output safety", () => {
  it("never emits tokens, passwords or origins in any envelope", async () => {
    const calls = newCalls();
    const result = await run("cinevision.listServers", {}, {
      form: null,
      reads: [okData(identityBody()), okData(serversBody())],
    }, calls);
    const line = formatResult(result);
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(SECRET_URL);
    expect(line).not.toContain(EMAIL);
  });
});
