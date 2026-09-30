/**
 * Package entry — re-exports the testable units. The CLI entry is `cli.ts`.
 * No HTTP server or sidecar bridge exists in this package by design.
 *
 * SINGLE-BINDING operator smoke: this package never accepts tenant/
 * account identity from callers and never serves requests. See README.
 */

export * from "./constants.js";
export * from "./config.js";
export * from "./policy.js";
export * from "./output.js";
export * from "./secrets.js";
export * from "./profileLock.js";
export { runReadIdentity, ensureProfileDir, extractIdentityField, identityEquals } from "./operations/readIdentity.js";
export type { ReadIdentityBrowser, ReadIdentityPage, ReadIdentityDeps } from "./operations/readIdentity.js";
export { buildIdentityUrl, isCrossOriginRedirect, redirectTargetOrigin } from "./browser.js";
