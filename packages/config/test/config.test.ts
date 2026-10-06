import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_CORS_ORIGIN, loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("returns defaults for an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ NODE_ENV: "development", PORT: 3001, LOG_LEVEL: "info" });
    expect(cfg.DATABASE_URL).toBeUndefined();
  });

  it("accepts valid overrides", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      APP_DATABASE_URL: "postgresql://iptv_app:secret@localhost:5432/iptv",
      LOG_LEVEL: "warn",
      BETTER_AUTH_SECRET: "real-production-secret-0123456789",
      PROVIDER_DISPATCH_MODE: "durable",
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.NODE_ENV).toBe("production");
  });

  it("rejects the dev auth secret in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-only-better-auth-secret-0123456789",
        PROVIDER_DISPATCH_MODE: "durable",
      }),
    ).toThrow(/BETTER_AUTH_SECRET must be overridden in production/);
  });

  it("throws descriptive errors on invalid env", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/invalid environment configuration/);
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/invalid environment configuration/);
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(/invalid environment configuration/);
  });

  it("defaults CORS to the local web origin outside production", () => {
    expect(loadConfig({}).CORS_ALLOWED_ORIGINS).toEqual([DEFAULT_LOCAL_CORS_ORIGIN]);
    expect(DEFAULT_LOCAL_CORS_ORIGIN).toBe("http://localhost:3000");
    expect(loadConfig({ NODE_ENV: "development" }).CORS_ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
    ]);
    expect(loadConfig({ NODE_ENV: "test" }).CORS_ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("denies all cross-origin requests in production with no configured origin", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      APP_DATABASE_URL: "postgresql://iptv_app:secret@localhost:5432/iptv",
      BETTER_AUTH_SECRET: "real-production-secret-0123456789",
      PROVIDER_DISPATCH_MODE: "durable",
    });
    expect(cfg.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("parses comma-separated exact origins, trimming and deduping", () => {
    const cfg = loadConfig({
      CORS_ALLOWED_ORIGINS: " http://localhost:3000, https://app.example.com ,http://localhost:3000",
    });
    expect(cfg.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:3000", "https://app.example.com"]);
  });

  it("rejects wildcard and invalid CORS origins", () => {
    for (const bad of [
      "*",
      "https://*.example.com",
      "https://app.example.com/*",
      "app.example.com",
      "https://app.example.com/app",
      "https://app.example.com?x=1",
      "https://app.example.com#frag",
      "ftp://app.example.com",
      "not-a-url",
    ]) {
      expect(() => loadConfig({ CORS_ALLOWED_ORIGINS: bad })).toThrow(
        /CORS_ALLOWED_ORIGINS contains invalid origin/,
      );
    }
  });

  it("leaves the disposable trial account undesignated by default", () => {
    expect(loadConfig({}).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBeUndefined();
    expect(loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "" }).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBeUndefined();
  });

  it("accepts a uuid disposable trial account and rejects anything else", () => {
    const id = "a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9";
    expect(loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: id }).PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID).toBe(id);
    expect(() => loadConfig({ PROVIDER_TRIAL_DISPOSABLE_ACCOUNT_ID: "not-a-uuid" })).toThrow(
      /invalid environment configuration/,
    );
  });
});

/**
 * CV-DSP-01 production fail-fast: the leased durable dispatcher is the only
 * certified executor for real provider writes, so a production boot must set
 * `PROVIDER_DISPATCH_MODE=durable` explicitly instead of relying on the
 * historical inline fallback. Outside production nothing changes — the
 * resolver still falls back to inline for unset/empty/typo values.
 */
describe("loadConfig PROVIDER_DISPATCH_MODE", () => {
  const productionBase = {
    NODE_ENV: "production",
    APP_DATABASE_URL: "postgresql://iptv_app:secret@localhost:5432/iptv",
    BETTER_AUTH_SECRET: "real-production-secret-0123456789",
  } satisfies NodeJS.ProcessEnv;

  function withDispatchMode(raw: string | undefined): NodeJS.ProcessEnv {
    return raw === undefined ? { ...productionBase } : { ...productionBase, PROVIDER_DISPATCH_MODE: raw };
  }

  it("accepts an exact durable mode in production", () => {
    expect(() => loadConfig(withDispatchMode("durable"))).not.toThrow();
    expect(loadConfig(withDispatchMode("durable")).NODE_ENV).toBe("production");
  });

  it("rejects every non-durable value in production, naming the variable", () => {
    for (const bad of [
      undefined, // unset
      "", // empty is ABSENT per the repo rule, never a match
      "   ", // whitespace-only placeholder
      "inline",
      "DURABLE", // uppercase
      "Durable",
      " durable", // padded
      "durable ",
      "durable\n",
      "duarble", // typo
      "true",
    ]) {
      expect(() => loadConfig(withDispatchMode(bad)), `PROVIDER_DISPATCH_MODE=${JSON.stringify(bad)}`).toThrow(
        /invalid environment configuration: PROVIDER_DISPATCH_MODE must be exactly "durable"/,
      );
    }
  });

  it("reports an unset dispatch mode as unset in the production error", () => {
    expect(() => loadConfig(withDispatchMode(undefined))).toThrow(/received unset/);
    expect(() => loadConfig(withDispatchMode(""))).toThrow(/received unset/);
    expect(() => loadConfig(withDispatchMode("DURABLE"))).toThrow(/received "DURABLE"/);
  });

  it("keeps unset/empty/invalid dispatch modes accepted outside production", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      for (const raw of [undefined, "", "   ", "inline", "DURABLE", " durable ", "duarble"]) {
        const env = raw === undefined ? { NODE_ENV: nodeEnv } : { NODE_ENV: nodeEnv, PROVIDER_DISPATCH_MODE: raw };
        expect(() => loadConfig(env), `${nodeEnv} with ${JSON.stringify(raw)}`).not.toThrow();
      }
    }
    expect(loadConfig({}).NODE_ENV).toBe("development");
  });
});

