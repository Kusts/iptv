import { describe, expect, it } from "vitest";
import { resolveAppConnectionString } from "../src/app.module.js";

const OWNER = "postgresql://iptv:iptv@localhost:5432/iptv";
const APP = "postgresql://iptv_app:secret@localhost:5432/iptv";
const TEST = "postgresql://iptv:iptv@localhost:5432/iptv_test";

describe("resolveAppConnectionString (RLS cutover)", () => {
  it("prefers APP_DATABASE_URL when set", () => {
    expect(
      resolveAppConnectionString({
        APP_DATABASE_URL: APP,
        DATABASE_URL: OWNER,
        TEST_DATABASE_URL: TEST,
      } as NodeJS.ProcessEnv),
    ).toBe(APP);
  });

  it("falls back to DATABASE_URL when APP_DATABASE_URL is unset", () => {
    expect(
      resolveAppConnectionString({
        DATABASE_URL: OWNER,
        TEST_DATABASE_URL: TEST,
      } as NodeJS.ProcessEnv),
    ).toBe(OWNER);
  });

  it("treats an empty APP_DATABASE_URL as unset", () => {
    expect(
      resolveAppConnectionString({
        APP_DATABASE_URL: "",
        DATABASE_URL: OWNER,
      } as NodeJS.ProcessEnv),
    ).toBe(OWNER);
  });

  it("falls back to TEST_DATABASE_URL when neither APP nor DATABASE is set", () => {
    expect(
      resolveAppConnectionString({ TEST_DATABASE_URL: TEST } as NodeJS.ProcessEnv),
    ).toBe(TEST);
  });

  it("returns null when no connection string is set", () => {
    expect(resolveAppConnectionString({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

/**
 * Production has no fallback: the API pool requires the restricted app-role
 * URL and fails closed otherwise, even when this factory runs without
 * `loadConfig` having validated the env first.
 */
describe("resolveAppConnectionString (NODE_ENV=production)", () => {
  const production = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    NODE_ENV: "production",
    ...env,
  });

  it("selects APP_DATABASE_URL when both fallbacks are absent", () => {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP }))).toBe(APP);
  });

  it("returns an accepted iptv_app value byte-exact", () => {
    const full = "postgresql://iptv_app:p%40ss-w0rd@db.internal:5432/iptv?sslmode=verify-full&application_name=api";
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: full }))).toBe(full);
    const withEncodedSpace = "postgresql://iptv_app:se%20cret@localhost:5432/iptv";
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: withEncodedSpace }))).toBe(withEncodedSpace);
  });

  it("rejects any authority username other than exactly iptv_app", () => {
    for (const raw of [
      OWNER, // iptv (owner)
      "postgresql://postgres:postgres@localhost:5432/iptv",
      "postgresql://IPTV_APP:s@localhost:5432/iptv",
      "postgresql://iptv%5Fapp:s@localhost:5432/iptv",
      "postgresql://iptv_app2:s@localhost:5432/iptv",
      "postgresql://localhost:5432/iptv",
    ]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), raw).toThrow(
        /must carry exactly "iptv_app" as the URI authority username/,
      );
    }
  });

  it("rejects a malformed or non-PostgreSQL URI", () => {
    for (const raw of [
      "//iptv_app:s@localhost/iptv",
      "mysql://iptv_app:s@localhost:3306/iptv",
      "http://iptv_app:s@localhost:5432/iptv",
      "file:///var/run/postgresql/iptv",
    ]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), raw).toThrow(
        /must (be a parseable PostgreSQL connection URI|use a PostgreSQL scheme \(pg:\/\/.*\))/,
      );
    }
  });

  it("rejects user/role/options query parameters that alter the session identity", () => {
    for (const raw of [
      "postgresql://iptv_app:s@localhost:5432/iptv?user=postgres",
      "postgresql://iptv_app:s@localhost:5432/iptv?USER=iptv_app",
      "postgresql://iptv_app:s@localhost:5432/iptv?User=x",
      "postgresql://iptv_app:s@localhost:5432/iptv?role=owner",
      "postgresql://iptv_app:s@localhost:5432/iptv?ROLE=owner",
      "postgresql://iptv_app:s@localhost:5432/iptv?Role=owner",
      "postgresql://iptv_app:s@localhost:5432/iptv?options=-c%20role%3Downer",
      "postgresql://iptv_app:s@localhost:5432/iptv?OPTIONS=-c%20role%3Downer",
      "postgresql://iptv_app:s@localhost:5432/iptv?Options=-c%20role=owner&sslmode=require",
    ]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), raw).toThrow(
        /must not carry a `(user|role|options)` query parameter/,
      );
    }
  });

  it("rejects ASCII control characters anywhere in a production APP URL", () => {
    // Checked BEFORE `new URL`, which silently strips tab/LF/CR.
    const base = "postgresql://iptv_app:s@localhost:5432/iptv";
    for (const raw of [
      `postgresql://iptv_app:s@local\thost:5432/iptv`,
      `${base}\n`,
      `${base}\r`,
      `postgresql://iptv_app:s@localhost:5432/iptv?user${"\t"}=postgres`,
      `postgresql://iptv_app:s@localhost:5432/iptv${"\u0000"}`,
      `postgresql://iptv_app:s@localhost:5432/iptv${"\u001F"}`,
    ]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: raw }))).toThrow(
        /APP_DATABASE_URL must not contain ASCII control characters/,
      );
    }
    let message = "";
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: `postgresql://iptv_app:s@h/iptv\n?user=postgres` }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("@h");
    expect(message).not.toContain("\n");
  });

  it("refuses PGOPTIONS in the API process (it feeds driver startup options)", () => {
    expect(() =>
      resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGOPTIONS: "-c role=owner" })),
    ).toThrow(/PGOPTIONS must NOT be present in the API process when NODE_ENV=production/);
    // Driver-consumed: whitespace-only is a supplied setting, so it is refused;
    // only an empty string is absent.
    expect(() =>
      resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGOPTIONS: "   " })),
    ).toThrow(/PGOPTIONS must NOT be present/);
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGOPTIONS: "" }))).toBe(APP);
    // Legal outside production.
    expect(
      resolveAppConnectionString({ NODE_ENV: "development", APP_DATABASE_URL: APP, PGOPTIONS: "-c role=owner" }),
    ).toBe(APP);
  });

  it("rejects percent-encoded ASCII controls and malformed escapes in URI components", () => {
  for (const raw of [
    "postgresql://iptv_app:api%00user%00postgres@localhost:5432/iptv",
    "postgresql://iptv_app:p%09tab@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv?application_name=api%00user%00postgres",
    "postgresql://iptv_app:p%zz@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv?%zz=1",
  ]) {
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), raw).toThrow(
      /unsafe URI (username|password|query string)|decoded (key|value) contains an ASCII control character|malformed percent escapes/,
    );
  }
});

