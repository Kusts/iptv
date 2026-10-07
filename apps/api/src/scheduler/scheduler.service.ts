import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId, type CommandActor } from "@iptv/domain";
import { recordCommandExecuted, withSpan } from "@iptv/observability";
import { CommandBus } from "../commands/command-bus.js";
import { OutboxDrainer, isLegacyOutboxDrainEnabled } from "../outbox/outbox-drainer.js";
import { WahaWebhookService } from "../communications/waha-webhook.service.js";
import { AsaasWebhookService } from "../billing/asaas-webhook.service.js";
import { ProviderDispatcherService } from "../provider/provider-dispatcher.service.js";
import { providerDispatchModeFromEnv } from "../provider/provider-port.js";

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
 * IDENTITY (declared, 054): the loop runs TODAY as the pool owner role (the
 * `DATABASE_URL` runtime identity, which bypasses RLS); at cutover it runs
 * as `iptv_app` (NOBYPASSRLS). Both `drainPending` entry points claim through
 * the `platform.inbox_claim` definer (EXECUTE to `iptv_app`), so they behave
 * identically under either identity.
 *
 * Each tick:
 * 1. enumerates tenants through the narrow platform-owned registry
 *    (`control.list_scheduler_tenants` — ids only, zero global reads on
 *    tenant business tables) and runs the worker-eligible `*_due` commands
 *    per tenant (`bus.execute` → `withTransaction` →
 *    `withTenantTransaction`, so every command stays tenant-scoped — the
 *    commands themselves no-op when nothing is due),
 * 2. drains deferred webhook rows (`?defer=1` leftovers via both
 *    `drainPending` entry points, each claiming disjoint RECEIVED rows
 *    through `platform.inbox_claim`),
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
    @Optional() @Inject(ProviderDispatcherService) private readonly providerDispatcher?: ProviderDispatcherService | null,
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
    result.commands["provider.dispatch_due"] = { ok: 0, failed: 0 };
    result.commands["provider.dispatch_recovery"] = { ok: 0, failed: 0 };
    result.commands["provider.dispatch_reconcile"] = { ok: 0, failed: 0 };

    // Due commands first (they emit domain events → outbox rows), deferred
    // webhook drains next (their normalize stage emits too), and the outbox
    // drain LAST so one tick converges instead of leaving fresh PENDING
    // rows for the next tick.
    const tenants = await this.listSchedulerTenants(result);
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
    // CV-DSP-01 durable provider dispatch (platform-level, opt-in): runs
    // only in `durable` dispatch mode — inline (default) never claims. The
    // scheduler loop itself stays opt-in via API_SCHEDULER_ENABLED, and the
    // drain emits domain events, so the outbox drain below still converges
    // the same tick.
    if (providerDispatchModeFromEnv() === "durable" && this.providerDispatcher != null) {
      const dispatcher = this.providerDispatcher;
      await this.runTask(result, "provider.dispatch_recovery", async () => {
        await dispatcher.recoverOnce(100);
        (result.commands["provider.dispatch_recovery"] as SchedulerCommandCounts).ok += 1;
      });
      await this.runTask(result, "provider.dispatch_due", async () => {
        await dispatcher.drainOnce(25);
        (result.commands["provider.dispatch_due"] as SchedulerCommandCounts).ok += 1;
      });
      // FASE5-FIX4-N1: reconcile VERIFYING secret-required trial rows
      // outside any transaction (readback + CAS-fenced outcome). Same
      // opt-in durable gate as drain/recovery; idempotent per tick.
      await this.runTask(result, "provider.dispatch_reconcile", async () => {
        await dispatcher.reconcileOnce(100);
        (result.commands["provider.dispatch_reconcile"] as SchedulerCommandCounts).ok += 1;
      });
    }
    await this.runTask(result, "outbox.drain", async () => {
      if (!isLegacyOutboxDrainEnabled()) {
        this.logger.log("scheduler skipping legacy outbox drain (LEGACY_OUTBOX_DRAIN_ENABLED=0)");
        return;
      }
      result.outbox = await this.outbox.drain(25);
    });
    return result;
  }

  /** Operational hook: wait for in-flight legacy outbox drains to finish. */
  async awaitOutboxQuiescence(timeoutMs?: number): Promise<void> {
    if (timeoutMs === undefined) {
      await this.outbox.waitForQuiescence();
    } else {
      await this.outbox.waitForQuiescence(timeoutMs);
    }
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
   * Tenant enumeration through the narrow platform-owned registry
   * (`control.list_scheduler_tenants`, migration 054): ids only, in creation
   * order, touching NO business table -- the tick performs zero global reads
   * on tenant business data. Due-work candidacy stays inside the per-tenant
   * commands (idempotent no-ops when nothing is due); this list only avoids
   * invoking tenants that do not exist. Tenant ids come from the registry,
   * never from request input.
   */
  private async listSchedulerTenants(result: SchedulerTickResult): Promise<string[]> {
    const db = this.db as Kysely<Database>;
    let tenants: string[] = [];
    await this.runTask(result, "scan.scheduler_tenants", async () => {
      const rows = await sql<{ o_tenant_id: string }>`select * from control.list_scheduler_tenants()`.execute(db);
      tenants = rows.rows.map((row) => row.o_tenant_id);
    });
    return tenants;
  }
}
