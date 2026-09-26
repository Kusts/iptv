import { z } from "zod";
import { newId } from "./ids.js";
import { nowIso } from "./time.js";

/**
 * Canonical domain-event envelope (W1-06).
 *
 * Field-for-field compatible with `docs/05-contracts/asyncapi/asyncapi.yaml`
 * `EventEnvelopeBase` plus the per-message `data` payload:
 * `event_id`, `event_type` (public id `<domain>.<noun>_<verb>.v1`),
 * `occurred_at`, `recorded_at`, `tenant_id`, `aggregate_type`,
 * `aggregate_id`, `aggregate_version` (>= 1), `correlation_id`,
 * optional `causation_id`, `actor { type, id }`, `schema_version` (const 1),
 * `data` (event-specific payload, object).
 *
 * `recorded_at` is set by the emitter when unknown (persistence fills the
 * authoritative `recorded_at` column); `occurred_at` is the domain fact time.
 */

export const ACTOR_TYPES = ["system", "agent", "human", "external"] as const;

export const actorSchema = z.object({
  type: z.enum(ACTOR_TYPES),
  id: z.string().nullable(),
});

export type EventActor = z.infer<typeof actorSchema>;

/** Public event id shape: `<domain>.<noun>_<verb>.v1` (registry-owned). */
const PUBLIC_EVENT_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+\.v1$/;

export const eventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().regex(PUBLIC_EVENT_ID_RE, "event_type must be a public id like <domain>.<noun>_<verb>.v1"),
  occurred_at: z.string().datetime({ offset: true }),
  recorded_at: z.string().datetime({ offset: true }),
  tenant_id: z.string().uuid(),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().uuid(),
  aggregate_version: z.number().int().min(1),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().nullable().optional(),
  actor: actorSchema,
  schema_version: z.literal(1),
  data: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export interface NewEnvelopeInput {
  event_type: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  data: Record<string, unknown>;
  actor: EventActor;
  correlation_id?: string;
  causation_id?: string | null;
  occurred_at?: string;
  recorded_at?: string;
  event_id?: string;
}

/**
 * Build a validated envelope, filling ids/timestamps defaults
 * (`schema_version` is always 1). Throws on invalid input.
 */
export function buildEnvelope(input: NewEnvelopeInput): EventEnvelope {
  const now = nowIso();
  return eventEnvelopeSchema.parse({
    event_id: input.event_id ?? newId(),
    event_type: input.event_type,
    occurred_at: input.occurred_at ?? now,
    recorded_at: input.recorded_at ?? now,
    tenant_id: input.tenant_id,
    aggregate_type: input.aggregate_type,
    aggregate_id: input.aggregate_id,
    aggregate_version: input.aggregate_version,
    correlation_id: input.correlation_id ?? newId(),
    causation_id: input.causation_id ?? null,
    actor: input.actor,
    schema_version: 1,
    data: input.data,
  });
}

/** Parse (and validate) an unknown value as an envelope — transport boundary. */
export function parseEnvelope(value: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(value);
}

/** Narrow `safeParse` for handlers that map failures to CommandResult. */
export function safeParseEnvelope(value: unknown): z.SafeParseReturnType<unknown, EventEnvelope> {
  return eventEnvelopeSchema.safeParse(value);
}