/**
 * RLS production boot guard: a production API must present the restricted
 * `iptv_app` connection and must not carry privileged/test database
 * credentials in its own process. This validates the CONFIGURED identity only —
 * it neither queries the server (so it proves nothing about the connected
 * role's effective privileges), enables RLS, nor completes the role-split
 * cutover.
 */
describe("loadConfig production database guard", () => {
  const APP = "postgresql://iptv_app:secret@localhost:5432/iptv";
  const OWNER = "postgresql://iptv:iptv@localhost:5432/iptv";
  const TEST = "postgresql://iptv:iptv@localhost:5432/iptv_test";
  const productionBase = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "real-production-secret-0123456789",
    PROVIDER_DISPATCH_MODE: "durable",
  } satisfies NodeJS.ProcessEnv;

  it("accepts a production env carrying only APP_DATABASE_URL", () => {
    const cfg = loadConfig({ ...productionBase, APP_DATABASE_URL: APP });
    expect(cfg.APP_DATABASE_URL).toBe(APP);
    expect(cfg.NODE_ENV).toBe("production");
  });

  it("rejects a production env with no APP_DATABASE_URL and no owner string", () => {
    expect(() => loadConfig({ ...productionBase })).toThrow(
      /APP_DATABASE_URL must be set and non-blank when NODE_ENV=production/,
    );
  });

  it("treats a blank APP_DATABASE_URL as absent in production", () => {
    for (const raw of ["", "   ", "\t", "\n"]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw })).toThrow(
        /APP_DATABASE_URL must be set and non-blank when NODE_ENV=production/,
      );
    }
  });

  it("rejects a padded APP_DATABASE_URL in production instead of trimming it", () => {
    // Space padding only: tab/LF/CR are control characters and hit the earlier,
    // stricter rule (see the control-character test below).
    for (const raw of [` ${APP}`, `${APP} `, ` ${APP} `, `  ${APP}  `]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw })).toThrow(
        /APP_DATABASE_URL must not have leading or trailing whitespace when NODE_ENV=production/,
      );
    }
  });

  it("keeps an unpadded APP_DATABASE_URL byte-exact in production", () => {
    // A space inside the password is legal only percent-encoded (`%20`); a
    // literal space is refused (see the literal-space rejection test below).
    const withEncodedSpace = "postgresql://iptv_app:se%20cret@localhost:5432/iptv";
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: withEncodedSpace }).APP_DATABASE_URL).toBe(
      withEncodedSpace,
    );
  });

  it("treats a blank DATABASE_URL as absent and keeps a nonblank one byte-exact", () => {
    // Loader and resolver must agree: `resolveAppConnectionString` treats a
    // blank owner string as unset and uses a nonblank one verbatim, so
    // `AppConfig` must not report a trimmed or empty value either.
    for (const nodeEnv of ["development", "test"] as const) {
      for (const blank of ["", "   ", "\t"]) {
        expect(loadConfig({ NODE_ENV: nodeEnv, DATABASE_URL: blank }).DATABASE_URL, `${nodeEnv} ${JSON.stringify(blank)}`).toBeUndefined();
      }
      for (const nonblank of [OWNER, ` ${OWNER} `, `${OWNER}\n`]) {
        expect(loadConfig({ NODE_ENV: nodeEnv, DATABASE_URL: nonblank }).DATABASE_URL, `${nodeEnv} ${JSON.stringify(nonblank)}`).toBe(nonblank);
      }
      expect(loadConfig({ NODE_ENV: nodeEnv }).DATABASE_URL).toBeUndefined();
    }
    // Production: APP plus a blank owner placeholder is fine (blank is absent).
    expect(
      () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, DATABASE_URL: "   " }),
    ).not.toThrow();
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP })).not.toThrow();
    // A nonblank owner string in production is still refused.
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, DATABASE_URL: OWNER })).toThrow(
      /DATABASE_URL must NOT be present in the API process/,
    );
  });

  it("preserves a padded APP_DATABASE_URL byte-exact outside production", () => {
    // A connection value is never trimmed in any environment: outside
    // production the padded value is preserved exactly as the pool resolver
    // (`resolveAppConnectionString`) returns it, while blank stays absent.
    for (const nodeEnv of ["development", "test"] as const) {
      for (const padded of [` ${APP} `, `\t${APP}\n`]) {
        expect(loadConfig({ NODE_ENV: nodeEnv, APP_DATABASE_URL: padded }).APP_DATABASE_URL, `${nodeEnv} ${JSON.stringify(padded)}`).toBe(padded);
      }
      for (const blank of ["", "   ", "\t"]) {
        expect(loadConfig({ NODE_ENV: nodeEnv, APP_DATABASE_URL: blank }).APP_DATABASE_URL, `${nodeEnv} ${JSON.stringify(blank)}`).toBeUndefined();
      }
      expect(loadConfig({ NODE_ENV: nodeEnv }).APP_DATABASE_URL).toBeUndefined();
    }
  });

  it("never falls back to DATABASE_URL in production, even when it is set", () => {
    expect(() => loadConfig({ ...productionBase, DATABASE_URL: OWNER })).toThrow(
      /invalid environment configuration: DATABASE_URL must NOT be present in the API process when NODE_ENV=production/,
    );
    expect(() =>
      loadConfig({ ...productionBase, APP_DATABASE_URL: APP, DATABASE_URL: OWNER }),
    ).toThrow(/DATABASE_URL must NOT be present in the API process/);
    expect(() => loadConfig({ ...productionBase, DATABASE_URL: OWNER, TEST_DATABASE_URL: TEST })).toThrow(
      /DATABASE_URL must NOT be present in the API process/,
    );
  });

  it("rejects an owner-only DATABASE_OWNER_URL in the production API process", () => {
    expect(() =>
      loadConfig({ ...productionBase, APP_DATABASE_URL: APP, DATABASE_OWNER_URL: OWNER }),
    ).toThrow(/DATABASE_OWNER_URL must NOT be present in the API process when NODE_ENV=production/);
    expect(() => loadConfig({ ...productionBase, DATABASE_OWNER_URL: OWNER })).toThrow(
      /DATABASE_OWNER_URL must NOT be present in the API process/,
    );
  });

  it("keeps development/test URL precedence and owner vars exactly as before", () => {
    for (const nodeEnv of ["development", "test", undefined] as const) {
      const env: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
      if (nodeEnv === undefined) delete env["NODE_ENV"];
      const cfg = loadConfig({ ...env, APP_DATABASE_URL: APP, DATABASE_URL: OWNER, DATABASE_OWNER_URL: OWNER });
      expect(cfg.APP_DATABASE_URL, String(nodeEnv)).toBe(APP);
      expect(cfg.DATABASE_URL, String(nodeEnv)).toBe(OWNER);
      // A blank placeholder is still ABSENT outside production (repo rule).
      expect(loadConfig({ NODE_ENV: nodeEnv, APP_DATABASE_URL: "" }).APP_DATABASE_URL, String(nodeEnv)).toBeUndefined();
    }
    expect(loadConfig({}).NODE_ENV).toBe("development");
  });

  it("accepts the exact iptv_app authority username and returns it byte-exact", () => {
    const full = "postgresql://iptv_app:p%40ss-w0rd@db.internal:5432/iptv?sslmode=verify-full&application_name=api";
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: full }).APP_DATABASE_URL).toBe(full);
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: "postgres://iptv_app:s@db/iptv" }).APP_DATABASE_URL).toBe(
      "postgres://iptv_app:s@db/iptv",
    );
  });

  it("rejects any authority username other than exactly iptv_app", () => {
    const wrong = [
      OWNER, // iptv (owner)
      "postgresql://postgres:postgres@localhost:5432/iptv", // superuser
      "postgresql://IPTV_APP:s@localhost:5432/iptv", // case variant
      "postgresql://Iptv_App:s@localhost:5432/iptv",
      "postgresql://iptv%5Fapp:s@localhost:5432/iptv", // percent-encoded underscore
      "postgresql://iptv_app2:s@localhost:5432/iptv", // role-name prefix
      "postgresql://x_iptv_app:s@localhost:5432/iptv",
      "postgresql://localhost:5432/iptv", // no authority username
      "postgresql://:s@localhost:5432/iptv", // empty username
    ];
    for (const raw of wrong) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), raw).toThrow(
        /must carry exactly "iptv_app" as the URI authority username/,
      );
    }
  });

  it("rejects a malformed or non-PostgreSQL APP_DATABASE_URL", () => {
    for (const raw of [
      "just-a-host:5432",
      "//iptv_app:s@localhost/iptv",
      "mysql://iptv_app:s@localhost:3306/iptv",
      "http://iptv_app:s@localhost:5432/iptv",
      "file:///var/run/postgresql/iptv",
    ]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), raw).toThrow(
        /must (be a parseable PostgreSQL connection URI|use a PostgreSQL scheme \(pg:\/\/.*\))/,
      );
    }
  });

  it("rejects user/role/options query parameters that alter the session identity", () => {
    // `user` is the driver identity override, `options` is forwarded to server
    // startup (so it can request a role change; success depends on server-side
    // membership/privileges this guard does not verify), and `role` is denied by
    // policy with no claim about current-driver behavior.
    for (const [param, pattern] of [
      ["user", /must not carry a `user` query parameter/],
      ["USER", /must not carry a `user` query parameter/],
      ["User", /must not carry a `user` query parameter/],
      ["role", /must not carry a `role` query parameter/],
      ["ROLE", /must not carry a `role` query parameter/],
      ["Role", /must not carry a `role` query parameter/],
      ["options", /must not carry a `options` query parameter/],
      ["OPTIONS", /must not carry a `options` query parameter/],
      ["Options", /must not carry a `options` query parameter/],
    ] as const) {
      const raw = `postgresql://iptv_app:s@localhost:5432/iptv?sslmode=require&${param}=x`;
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), raw).toThrow(pattern);
    }
    for (const raw of [
      "postgresql://iptv_app:s@localhost:5432/iptv?user=postgres",
      "postgresql://iptv_app:s@localhost:5432/iptv?role=owner",
      "postgresql://iptv_app:s@localhost:5432/iptv?options=-c%20role%3Downer",
      "postgresql://iptv_app:s@localhost:5432/iptv?options=-c%20role=owner&sslmode=require",
      "postgresql://iptv_app:s@localhost:5432/iptv?sslmode=require&OPTIONS=-c%20role=owner",
    ]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), raw).toThrow(
        /must not carry a `(user|role|options)` query parameter/,
      );
    }
  });

  it("rejects ASCII control characters anywhere in a production APP URL", () => {
    // Checked BEFORE `new URL`, which silently strips tab/LF/CR — otherwise an
    // embedded control character would vanish before any check could see it.
    const base = "postgresql://iptv_app:s@localhost:5432/iptv";
    for (const raw of [
      `postgresql://iptv_app:s@local\thost:5432/iptv`,
      `${base}\n`,
      `${base}\r`,
      `postgresql://iptv_app:s@localhost:5432/iptv\n?sslmode=require`,
      `postgresql://iptv_app:s@localhost:5432/iptv?user${"\t"}=postgres`,
      `postgresql://iptv_app:s@localhost:5432/iptv?sslmode=${"\u0000"}verify-full`,
      `postgresql://iptv_app:s@localhost:5432/iptv${"\u0007"}`,
      `postgresql://iptv_app:s@localhost:5432/iptv${"\u001F"}`,
    ]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw })).toThrow(
        /APP_DATABASE_URL must not contain ASCII control characters/,
      );
    }
    // The message must not echo the smuggled character or the value.
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: `postgresql://iptv_app:s@h/iptv\n?user=postgres` });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("@h");
    expect(message).not.toContain("\n");
  });

  it("rejects percent-encoded ASCII controls in URI components", () => {
  // `new URL` keeps `%00`/`%09` encoded in username/password/raw query and
  // `URLSearchParams` decodes them into REAL control characters, so both the
  // escape form and the decoded form have to be screened.
  for (const raw of [
    "postgresql://iptv_app:api%00user%00postgres@localhost:5432/iptv",
    "postgresql://iptv_app:p%09tab@localhost:5432/iptv",
    "postgresql://iptv_app:p%0aLF@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv?application_name=api%00user%00postgres",
    "postgresql://iptv_app:p@localhost:5432/iptv?application_name=api%09tab",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require%0d%0ax=1",
    `postgresql://iptv%00app:p@localhost:5432/iptv`,
  ]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw })).toThrow(
      /unsafe URI (username|password|query string)|decoded (key|value) contains an ASCII control character/,
    );
  }
});

