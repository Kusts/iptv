#!/usr/bin/env node
/**
 * Infisical smoke test (manual, operator-run with real credentials).
 *
 * Reads INFISICAL_SITE_URL / INFISICAL_PROJECT_ID / INFISICAL_CLIENT_ID /
 * INFISICAL_CLIENT_SECRET / INFISICAL_ENVIRONMENT from the environment,
 * performs a Universal Auth login, reads the `TEST_SECRET` secret and
 * prints ONLY "ok: secret presente, len=N" — NEVER the value.
 *
 * Usage:
 *   node packages/secrets/scripts/infisical-smoke.mjs [SECRET_KEY] [ENVIRONMENT]
 *   (defaults: TEST_SECRET, $INFISICAL_ENVIRONMENT or "development")
 */

const site = (process.env.INFISICAL_SITE_URL ?? "").trim().replace(/\/+$/, "");
const projectId = (process.env.INFISICAL_PROJECT_ID ?? "").trim();
const clientId = (process.env.INFISICAL_CLIENT_ID ?? "").trim();
const clientSecret = (process.env.INFISICAL_CLIENT_SECRET ?? "").trim();
const key = (process.argv[2] ?? "TEST_SECRET").trim();
const environment = (
  process.argv[3] ??
  (process.env.INFISICAL_ENVIRONMENT ?? "").trim() ??
  "development"
).trim() || "development";

if (!site || !projectId || !clientId || !clientSecret) {
  console.error(
    "smoke: missing env (need INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET)",
  );
  process.exit(2);
}
if (!key || key.includes("/") || /\s/.test(key)) {
  console.error("smoke: invalid secret key");
  process.exit(2);
}

function fail(message) {
  // Status codes / short labels only — never secret material.
  console.error(`smoke: ${message}`);
  process.exit(1);
}

let loginRes;
try {
  loginRes = await fetch(`${site}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
    signal: AbortSignal.timeout(8000),
  });
} catch {
  fail("login transport error");
}
if (loginRes.status === 401 || loginRes.status === 403) fail("login rejected (401/403)");
if (!loginRes.ok) fail(`login failed with status ${loginRes.status}`);

let loginBody = null;
try {
  loginBody = await loginRes.json();
} catch {
  fail("login response was not JSON");
}
const accessToken = loginBody?.accessToken;
if (typeof accessToken !== "string" || accessToken.length === 0) {
  fail("login response without access token");
}

const url =
  `${site}/api/v3/secrets/raw/${encodeURIComponent(key)}` +
  `?workspaceId=${encodeURIComponent(projectId)}` +
  `&environment=${encodeURIComponent(environment)}` +
  `&secretPath=${encodeURIComponent("/")}`;

let readRes;
try {
  readRes = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
} catch {
  fail("read transport error");
}
if (readRes.status === 404) fail(`secret ${JSON.stringify(key)} not found`);
if (!readRes.ok) fail(`read failed with status ${readRes.status}`);

let readBody = null;
try {
  readBody = await readRes.json();
} catch {
  fail("read response was not JSON");
}
const value = readBody?.secret?.secretValue;
if (typeof value !== "string") fail("read response without secret value");

console.log(`ok: secret presente, len=${value.length}`);