it("rejects percent-encoded controls and malformed escapes in the database path, and any fragment", () => {
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/db%00x",
    "postgresql://iptv_app:p@localhost:5432/db%09x",
    "postgresql://iptv_app:p@localhost:5432/db%2",
    "postgresql://iptv_app:p@localhost:5432/db%zz",
  ]) {
    let message = "";
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/unsafe URI database path/);
    expect(message).not.toContain("@localhost");
  }
  for (const raw of [
    "postgresql://iptv_app:p@localhost:5432/iptv#fragment",
    "postgresql://iptv_app:p@localhost:5432/iptv#user=postgres",
    // Fail-closed: a bare trailing `#` has an EMPTY url.hash and is refused too.
    "postgresql://iptv_app:p@localhost:5432/iptv#",
  ]) {
    let message = "";
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/must not contain a URI fragment delimiter/);
    expect(message).not.toContain("postgres");
    expect(message).not.toContain("@localhost");
  }
  // A plain database name is untouched, and an encoded `%23` inside a component
  // is ordinary encoded data rather than a delimiter.
  for (const ok of [
    "postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require",
    "postgresql://iptv_app:p%23cret@localhost:5432/iptv",
    "postgresql://iptv_app:p@localhost:5432/iptv%23?sslmode=require",
  ]) {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: ok })), ok).toBe(ok);
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
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(/unsafe URI hostname/);
    expect(message).not.toContain("evil");
    expect(message).not.toContain("p@");
  }
});