it("rejects malformed percent escapes in URI components", () => {
  for (const raw of [
    "postgresql://iptv_app:p%zz@localhost:5432/iptv",
    "postgresql://iptv_app:p%2@localhost:5432/iptv",
    "postgresql://iptv_app:p%@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv?%zz=1",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=%2",
  ]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw })).toThrow(
      /malformed percent escapes/,
    );
  }
});

it("accepts the pg:// scheme alongside postgres:// and postgresql://", () => {
  for (const scheme of ["pg", "postgres", "postgresql"]) {
    const raw = `${scheme}://iptv_app:p@localhost:5432/iptv?sslmode=require`;
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: raw }).APP_DATABASE_URL, scheme).toBe(raw);
  }
});

it("rejects a repeated query parameter case-insensitively", () => {
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&sslmode=disable",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&SSLMODE=verify-full",
    "postgresql://iptv_app:p@localhost:5432/iptv?SslMode=require&sslmode=disable",
    "postgresql://iptv_app:p@localhost:5432/iptv?connect_timeout=5&connect%5Ftimeout=9",
    "postgresql://iptv_app:p@localhost:5432/iptv?ssl=true&SSL=false",
    "postgresql://iptv_app:p@localhost:5432/iptv?application_name=a&application_name=b",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/must not repeat a query parameter/);
    // No key and no value is echoed.
    expect(message).not.toContain("sslmode");
    expect(message).not.toContain("verify-full");
    expect(message).not.toContain("connect_timeout");
    expect(message).not.toContain("@localhost");
  }
});

