import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId, type CommandActor } from "@iptv/domain";
import { recordCommandExecuted, withSpan } from "@iptv/observability";
import { CommandBus } from "../commands/command-bus.js";
import { OutboxDrainer } from "../outbox/outbox-drainer.js";
import { WahaWebhookService } from "../communications/waha-webhook.service.js";
import { AsaasWebhookService } from "../billing/asaas-webhook.service.js";

/**
 * W1-08 in-process scheduler (opt-in; OFF by default).
 *
 * Enabled only with `API_SCHEDULER_ENABLED=1` (tick every
 * `API_SCHEDULER_TICK_SECONDS`, default 60). After app bootstrap `main.ts`
 * calls `start()`, which arms a `setInterval` loop; `OnModuleDestroy`
 * clears it (graceful shutdown — a worker/scheduler crash or stop never
 * touches the API critical path, which shares no state with the loop
 * beyond the database).
 *
 * Each tick:
 * 1. runs the worker-eligible `*_due` commands per tenant that actually
 *    has due rows (platform-level due-scan; the commands themselves stay
 *    tenant-scoped — tenant id comes from the scan row, never from input),
 * 2. drains deferred webhook rows (`?defer=1` leftovers via both
 *    `drainPending` entry points),
 * 3. drains the outbox LAST (small limit) so events emitted by steps 1–2
 *    converge in the same tick.
 *
 * Failure isolation: every task is wrapped in its own try/catch with a
 * structured error log — one failing task never kills the loop or skips
 * the remaining tasks of the same tick.
 *
 * All `*_due` commands are idempotent by design, so overlapping or
 * repeated ticks are safe (second tick after convergence is a no-op).
 */

const WORKER_COMMANDS = [
  "trial.expire_due",
  "order.expire_due",
  "charge.expire_due",
  "renewal.reminders_due",
  "renewal.expire_overdue_due",
  "subscription.expire_cycles_due",
  "fulfillment.retry_due",
] as const;

export interface SchedulerCommandCounts {
  ok: number;
  failed: number;
}

export interface SchedulerTickResult {
  ranAt: string;
  enabled: boolean;
  outbox: { claimed: number; published: number; failed: number };
  tenants: number;
  commands: Record<string, SchedulerCommandCounts>;
  webhooks: {
    waha: { processed: number; failed: number };
    asaas: { processed: number; failed: number };
  };
  errors: string[];
}

function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["API_SCHEDULER_ENABLED"] === "1";
}

function tickSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["API_SCHEDULER_TICK_SECONDS"]);
  if (!Number.isFinite(raw)) {
    return 60;
  }
  return Math.min(Math.max(Math.floor(raw), 5), 3600);
}

function schedulerActor(tenantId: string): CommandActor {
  return {
    userId: "scheduler",
    isPlatformAdmin: true,
    tenantId,
    roleKeys: [],
    permissions: [],
    actorType: "system",
  };
}