it("accepts only the documented sslnegotiation values and keeps safe settings byte-exact", () => {
  for (const value of ["postgres", "direct"]) {
    const raw = `postgresql://iptv_app:p%20space@localhost:5432/iptv?sslnegotiation=${value}&sslmode=require`;
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), value).toBe(raw);
  }
  for (const value of ["PREGRES", "Direct", "yes", "postgres%20"]) {
    let message = "";
    try {
      resolveAppConnectionString(
        production({ APP_DATABASE_URL: `postgresql://iptv_app:p@localhost:5432/iptv?sslnegotiation=${value}` }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, value).toMatch(/must set `sslnegotiation` to exactly "postgres" or "direct"/);
    expect(message).not.toContain(value === "postgres%20" ? "postgres " : value);
  }
});

it("applies the same SSL, duplicate-parameter and pg:// scheme rules as loadConfig", () => {
  const at = (query: string, scheme = "postgresql"): string =>
    `${scheme}://iptv_app:s3cret@localhost:5432/iptv${query === "" ? "" : `?${query}`}`;
  const messageFor = (raw: string): string => {
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // pg:// is a supported scheme.
  for (const scheme of ["pg", "postgres", "postgresql"]) {
    const raw = at("sslmode=require", scheme);
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), scheme).toBe(raw);
  }
  // Repeated keys are refused, case-insensitively, before parsing.
  for (const query of [
    "sslmode=require&sslmode=disable",
    "sslmode=require&SSLMODE=verify-full",
    "ssl=true&SSL=false",
  ]) {
    const message = messageFor(at(query));
    expect(message, query).toMatch(/must not repeat a query parameter/);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("@localhost");
  }
  // Invalid ssl / sslmode / uselibpqcompat values, with no value echoed.
  expect(messageFor(at("ssl=BOGUS"))).toMatch(/must set `ssl` to exactly one of: true, 1, 0/);
  expect(messageFor(at("sslmode=BOGUS-MODE"))).toMatch(/must set `sslmode` to one of:/);
  expect(messageFor(at("uselibpqcompat=maybe"))).toMatch(/must set `uselibpqcompat` to exactly true or false/);
  expect(messageFor(at("sslmode=allow"))).toMatch(/allow requires uselibpqcompat=true\)/);
  expect(messageFor(at("sslmode=no-verify&uselibpqcompat=true"))).toMatch(
    /allow is available and no-verify is not\)/,
  );
  // Conflicting / impossible combinations.
  expect(messageFor(at("ssl=true&sslmode=require"))).toMatch(/must not set both `ssl` and `sslmode`/);
  for (const disable of ["ssl=0", "sslmode=disable"]) {
    for (const certificate of ["sslrootcert=%2Fca.pem", "sslcert=%2Fclient.pem", "sslkey=%2Fclient.key", "sslrootcert=%20%20"]) {
      const message = messageFor(at(`${disable}&${certificate}`));
      expect(message, `${disable}&${certificate}`).toMatch(/must not combine explicit TLS disable/);
      expect(message).not.toContain("client.key");
      expect(message).not.toContain("localhost");
    }
  }
  expect(messageFor(at("sslnegotiation=direct&sslmode=disable"))).toMatch(
    /must not set `sslnegotiation=direct` while TLS is explicitly disabled/,
  );
  expect(messageFor(at("sslnegotiation=direct&ssl=0"))).toMatch(
    /must not set `sslnegotiation=direct` while TLS is explicitly disabled/,
  );
  // Legal matrices stay byte-exact; TLS is not required globally.
  for (const query of [
    "ssl=true",
    "ssl=0",
    "sslmode=disable",
    "sslmode=verify-ca",
    "sslmode=allow&uselibpqcompat=true",
    "sslmode=no-verify",
    "sslnegotiation=direct&sslmode=require",
    "sslnegotiation=postgres&sslmode=disable",
  ]) {
    const raw = at(query);
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), query).toBe(raw);
  }
});