it("validates the ssl parameter against the installed pg parser semantics", () => {
  for (const value of ["true", "1", "0"]) {
    const raw = `postgresql://iptv_app:p@localhost:5432/iptv?ssl=${value}`;
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: raw }).APP_DATABASE_URL, value).toBe(raw);
  }
  // `ssl=false` is refused: the installed parser leaves it as a truthy string,
  // so it would NOT disable TLS. The operator is directed to `ssl=0` or
  // `sslmode=disable`.
  let falseMessage = "";
  try {
    loadConfig({ ...productionBase, APP_DATABASE_URL: "postgresql://iptv_app:p@localhost:5432/iptv?ssl=false" });
  } catch (err) {
    falseMessage = err instanceof Error ? err.message : String(err);
  }
  expect(falseMessage).toMatch(/must not set `ssl=false`/);
  expect(falseMessage).toMatch(/use `ssl=0` or `sslmode=disable`/);
  expect(falseMessage).not.toContain("@localhost");
  for (const value of ["yes", "TRUE", "True", "maybe", "require", ""]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: `postgresql://iptv_app:p@localhost:5432/iptv?ssl=${value}` });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, value).toMatch(/must set `ssl` to exactly one of: true, 1, 0/);
    expect(message).not.toContain("@localhost");
  }
});

it("requires canonical lowercase connection-query keys in production", () => {
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  // The driver consumes lowercase parameters; `SSLMODE`/`SslMode` would be read
  // as an unknown setting and silently fall back instead of applying the mode.
  for (const query of [
    "SSLMODE=require",
    "SslMode=require",
    "SSLRootCert=/etc/ssl/ca.pem",
    "application_NAME=api",
    "CONNECT_TIMEOUT=5",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, query).toMatch(/must use canonical lowercase connection-query keys/);
    expect(message).not.toContain("require");
    expect(message).not.toContain("@localhost");
  }
  // Canonical lowercase keys stay legal.
  for (const query of ["sslmode=require", "application_name=api", "connect_timeout=5", "sslrootcert=/etc/ssl/ca.pem"]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }).APP_DATABASE_URL, query).toBe(at(query));
  }
  // Forbidden keys stay rejected case-insensitively (before the lowercase rule).
  for (const query of ["USER=postgres", "User=postgres", "Host=other", "DBName=x", "OPTIONS=-c%20role=owner"]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }), query).toThrow(
      /must not carry a `(user|host|dbname|options)` query parameter/,
    );
  }
});

