/**
 * Activation gate — pure, no I/O. The worker must NOT start while the legacy
 * in-process drainer (API `OutboxDrainer`) can still publish: the legacy
 * drainer sets PUBLISHING with NO lease and completes by id alone (no CAS),
 * so coexistence could overwrite a fenced outcome and strand rows this worker
 * will never reclaim (reclaim requires a non-NULL lease). Fail-closed on
 * UNKNOWN: the API default is drain ENABLED, so an unset
 * `OUTBOX_LEGACY_DRAIN_ENABLED`/`OUTBOX_LEGACY_IN_FLIGHT` is treated as
 * "not proven disabled/empty", never as permission. The operator proves
 * quiescence out-of-band (`GET /v1/admin/outbox/drain-state` → copy the
 * observed `false`/`0` into the worker env) and this gate refuses to boot
 * unless every assertion is explicit.
 */

export class ActivationError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ActivationError";
    this.code = code;
  }
}

export interface ActivationInput {
  legacyQuiesced: boolean;
  legacyDrainEnabled: boolean | null;
  legacyInFlight: number | null;
}

export function checkActivationGate(input: ActivationInput): void {
  if (!input.legacyQuiesced) {
    throw new ActivationError(
      "LEGACY_QUIESCENCE_NOT_ASSERTED",
      "the operator has not asserted legacy drain quiescence (OUTBOX_LEGACY_QUIESCED must be 1)",
    );
  }
  if (input.legacyDrainEnabled === true) {
    throw new ActivationError(
      "LEGACY_DRAIN_STILL_ENABLED",
      "the legacy drainer is still enabled alongside the worker (OUTBOX_LEGACY_DRAIN_ENABLED must be 0)",
    );
  }
  if (input.legacyDrainEnabled === null) {
    throw new ActivationError(
      "LEGACY_DRAIN_STATE_UNKNOWN",
      "legacy drain state is unproven (set OUTBOX_LEGACY_DRAIN_ENABLED=0 from the observed drain-state, never assume the default)",
    );
  }
  if (input.legacyInFlight === null) {
    throw new ActivationError(
      "LEGACY_IN_FLIGHT_UNKNOWN",
      "legacy in-flight count is unproven (set OUTBOX_LEGACY_IN_FLIGHT=0 from the observed drain-state)",
    );
  }
  if (input.legacyInFlight > 0) {
    throw new ActivationError(
      "LEGACY_DRAIN_IN_FLIGHT",
      "a legacy drain holds unpublished rows (OUTBOX_LEGACY_IN_FLIGHT must be 0)",
    );
  }
}
