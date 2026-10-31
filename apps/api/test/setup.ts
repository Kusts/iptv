// Shared vitest bootstrap for `@iptv/api` (see `vitest.config.ts`).
//
// Production default for `AUTH_REGISTER_CLOSED` is fail-closed ("1"), but the
// pre-existing integration suite bootstraps the public `POST
// /v1/auth/register` endpoint as OPEN. Default the flag to open ONLY inside
// the test process so those files keep their byte-identical behavior without
// per-file edits; the dedicated `auth-register-closed` suite overrides it
// explicitly per app instance (closed, blank, invalid). This file must never
// set real credentials or touch the network.
if (process.env["AUTH_REGISTER_CLOSED"] === undefined) {
  process.env["AUTH_REGISTER_CLOSED"] = "0";
}