it("requires a nonblank sslrootcert only for libpq-compat verify-ca", () => {
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  // Evidence-backed case: the installed parser throws for
  // `uselibpqcompat=true&sslmode=verify-ca` without a CA bundle.
  const missing = at("sslmode=verify-ca&uselibpqcompat=true");
  let message = "";
  try {
    loadConfig({ ...productionBase, APP_DATABASE_URL: missing });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toMatch(
    /must carry a non-blank `sslrootcert` value together with `sslmode=verify-ca` under uselibpqcompat=true/,
  );
  // No claim about the certificate file itself.
  expect(message).toMatch(/does not verify that the certificate file is readable or valid on the server/);
  expect(message).not.toContain("@localhost");
  // Blank/omitted is not enough (percent-encoded spaces: a raw padded URI would
  // be refused earlier by the padding rule).
  for (const blank of ["", "%20%20"]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at(`sslmode=verify-ca&uselibpqcompat=true&sslrootcert=${blank}`) }), `blank ${blank}`).toThrow(
      /must carry a non-blank `sslrootcert`/,
    );
  }
  // Present and non-blank is accepted byte-exact.
  const withRoot = at("sslmode=verify-ca&uselibpqcompat=true&sslrootcert=%2Fetc%2Fssl%2Fca.pem");
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: withRoot }).APP_DATABASE_URL).toBe(withRoot);
  // `verify-ca` outside libpq-compat is not covered by this guard.
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=verify-ca") }).APP_DATABASE_URL).toBe(
    at("sslmode=verify-ca"),
  );
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=verify-ca&uselibpqcompat=false") }).APP_DATABASE_URL).toBe(
    at("sslmode=verify-ca&uselibpqcompat=false"),
  );
});

it("keeps verify-full legal without a custom root certificate", () => {
  // `verify-full` uses `{}` (system CA + identity verification) per the
  // node-postgres documentation, so it must NOT be gated on `sslrootcert`.
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  for (const query of [
    "sslmode=verify-full&uselibpqcompat=true",
    "sslmode=verify-full&uselibpqcompat=false",
    "sslmode=verify-full",
    "sslmode=verify-full&uselibpqcompat=true&sslrootcert=%2Fca.pem",
  ]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }).APP_DATABASE_URL, query).toBe(at(query));
  }
});

it("validates sslmode against the documented sets for uselibpqcompat", () => {
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  // Common modes are valid in every configuration; `verify-ca` additionally needs
  // `sslrootcert` under uselibpqcompat=true (covered separately).
  for (const mode of ["disable", "prefer", "require", "verify-ca", "verify-full"]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(`sslmode=${mode}`) }).APP_DATABASE_URL, mode).toBe(at(`sslmode=${mode}`));
    const libpqQuery = at(
      mode === "verify-ca"
        ? `sslmode=${mode}&uselibpqcompat=true&sslrootcert=%2Fca.pem`
        : `sslmode=${mode}&uselibpqcompat=true`,
    );
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: libpqQuery }).APP_DATABASE_URL, `${mode}+libpq`).toBe(libpqQuery);
    expect(
      loadConfig({ ...productionBase, APP_DATABASE_URL: at(`sslmode=${mode}&uselibpqcompat=false`) }).APP_DATABASE_URL,
      `${mode}+nolibpq`,
    ).toBe(at(`sslmode=${mode}&uselibpqcompat=false`));
  }
  // `allow` is libpq-compat only; `no-verify` is pg-native and excluded there.
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=allow") })).toThrow(
    /allow requires uselibpqcompat=true\)/,
  );
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=allow&uselibpqcompat=true") }).APP_DATABASE_URL).toBe(
    at("sslmode=allow&uselibpqcompat=true"),
  );
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=allow&uselibpqcompat=false") })).toThrow(
    /allow requires uselibpqcompat=true\)/,
  );
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=no-verify") }).APP_DATABASE_URL).toBe(
    at("sslmode=no-verify"),
  );
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=no-verify&uselibpqcompat=true") })).toThrow(
    /allow is available and no-verify is not\)/,
  );
  // Unsupported modes, with the value never echoed (the message may name the
  // ALLOWED set, so the sentinels below cannot be substrings of it).
  for (const mode of ["BOGUS-MODE", "SENTINEL", "REQUIRE", ""]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: at(`sslmode=${mode}`) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, mode).toMatch(/must set `sslmode` to one of:/);
    expect(message).not.toContain("BOGUS-MODE");
    expect(message).not.toContain("SENTINEL");
    expect(message).not.toContain("@localhost");
  }
});