it("applies the Debugger-corrected pg semantics on the same shared guard", () => {
  const at = (query: string): string =>
    `postgresql://iptv_app:s3cret@localhost:5432/iptv${query === "" ? "" : `?${query}`}`;
  const messageFor = (raw: string): string => {
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // (1) Canonical lowercase query keys.
  for (const query of ["SSLMODE=require", "SslMode=require", "APPLICATION_NAME=api"]) {
    expect(messageFor(at(query)), query).toMatch(/must use canonical lowercase connection-query keys/);
  }
  // Forbidden keys still rejected case-insensitively.
  expect(messageFor(at("USER=postgres"))).toMatch(/must not carry a `user` query parameter/);

  // (2) `ssl=false` refused (truthy string in the installed parser); 0/disable direct.
  expect(messageFor(at("ssl=false"))).toMatch(/must not set `ssl=false`/);
  expect(messageFor(at("ssl=false"))).toMatch(/use `ssl=0` or `sslmode=disable`/);
  for (const query of ["ssl=true", "ssl=1", "ssl=0", "sslmode=disable"]) {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: at(query) })), query).toBe(at(query));
  }

  // (3) Only libpq-compat `verify-ca` requires a nonblank sslrootcert; `verify-full`
  // uses `{}` (system CA + identity verification) and stays legal without one.
  const missingRoot = at("sslmode=verify-ca&uselibpqcompat=true");
  expect(messageFor(missingRoot)).toMatch(
    /must carry a non-blank `sslrootcert` value together with `sslmode=verify-ca` under uselibpqcompat=true/,
  );
  expect(messageFor(missingRoot)).toMatch(/does not verify that the certificate file is readable or valid on the server/);
  const withRoot = at("sslmode=verify-ca&uselibpqcompat=true&sslrootcert=%2Fca.pem");
  expect(resolveAppConnectionString(production({ APP_DATABASE_URL: withRoot }))).toBe(withRoot);
  for (const query of [
    "sslmode=verify-full&uselibpqcompat=true",
    "sslmode=verify-full&uselibpqcompat=false",
    "sslmode=verify-full",
    "sslmode=verify-ca&uselibpqcompat=false",
    "sslmode=verify-ca",
  ]) {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: at(query) })), query).toBe(at(query));
  }

  // (4) Driver-consumed PG variables: whitespace-only is refused, empty is absent.
  for (const key of [
    "PGPASSWORD",
    "PGOPTIONS",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGSSLMODE",
    "PGSSLNEGOTIATION",
  ]) {
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "   " })), key).toThrow(
      new RegExp(`${key} must NOT be present`),
    );
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "" })), key).toBe(APP);
  }
  // Owner aliases keep the repo blank rule; PGAPPNAME stays allowed.
  for (const key of ["DATABASE_URL", "DATABASE_OWNER_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"]) {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "   " })), key).toBe(APP);
  }
  expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGAPPNAME: "iptv api" }))).toBe(APP);

  // No rejected value, credential or host is ever echoed.
  for (const query of ["ssl=false", "SSLMODE=require", "sslmode=verify-ca&uselibpqcompat=true"]) {
    const message = messageFor(at(query));
    expect(message, query).not.toContain("s3cret");
    expect(message, query).not.toContain("@localhost");
  }

  // Dev/test unchanged: mixed-case keys and PG variables stay legal there.
  for (const nodeEnv of ["development", "test"] as const) {
    expect(
      resolveAppConnectionString({ NODE_ENV: nodeEnv, APP_DATABASE_URL: at("SSLMODE=require") }),
      nodeEnv,
    ).toBe(at("SSLMODE=require"));
    expect(resolveAppConnectionString({ NODE_ENV: nodeEnv, APP_DATABASE_URL: APP, PGHOST: "localhost" }), nodeEnv).toBe(
      APP,
    );
  }
});