@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Inject(OutboxDrainer) private readonly outbox: OutboxDrainer,
    @Inject(WahaWebhookService) private readonly waha: WahaWebhookService,
    @Inject(AsaasWebhookService) private readonly asaas: AsaasWebhookService,
  ) {}

  isEnabled(): boolean {
    return schedulerEnabled();
  }

  tickSeconds(): number {
    return tickSeconds();
  }

  /** Arm the interval loop (called from `main.ts` after bootstrap). */
  start(): void {
    if (!this.isEnabled()) {
      this.logger.log("scheduler is disabled (API_SCHEDULER_ENABLED!=1)");
      return;
    }
    if (this.timer !== null) {
      return;
    }
    const ms = this.tickSeconds() * 1000;
    this.logger.log(`scheduler starting (tick every ${this.tickSeconds()}s)`);
    this.timer = setInterval(() => {
      void this.tickGuarded();
    }, ms);
    this.timer.unref?.();
  }

  /** Clear the interval loop (idempotent; also runs on module destroy). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.log("scheduler stopped");
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private async tickGuarded(): Promise<void> {
    if (this.tickInFlight) {
      this.logger.warn("scheduler tick skipped: previous tick still running");
      return;
    }
    this.tickInFlight = true;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`scheduler tick crashed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.tickInFlight = false;
    }
  }

  async tick(): Promise<SchedulerTickResult> {
    const result: SchedulerTickResult = {
      ranAt: new Date().toISOString(),
      enabled: this.isEnabled(),
      outbox: { claimed: 0, published: 0, failed: 0 },
      tenants: 0,
      commands: {},
      webhooks: {
        waha: { processed: 0, failed: 0 },
        asaas: { processed: 0, failed: 0 },
      },
      errors: [],
    };
    if (this.db === null) {
      result.errors.push("database is not configured");
      return result;
    }
    for (const name of WORKER_COMMANDS) {
      result.commands[name] = { ok: 0, failed: 0 };
    }

    // Due commands first (they emit domain events → outbox rows), deferred
    // webhook drains next (their normalize stage emits too), and the outbox
    // drain LAST so one tick converges instead of leaving fresh PENDING
    // rows for the next tick.
    const tenants = await this.scanDueTenants(result);
    result.tenants = tenants.length;
    for (const tenantId of tenants) {
      for (const name of WORKER_COMMANDS) {
        await this.runTask(result, `${name}@${tenantId}`, async () => {
          const outcome = await withSpan(
            `scheduler.${name}`,
            { command: name, tenant: tenantId },
            async () => this.bus.execute(schedulerActor(tenantId), name, { limit: 100 }, { correlationId: newId() }),
          );
          const counts = result.commands[name] as SchedulerCommandCounts;
          if (outcome.ok) {
            counts.ok += 1;
          } else {
            counts.failed += 1;
          }
          recordCommandExecuted(name, outcome.ok ? "ok" : outcome.code);
        });
      }
    }

    await this.runTask(result, "webhook.waha.drainPending", async () => {
      result.webhooks.waha = await this.waha.drainPending(25);
    });
    await this.runTask(result, "webhook.asaas.drainPending", async () => {
      result.webhooks.asaas = await this.asaas.drainPending(25);
    });
    await this.runTask(result, "outbox.drain", async () => {
      result.outbox = await this.outbox.drain(25);
    });
    return result;
  }

  /** One task, isolated: failure is recorded + logged, never rethrown. */
  private async runTask(result: SchedulerTickResult, task: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${task}: ${message}`);
      this.logger.error(JSON.stringify({ task, error: message }));
    }
  }

  /**
   * Platform-level due-scan: distinct tenant ids that actually have due
   * rows. Commands stay tenant-scoped (the scanned id becomes the actor
   * tenant) — this scan only avoids invoking every tenant on every tick.
   */
  private async scanDueTenants(result: SchedulerTickResult): Promise<string[]> {
    const db = this.db as Kysely<Database>;
    const at = new Date();
    const found = new Set<string>();
    const collect = async (task: string, query: () => Promise<Array<{ tenant_id: string }>>): Promise<void> => {
      await this.runTask(result, `scan.${task}`, async () => {
        for (const row of await query()) {
          found.add(row.tenant_id);
        }
      });
    };
    await collect("trial.expire_due", () =>
      db
        .selectFrom("trial.trials")
        .select(["tenant_id"])
        .distinct()
        .where("lifecycle_status", "=", "ACTIVE")
        .where("expires_at", "<=", at)
        .execute(),
    );
    await collect("order.expire_due", () =>
      db
        .selectFrom("commerce.orders")
        .select(["tenant_id"])
        .distinct()
        .where("status", "in", ["DRAFT", "AWAITING_PAYMENT"])
        .where("expires_at", "is not", null)
        .where("expires_at", "<=", at)
        .execute(),
    );
    await collect("charge.expire_due", () =>
      db
        .selectFrom("billing.charges")
        .select(["tenant_id"])
        .distinct()
        .where("status", "in", ["PENDING", "PROCESSING"])
        .where("due_at", "is not", null)
        .where("due_at", "<=", at)
        .execute(),
    );
    // Renewal/subscription workers compute candidacy inside the command
    // (policy windows, grace cutoffs), so any tenant with an ACTIVE
    // subscription is a candidate — the commands no-op otherwise.
    await collect("subscription.candidates", () =>
      db.selectFrom("subscription.subscriptions").select(["tenant_id"]).distinct().where("status", "=", "ACTIVE").execute(),
    );
    // Stale-reminder recheck (F13): a payment may settle AFTER the
    // subscription already transitioned to ENDED, leaving no ACTIVE row to
    // trigger the worker above — yet `renewal.reminders_due` still owns an
    // append-only CANCELLED pass for the queued reminder. Scan precisely the
    // tenants that own a generated SYSTEM/INTERNAL `renewal-reminder:*`
    // message whose latest delivery is still QUEUED and whose exact
    // same-tenant linked renewal order is SETTLED, excluding legacy
    // duplicate links already covered by a prior cycle. Tenant-safe on every
    // join/subquery (message ↔ cycle ↔ order ↔ deliveries ↔ earlier cycle);
    // unpaid/foreign/missing links never match, so tenants with only unpaid
    // queued reminders are not re-scanned forever.
    await collect("renewal.stale_reminders", () =>
      db
        .selectFrom("communication.messages as m")
        .innerJoin("subscription.subscription_cycles as c", (join) =>
          join.onRef("c.tenant_id", "=", "m.tenant_id"),
        )
        .innerJoin("commerce.orders as o", (join) =>
          join
            .onRef("o.tenant_id", "=", "c.tenant_id")
            .onRef("o.id", "=", "c.renewal_order_id"),
        )
        .select(["m.tenant_id"])
        .distinct()
        .where("m.direction", "=", "INTERNAL")
        .where("m.sender_type", "=", "SYSTEM")
        .where("m.idempotency_key", "like", "renewal-reminder:%")
        .where(sql<boolean>`"c"."id"::text = split_part("m"."idempotency_key", ':', 3)`)
        .where(sql<boolean>`"c"."subscription_id"::text = split_part("m"."idempotency_key", ':', 2)`)
        .where(sql<boolean>`"c"."renewal_order_id" is not null`)
        .where("o.status", "=", "SETTLED")
        .where((eb) =>
          eb.exists((qb) =>
            qb
              .selectFrom("communication.message_deliveries as ld")
              .select("ld.id")
              .whereRef("ld.tenant_id", "=", "m.tenant_id")
              .whereRef("ld.message_id", "=", "m.id")
              .where("ld.status", "=", "QUEUED")
              .where((neb) =>
                neb.not(
                  neb.exists((newer) =>
                    newer
                      .selectFrom("communication.message_deliveries as n")
                      .select("n.id")
                      .whereRef("n.tenant_id", "=", "ld.tenant_id")
                      .whereRef("n.message_id", "=", "ld.message_id")
                      .whereRef("n.attempt_no", ">", "ld.attempt_no"),
                  ),
                ),
              ),
          ),
        )
        .where((eb) =>
          eb.not(
            eb.exists((qb) =>
              qb
                .selectFrom("subscription.subscription_cycles as earlier")
                .select("earlier.id")
                .whereRef("earlier.tenant_id", "=", "c.tenant_id")
                .whereRef("earlier.subscription_id", "=", "c.subscription_id")
                .whereRef("earlier.renewal_order_id", "=", "c.renewal_order_id")
                .whereRef("earlier.cycle_no", "<", "c.cycle_no"),
            ),
          ),
        )
        .execute(),
    );
    return [...found];
  }
}