it("validates uselibpqcompat and rejects conflicting or impossible TLS settings", () => {
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  for (const value of ["true", "false"]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(`uselibpqcompat=${value}`) }).APP_DATABASE_URL, value).toBe(
      at(`uselibpqcompat=${value}`),
    );
  }
  for (const value of ["1", "yes", "TRUE", ""]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at(`uselibpqcompat=${value}`) }), value).toThrow(
      /must set `uselibpqcompat` to exactly true or false/,
    );
  }
  // `ssl` together with `sslmode` has ambiguous precedence.
  for (const query of ["ssl=true&sslmode=require", "sslmode=verify-full&ssl=0", "ssl=1&sslmode=disable"]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }), query).toThrow(
      /must not set both `ssl` and `sslmode`/,
    );
  }
  for (const disable of ["ssl=0", "sslmode=disable"]) {
    for (const certificate of ["sslrootcert=%2Fca.pem", "sslcert=%2Fclient.pem", "sslkey=%2Fclient.key", "sslrootcert=%20%20"]) {
      let message = "";
      try {
        loadConfig({ ...productionBase, APP_DATABASE_URL: at(`${disable}&${certificate}`) });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${disable}&${certificate}`).toMatch(/must not combine explicit TLS disable/);
      expect(message).not.toContain("client.key");
      expect(message).not.toContain("localhost");
    }
  }
  // TLS is not required globally — only impossible combinations are refused.
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("sslmode=disable") }).APP_DATABASE_URL).toBe(
    at("sslmode=disable"),
  );
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at("ssl=0") }).APP_DATABASE_URL).toBe(at("ssl=0"));
  // `ssl=false` is NOT an accepted way to disable TLS (truthy string in the
  // installed parser) — it is refused above.
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: at("ssl=false") })).toThrow(
    /must not set `ssl=false`/,
  );
  // `sslnegotiation=direct` with TLS explicitly disabled is contradictory.
  for (const query of [
    "sslnegotiation=direct&sslmode=disable",
    "sslmode=disable&sslnegotiation=direct",
    "sslnegotiation=direct&ssl=0",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, query).toMatch(/must not set `sslnegotiation=direct` while TLS is explicitly disabled/);
    expect(message).not.toContain("@localhost");
  }
  // The same combinations are fine when TLS is enabled or unspecified.
  for (const query of [
    "sslnegotiation=direct&sslmode=require",
    "sslnegotiation=direct&ssl=true",
    "sslnegotiation=direct",
    "sslnegotiation=postgres&sslmode=disable",
  ]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }).APP_DATABASE_URL, query).toBe(at(query));
  }
});

it("requires an explicit host and database name in the URI", () => {
  // An empty host/path would let node-postgres fall back to PGHOST/PGDATABASE
  // (or the libpq default) and connect somewhere this guard never inspected.
  for (const raw of [
    "postgresql:/iptv", // no authority at all
    "postgres:////", // scheme only, no authority and no path
    "postgresql://iptv_app:p@localhost",
    "postgresql://iptv_app:p@localhost/",
    "postgresql://iptv_app:p@localhost:5432",
    "postgresql://iptv_app:p@localhost:5432/?sslmode=require",
    "postgresql://iptv_app:p@localhost?dbname=other",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(
      /must carry an explicit (host in the URI authority|database name in the URI path)/,
    );
    expect(message).not.toContain("@localhost");
    expect(message).not.toContain("other");
  }
  // A stated target is accepted byte-exact, including a percent-encoded space
  // as the database name (decoded non-empty).
  for (const ok of [
    "postgresql://iptv_app:p@db.internal:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv%20prod",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&application_name=api",
  ]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: ok }).APP_DATABASE_URL, ok).toBe(ok);
  }
});

it("rejects host/port/database query overrides", () => {
  for (const param of ["host", "HOST", "Host", "port", "PORT", "database", "DATABASE", "db", "DB", "dbname", "DBNAME"]) {
    const raw = `postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&${param}=other`;
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), param).toThrow(
      new RegExp(`must not carry a \`${param.toLowerCase()}\` query parameter`),
    );
  }
  // Ordinary settings remain permitted.
  const ok = "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&application_name=api&connect_timeout=5";
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: ok }).APP_DATABASE_URL).toBe(ok);
});

it("rejects ambient libpq target/transport variables in production", () => {
  for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGSSLNEGOTIATION"] as const) {
    expect(
      () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "whatever" }),
      key,
    ).toThrow(new RegExp(`${key} must NOT be present in the API process when NODE_ENV=production`));
    // Driver-consumed: only an EMPTY string is absent — whitespace-only is a
    // supplied setting and is refused too.
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "  " }), `${key} blank`).toThrow(
      new RegExp(`${key} must NOT be present`),
    );
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "" }), `${key} empty`).not.toThrow();
  }
  // PGAPPNAME remains allowed with a safe name.
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGAPPNAME: "iptv-api" })).not.toThrow();
});

it("keeps the repo blank-means-absent rule for owner aliases but not for PG variables", () => {
  // Owner aliases: whitespace-only counts as absent (repo rule), unchanged.
  for (const key of ["DATABASE_URL", "DATABASE_OWNER_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"] as const) {
    for (const blank of ["", "   ", "\t"]) {
      expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: blank }), `${key} ${JSON.stringify(blank)}`).not.toThrow();
    }
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "x" }), key).toThrow(
      new RegExp(`${key} must NOT be present`),
    );
  }
  // PGPASSWORD is a driver-consumed variable: whitespace-only is REFUSED.
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGPASSWORD: "   " })).toThrow(
    /PGPASSWORD must NOT be present/,
  );
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGPASSWORD: "" })).not.toThrow();
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGOPTIONS: "   " })).toThrow(
    /PGOPTIONS must NOT be present/,
  );
  expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGOPTIONS: "" })).not.toThrow();
});

it("keeps ambient libpq variables and target-less URLs legal outside production", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    const env = {
      NODE_ENV: nodeEnv,
      PGHOST: "localhost",
      PGPORT: "5432",
      PGDATABASE: "iptv",
      PGUSER: "iptv",
      PGSSLMODE: "disable",
      PGSSLNEGOTIATION: "postgres",
      PGOPTIONS: "-c role=owner",
      PGAPPNAME: "local dev",
    } satisfies NodeJS.ProcessEnv;
    expect(loadConfig(env).NODE_ENV, nodeEnv).toBe(nodeEnv);
    // Precedence and value handling outside production are untouched.
    expect(loadConfig({ ...env, APP_DATABASE_URL: APP }).APP_DATABASE_URL, nodeEnv).toBe(APP);
    expect(loadConfig({ ...env, APP_DATABASE_URL: OWNER }).APP_DATABASE_URL, nodeEnv).toBe(OWNER);
    expect(loadConfig({ ...env, APP_DATABASE_URL: "", DATABASE_URL: OWNER }).DATABASE_URL, nodeEnv).toBe(OWNER);
    expect(loadConfig({ ...env, APP_DATABASE_URL: "", DATABASE_URL: "", TEST_DATABASE_URL: TEST }).DATABASE_URL, nodeEnv).toBeUndefined();
  }
});