it("rejects a literal space and a percent-encoded query NAME, and keeps encoded values", () => {
  const at = (query: string): string =>
    `postgresql://iptv_app:s3cret@localhost:5432/iptv${query === "" ? "" : `?${query}`}`;
  const messageFor = (raw: string): string => {
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // (1) A literal space anywhere: the installed driver rewrites such a URI, so
  // the driver and this validator could disagree. `%20` is required instead.
  for (const raw of [
    "not a uri",
    "postgresql://iptv_app:s3c ret@localhost:5432/iptv",
    "postgresql://iptv_app:s3cret@local host:5432/iptv",
    "postgresql://iptv_app:s3cret@localhost:5432/ip tv",
    "postgresql://iptv_app:s3cret@localhost:5432/iptv?application_name=my api",
  ]) {
    const message = messageFor(raw);
    expect(message, raw).toMatch(/must not contain a literal space/);
    expect(message, raw).toMatch(/percent-encode it as %20/);
    // No URL, password, host or value leaked.
    expect(message, raw).not.toContain("s3cret");
    expect(message, raw).not.toContain("cret");
    expect(message, raw).not.toContain("localhost");
    expect(message, raw).not.toContain("my api");
  }

  // (2) Percent-encoded parameter NAMES are refused (values may stay encoded).
  for (const query of [
    "ssl%6dode=require",
    "SSL%6dode=require",
    "application%5fname=api",
    // A percent-encoded control character in a NAME is caught here first: the
    // fix is the same (write the name literally), and it is still fail-closed.
    "application%00_name=api",
  ]) {
    const message = messageFor(at(query));
    expect(message, query).toMatch(/must not percent-encode a connection-query parameter NAME/);
    expect(message, query).not.toContain("s3cret");
    expect(message, query).not.toContain("localhost");
  }
  // Encoded values and `pg://` stay legal, byte-exact.
  for (const raw of [
    at("sslmode=require&application_name=my%20api"),
    at("sslrootcert=%2Fetc%2Fssl%2Fca.pem"),
    "pg://iptv_app:s3c%20ret@localhost:5432/iptv?sslmode=require",
    "postgresql://iptv_app:s3cret@localhost:5432/iptv?application_name=api%2Dv2",
  ]) {
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: raw })), raw).toBe(raw);
  }

  // Dev/test stays byte-exact: literal spaces and encoded names are untouched there.
  for (const raw of [
    "postgresql://iptv_app:s3c ret@localhost:5432/iptv",
    at("ssl%6dode=require"),
  ]) {
    expect(resolveAppConnectionString({ NODE_ENV: "development", APP_DATABASE_URL: raw }), raw).toBe(raw);
    expect(resolveAppConnectionString({ NODE_ENV: "test", APP_DATABASE_URL: raw }), raw).toBe(raw);
  }
});

it("requires an explicit host and database name, and refuses target query overrides", () => {
  for (const raw of [
    "postgresql://iptv_app:p@localhost",
    "postgresql://iptv_app:p@localhost/",
    "postgresql://iptv_app:p@localhost:5432",
    "postgresql:/iptv",
    "postgres:////", // scheme only: no authority and no path
  ]) {
    let message = "";
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, raw).toMatch(
      /must carry an explicit (host in the URI authority|database name in the URI path)/,
    );
    expect(message).not.toContain("@localhost");
  }
  for (const param of ["host", "PORT", "database", "DB", "dbname"]) {
    const raw = `postgresql://iptv_app:p@localhost:5432/iptv?sslmode=require&${param}=other`;
    let message = "";
    try {
      resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, param).toContain(`must not carry a \`${param.toLowerCase()}\` query parameter`);
    expect(message).not.toContain("other");
  }
  // A fully stated target is accepted byte-exact.
  const ok = "postgresql://iptv_app:p@db.internal:5432/iptv?sslmode=require&application_name=api";
  expect(resolveAppConnectionString(production({ APP_DATABASE_URL: ok }))).toBe(ok);
});

