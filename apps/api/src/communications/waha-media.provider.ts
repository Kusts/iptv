import { wahaMediaPortFromEnv, type WahaMediaPort } from "./waha-media.js";

/**
 * `WAHA_MEDIA_PORT` provider (EXEC-WAHA-MEDIA-WIRING-20261020).
 *
 * Builds the HTTP media port from `WAHA_BASE_URL` + `WAHA_API_KEY` via
 * `wahaMediaPortFromEnv` (fail-closed when either is absent/blank/unparsable:
 * empty allowlist, every download refused — identical to the previous
 * no-provider default). The webhook service keeps its `@Optional()` inject +
 * `?? defaultWahaMediaPort()` fallback, so tests injecting doubles and
 * runtimes without the provider are unaffected.
 *
 * The key is used verbatim as the `X-Api-Key` header value only; it is never
 * logged here (only its presence changes the selected port).
 */
export const WahaMediaPortProvider = {
  provide: "WAHA_MEDIA_PORT",
  useFactory: (): WahaMediaPort => wahaMediaPortFromEnv(),
};