it("rejects percent-encoded ASCII controls and malformed escapes in the database path", () => {
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/db%00x",
    "postgresql://iptv_app:p@localhost:5432/db%09x",
    "postgresql://iptv_app:p@localhost:5432/db%0ax",
    "postgresql://iptv_app:p@localhost:5432/db%2",
    "postgresql://iptv_app:p@localhost:5432/db%zz",
    "postgresql://iptv_app:p@localhost:5432/db%",
  ]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: raw }), raw).toThrow(
      /unsafe URI database path/,
    );
  }
});

it("rejects percent-encoded ASCII controls and malformed escapes in the URI hostname", () => {
  for (const raw of [
    "postgresql://iptv_app:p@db%00evil:5432/iptv",
    "postgresql://iptv_app:p@db%09evil:5432/iptv",
    "postgresql://iptv_app:p@db%zz:5432/iptv",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/unsafe URI hostname/);
    expect(message).not.toContain("evil");
    expect(message).not.toContain("p@");
  }
});

it("rejects any URI fragment delimiter, including a bare trailing hash", () => {
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/iptv#secret-fragment",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require#user=postgres",
    "postgresql://iptv_app:p@localhost:5432/iptv#%00",
    // Fail-closed: a bare trailing `#` has an EMPTY url.hash and is still
    // refused, because the RAW delimiter is what is forbidden.
    "postgresql://iptv_app:p@localhost:5432/iptv#",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/must not contain a URI fragment delimiter/);
    // The rule names "fragment"; the rejected value must never appear.
    expect(message).not.toContain("secret");
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("@localhost");
    expect(message).not.toContain("\u0000");
  }
  // No fragment delimiter: accepted byte-exact. An encoded `%23` inside a
  // component is NOT a delimiter — ordinary encoded data, still legal.
  for (const ok of [
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require",
    "postgresql://iptv_app:p%23cret@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv%23?sslmode=require",
  ]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: ok }).APP_DATABASE_URL, ok).toBe(ok);
  }
});

it("keeps a percent-encoded space in the password legal and byte-exact", () => {
  // `%20` in the password and in a parameter value stay legal and byte-exact.
  const withSpace = "postgresql://iptv_app:se%20cret@localhost:5432/iptv?application_name=my%20api";
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: withSpace }).APP_DATABASE_URL).toBe(withSpace);
  expect(
    loadConfig({ ...productionBase, APP_DATABASE_URL: "postgresql://iptv_app:p%20x@localhost:5432/iptv?sslrootcert=%2Fetc%2Fca%20cert.pem" })
      .APP_DATABASE_URL,
  ).toBe("postgresql://iptv_app:p%20x@localhost:5432/iptv?sslrootcert=%2Fetc%2Fca%20cert.pem");
  // `pg://` with an encoded space is fine too.
  const pgScheme = "pg://iptv_app:se%20cret@localhost:5432/iptv";
  expect(loadConfig({ ...productionBase, APP_DATABASE_URL: pgScheme }).APP_DATABASE_URL).toBe(pgScheme);
});

it("rejects a literal space anywhere in a production APP URL", () => {
  // The installed driver rewrites a URI containing a literal space, so the
  // validator and the driver could disagree; require `%20` instead.
  for (const raw of [
    "not a uri",
    "postgresql://iptv_app:se cret@localhost:5432/iptv",
    "postgresql://iptv_app:secret@local host:5432/iptv",
    "postgresql://iptv_app:secret@localhost:5432/ip tv",
    "postgresql://iptv_app:secret@localhost:5432/iptv?application_name=my api",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/must not contain a literal space/);
    // No URL, password or value is echoed (`%20` appears only as static
    // guidance text in the message, not as the rejected value).
    expect(message, raw).not.toContain("secret");
    expect(message, raw).not.toContain("cret");
    expect(message, raw).not.toContain("localhost");
    expect(message, raw).not.toContain("my api");
    expect(message, raw).not.toContain("ca.pem");
  }
});

it("rejects a percent-encoded connection-query parameter NAME", () => {
  const at = (query: string): string => `postgresql://iptv_app:p@localhost:5432/iptv?${query}`;
  for (const query of [
    "ssl%6dode=require", // decodes to sslmode
    "SSL%6dode=require",
    "ssl%6Dode=require",
    "application%5fname=api",
    "connect%5Ftimeout=5",
    // A percent-encoded control character in a NAME is caught here first: the
    // fix is the same (write the name literally), and it is still fail-closed.
    "application%00_name=api",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, query).toMatch(
      /must not percent-encode a connection-query parameter NAME/,
    );
    expect(message, query).not.toContain("localhost");
    expect(message, query).not.toContain("@");
  }
  // Percent-encoding remains legal for VALUES.
  for (const query of [
    "sslmode=require&application_name=my%20api",
    "sslrootcert=%2Fetc%2Fssl%2Fca.pem",
    "application_name=api%2Dv2",
  ]) {
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: at(query) }).APP_DATABASE_URL, query).toBe(at(query));
  }
});

it("accepts only the documented sslnegotiation values", () => {
  for (const value of ["postgres", "direct"]) {
    const raw = `postgresql://iptv_app:p@localhost:5432/iptv?sslnegotiation=${value}`;
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: raw }).APP_DATABASE_URL, value).toBe(raw);
  }
  for (const value of [
    "PREGRES",
    "Postgres",
    "DIRECT",
    "yes",
    "require",
    "postgres%20",
    "",
  ]) {
    expect(
      () =>
        loadConfig({
          ...productionBase,
          APP_DATABASE_URL: `postgresql://iptv_app:p@localhost:5432/iptv?sslnegotiation=${value}`,
        }),
      value,
    ).toThrow(/must set `sslnegotiation` to exactly "postgres" or "direct"/);
  }
});