it("refuses ambient libpq target variables but keeps them legal outside production", () => {
  const ambient = {
    PGHOST: "localhost",
    PGPORT: "5432",
    PGDATABASE: "iptv",
    PGUSER: "iptv",
    PGSSLMODE: "disable",
    PGSSLNEGOTIATION: "postgres",
  } as const;
  for (const key of Object.keys(ambient)) {
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: ambient[key as keyof typeof ambient] })), key).toThrow(
      new RegExp(`${key} must NOT be present in the API process when NODE_ENV=production`),
    );
    // Only an empty string is absent for driver-consumed PG variables.
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "  " })), key).toThrow(
      new RegExp(`${key} must NOT be present`),
    );
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "" })), key).toBe(APP);
  }
  expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGAPPNAME: "iptv-api" }))).toBe(APP);
  // Development/test are untouched, including target-less local URLs.
  for (const nodeEnv of ["development", "test"] as const) {
    expect(
      resolveAppConnectionString({ NODE_ENV: nodeEnv, APP_DATABASE_URL: APP, ...ambient }),
      nodeEnv,
    ).toBe(APP);
    expect(resolveAppConnectionString({ NODE_ENV: nodeEnv, DATABASE_URL: OWNER }), nodeEnv).toBe(OWNER);
  }
});

it("screens PGAPPNAME without banning ordinary application names", () => {
  expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGAPPNAME: "iptv api" }))).toBe(APP);
  let message = "";
  try {
    resolveAppConnectionString(production({ APP_DATABASE_URL: APP, PGAPPNAME: "api\u0000name" }));
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message).toMatch(/PGAPPNAME must not contain ASCII control characters/);
  expect(message).not.toContain("api\u0000name");
});