it("never prints a rejected component value in an error", () => {
  for (const raw of [
    "postgresql://iptv_app:api%00user%00postgres@localhost:5432/iptv",
    "postgresql://iptv_app:p%zz@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv?application_name=api%00user%00postgres",
    "postgresql://iptv_app:p@localhost:5432/iptv?sslnegotiation=SECRET-VALUE",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).not.toBe("");
    expect(message).not.toContain("api%00user%00postgres");
    expect(message).not.toContain("p%zz");
    expect(message).not.toContain("SECRET-VALUE");
    expect(message).not.toContain("@localhost");
    expect(message).not.toContain("\u0000");
  }
  // Path and fragment rejections are equally value-free.
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/db%00secret",
    "postgresql://iptv_app:p@localhost:5432/iptv#secret-fragment",
  ]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).not.toBe("");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("@localhost");
  }
});

it("allows an ordinary PGAPPNAME and rejects ASCII control characters in it", () => {
  for (const ordinary of ["iptv-api", "iptv api", "api.production-1", ""]) {
    expect(() => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGAPPNAME: ordinary }), ordinary).not.toThrow();
  }
  for (const bad of ["api\u0000", "api\tname", "api\nname", "api\rname"]) {
    let message = "";
    try {
      loadConfig({ ...productionBase, APP_DATABASE_URL: APP, PGAPPNAME: bad });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, JSON.stringify(bad)).not.toBe("");
    expect(message).toMatch(/PGAPPNAME must not contain ASCII control characters/);
    expect(message).not.toContain(bad);
  }
});

it("keeps ordinary connection settings legal in a production APP URL", () => {
    const ok =
      "postgresql://iptv_app:s@localhost:5432/iptv?sslmode=verify-full&application_name=api&connect_timeout=5&target_session_attrs=read-write";
    expect(loadConfig({ ...productionBase, APP_DATABASE_URL: ok }).APP_DATABASE_URL).toBe(ok);
  });

  it("never prints the rejected override value in an error", () => {
    for (const raw of [
      "postgresql://iptv_app:s@localhost:5432/iptv?user=postgres",
      "postgresql://iptv_app:s@localhost:5432/iptv?role=owner",
      "postgresql://iptv_app:s@localhost:5432/iptv?options=-c%20role%3Downer",
    ]) {
      let message = "";
      try {
        loadConfig({ ...productionBase, APP_DATABASE_URL: raw });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, raw).not.toBe("");
      expect(message).not.toContain("role%3Downer");
      expect(message).not.toContain("postgres");
      expect(message).not.toContain("owner");
      expect(message).not.toContain("@localhost");
    }
  });

  it("never prints the connection value or its credentials in an error", () => {
    const secretUrl = "postgresql://iptv:sup3rs3cret@localhost:5432/iptv";
    for (const env of [
      { APP_DATABASE_URL: secretUrl },
      { APP_DATABASE_URL: "postgresql://iptv_app:sup3rs3cret@localhost:5432/iptv?user=postgres" },
      { APP_DATABASE_URL: ` ${secretUrl} ` },
      { DATABASE_URL: secretUrl },
    ]) {
      let message = "";
      try {
        loadConfig({ ...productionBase, ...env });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, JSON.stringify(Object.keys(env))).not.toBe("");
      expect(message).not.toContain("sup3rs3cret");
      expect(message).not.toContain(secretUrl);
      expect(message).not.toContain("@localhost");
    }
  });

  it("rejects every privileged/test database variable in the API process", () => {
    const ownerAliases = ["DATABASE_URL", "DATABASE_OWNER_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"] as const;
    const driverConsumed = [
      "PGPASSWORD",
      "PGOPTIONS",
      "PGHOST",
      "PGPORT",
      "PGDATABASE",
      "PGUSER",
      "PGSSLMODE",
      "PGSSLNEGOTIATION",
    ] as const;
    for (const key of [...ownerAliases, ...driverConsumed]) {
      // Rejected even when APP_DATABASE_URL is valid.
      expect(
        () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: OWNER }),
        key,
      ).toThrow(new RegExp(`${key} must NOT be present in the API process when NODE_ENV=production`));
      // Only an EMPTY string is absent for driver-consumed PG variables.
      expect(
        () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "" }),
        `${key} empty`,
      ).not.toThrow();
    }
    // Owner aliases keep the repo rule: whitespace-only counts as absent.
    for (const key of ownerAliases) {
      expect(
        () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "   " }),
        `${key} blank`,
      ).not.toThrow();
    }
    // Driver-consumed PG variables refuse whitespace-only.
    for (const key of driverConsumed) {
      expect(
        () => loadConfig({ ...productionBase, APP_DATABASE_URL: APP, [key]: "   " }),
        `${key} blank`,
      ).toThrow(new RegExp(`${key} must NOT be present`));
    }
  });

  it("keeps every privileged/test variable legal outside production", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      const env = {
        NODE_ENV: nodeEnv,
        DATABASE_URL: OWNER,
        DATABASE_OWNER_URL: OWNER,
        TEST_DATABASE_URL: TEST,
        POSTGRES_PASSWORD: "local-compose-password",
        PGPASSWORD: "local-pg-password",
        PGOPTIONS: "-c role=owner",
        PGHOST: "localhost",
        PGPORT: "5432",
        PGDATABASE: "iptv",
        PGUSER: "iptv",
        PGSSLMODE: "disable",
        PGSSLNEGOTIATION: "postgres",
        PGAPPNAME: "local dev",
      } satisfies NodeJS.ProcessEnv;
      // No identity validation outside production either: an owner URL is fine.
      expect(loadConfig(env).DATABASE_URL, nodeEnv).toBe(OWNER);
      expect(loadConfig({ ...env, APP_DATABASE_URL: OWNER }).APP_DATABASE_URL, nodeEnv).toBe(OWNER);
      expect(loadConfig(env).NODE_ENV, nodeEnv).toBe(nodeEnv);
    }
  });
});