it("keeps ordinary connection settings legal and never prints the override value", () => {
    const ok =
      "postgresql://iptv_app:s@localhost:5432/iptv?sslmode=verify-full&application_name=api&connect_timeout=5";
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: ok }))).toBe(ok);
    for (const raw of [
      "postgresql://iptv_app:s3cret@localhost:5432/iptv?options=-c%20role%3Downer",
      "postgresql://iptv_app:s3cret@localhost:5432/iptv?role=owner",
    ]) {
      let message = "";
      try {
        resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, raw).not.toBe("");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("owner");
      expect(message).not.toContain("@localhost");
    }
  });

  it("never prints the connection value or its credentials in an error", () => {
    for (const raw of [
      "postgresql://iptv:sup3rs3cret@localhost:5432/iptv",
      "postgresql://iptv_app:sup3rs3cret@localhost:5432/iptv?user=postgres",
      " ` postgresql://iptv_app:s@localhost:5432/iptv ` ",
    ]) {
      let message = "";
      try {
        resolveAppConnectionString(production({ APP_DATABASE_URL: raw }));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("sup3rs3cret");
      expect(message).not.toContain(raw.trim());
      expect(message).not.toContain("@localhost");
    }
  });

  it("never resolves to a privileged string in production, even with a valid APP value", () => {
    // The app role still wins selection when only APP is set...
    expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP }))).toBe(APP);
    // ...but a privileged var in the API env is refused outright rather than
    // silently ignored, so the owner/test string is never reachable.
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, DATABASE_URL: OWNER }))).toThrow(
      /DATABASE_URL must NOT be present in the API process/,
    );
    expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, TEST_DATABASE_URL: TEST }))).toThrow(
      /TEST_DATABASE_URL must NOT be present in the API process/,
    );
    expect(() => resolveAppConnectionString(production({ DATABASE_URL: OWNER }))).toThrow(
      /DATABASE_URL must NOT be present in the API process/,
    );
  });

  it("fails closed when APP_DATABASE_URL is missing, blank, or a privileged var is present", () => {
    // The shared `@iptv/config` guard is the SAME one `loadConfig` runs, so the
    // pool factory cannot drift from boot validation: a privileged env var is
    // rejected even with a valid APP_DATABASE_URL, and a missing/blank APP
    // never falls back to an owner or test string.
    for (const env of [
      {},
      { DATABASE_URL: OWNER },
      { TEST_DATABASE_URL: TEST },
      { DATABASE_URL: OWNER, TEST_DATABASE_URL: TEST },
      { APP_DATABASE_URL: "" },
      { APP_DATABASE_URL: "", DATABASE_URL: OWNER },
      { APP_DATABASE_URL: "   " },
      { APP_DATABASE_URL: APP, TEST_DATABASE_URL: TEST },
      { APP_DATABASE_URL: APP, POSTGRES_PASSWORD: "compose-password" },
      { APP_DATABASE_URL: APP, PGPASSWORD: "pg-password" },
      { APP_DATABASE_URL: APP, PGOPTIONS: "-c role=owner" },
    ]) {
      expect(() => resolveAppConnectionString(production(env)), JSON.stringify(env)).toThrow(
        /invalid environment configuration: (APP_DATABASE_URL|DATABASE_URL|DATABASE_OWNER_URL|TEST_DATABASE_URL|POSTGRES_PASSWORD|PGPASSWORD|PGOPTIONS) must/,
      );
    }
  });

  it("applies the two distinct presence rules in production", () => {
    // Owner aliases keep the repo blank-means-absent rule.
    for (const key of ["DATABASE_URL", "DATABASE_OWNER_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"]) {
      expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "   " })), key).toBe(APP);
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "x" })), key).toThrow(
        new RegExp(`${key} must NOT be present`),
      );
    }
    // Driver-consumed PG variables: whitespace-only is refused, empty is absent.
    for (const key of ["PGPASSWORD", "PGOPTIONS", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGSSLNEGOTIATION"]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "   " })), key).toThrow(
        new RegExp(`${key} must NOT be present`),
      );
      expect(resolveAppConnectionString(production({ APP_DATABASE_URL: APP, [key]: "" })), key).toBe(APP);
    }
  });

  it("rejects a padded APP_DATABASE_URL in production instead of trimming it", () => {
    for (const padded of [` ${APP}`, `${APP} `, ` ${APP} `, `  ${APP}  `]) {
      expect(() => resolveAppConnectionString(production({ APP_DATABASE_URL: padded })), JSON.stringify(padded)).toThrow(
        /APP_DATABASE_URL must not have leading or trailing whitespace when NODE_ENV=production/,
      );
    }
  });

  it("returns a padded APP_DATABASE_URL unchanged outside production", () => {
    // Development/test precedence is untouched: the value is used verbatim,
    // never trimmed — same as before this guard existed.
    for (const nodeEnv of ["development", "test"] as const) {
      expect(
        resolveAppConnectionString({ NODE_ENV: nodeEnv, APP_DATABASE_URL: ` ${APP} `, DATABASE_URL: OWNER }),
      ).toBe(` ${APP} `);
    }
  });

  it("keeps the development/test precedence unchanged", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      const base = { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv;
      expect(resolveAppConnectionString({ ...base, APP_DATABASE_URL: APP, DATABASE_URL: OWNER, TEST_DATABASE_URL: TEST })).toBe(APP);
      expect(resolveAppConnectionString({ ...base, APP_DATABASE_URL: "", DATABASE_URL: OWNER })).toBe(OWNER);
      expect(resolveAppConnectionString({ ...base, DATABASE_URL: OWNER, TEST_DATABASE_URL: TEST })).toBe(OWNER);
      expect(resolveAppConnectionString({ ...base, TEST_DATABASE_URL: TEST })).toBe(TEST);
      expect(resolveAppConnectionString(base)).toBeNull();
    }
  });

  it("keeps privileged vars and owner URLs legal outside production", () => {
    for (const nodeEnv of ["development", "test"] as const) {
      const env = {
        NODE_ENV: nodeEnv,
        DATABASE_URL: OWNER,
        DATABASE_OWNER_URL: OWNER,
        TEST_DATABASE_URL: TEST,
        POSTGRES_PASSWORD: "local-compose-password",
        PGPASSWORD: "local-pg-password",
        PGOPTIONS: "-c role=owner",
      } satisfies NodeJS.ProcessEnv;
      // No identity validation outside production: an owner URL is a valid pick.
      expect(resolveAppConnectionString(env), nodeEnv).toBe(OWNER);
      expect(resolveAppConnectionString({ ...env, APP_DATABASE_URL: OWNER }), nodeEnv).toBe(OWNER);
      expect(resolveAppConnectionString({ ...env, APP_DATABASE_URL: "not a uri" }), nodeEnv).toBe("not a uri");
    }
  });
});
