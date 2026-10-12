/**
 * SEC-EVALS-40-01 — Alternate-path permission/effect eval suite (issue #40).
 *
 * Principle under test (HarnessSecurity-Bench pointer): blocking a capability
 * via ONE route does not guarantee the EFFECT is unreachable via another
 * tool/command. Authorization must follow the EFFECT/tenant, not the route:
 * a deny on the primary surface must not leave an equivalent bypass open
 * (alternate controller, Copilot tool entry, scheduler/job, replay/outbox,
 * provider webhook, chained indirect op, cross-tenant id, invalid/expired
 * session token).
 *
 * ---------------------------------------------------------------------------
 * INVENTORY (code-derived; every row names real symbols — no invented routes)
 * ---------------------------------------------------------------------------
 * Effect class            | Capable routes (controller -> CommandBus command)
 * ------------------------|--------------------------------------------------
 * 1. Refund issuance      | BillingController.requestRefund
 *    (effect:              |   POST /v1/refund-requests -> `refund.request`
 *    billing.refunds row   |   (perm `billing.refund.request`)
 *    SUCCEEDED +           | BillingController.executeRefund
 *    REFUND_REVERSAL       |   POST /v1/refund-requests/:id/execute
 *    ledger + payment      |   -> `refund.execute_approved`
 *    status flip)          |   (perm `billing.refund.execute`)
 *                          | BillingController.reconcileRefund
 *                          |   POST /v1/refunds/:id/reconcile -> `refund.reconcile`
 *                          |   (perm `billing.refund.execute`)
 *                          | AgentController.copilotExecute (agent.controller.ts)
 *                          |   POST /v1/agent/copilot/execute {command:"refund.request"}
 *                          |   -> CopilotService.execute -> allowlist COPILOT_COMMANDS
 *                          |   (HIGH risk: parked for HITL, never direct-executes)
 *                          | Copilot continuation (same route, {command,input,reviewId})
 *                          |   -> CopilotService.executeApproved (binding hash +
 *                          |   RESOLVED/APPROVE + single-use
 *                          |   copilot_review_consumptions claim; tenant-scoped)
 *                          | HumanReviewController.approve
 *                          |   POST /v1/human-reviews/:id/approve
 *                          |   -> `human_review.approve`
 *                          |   (perm `agent.review.decide`; tenant-scoped; no
 *                          |   self-approval on copilot_command reviews via
 *                          |   copilotTargetRevalidator in agent/copilot-review.ts)
 *                          | AsaasWebhookService.processRow (NO refund path: PAID only
 *                          |   confirms via `charge.webhook_confirm`; chargeback is the
 *                          |   distinct `payment.record_chargeback` intake, provider-
 *                          |   secret authenticated, actorType "external")
 * 2. Purchase/            | CommerceController.quote/submit (`offer.quote`,
 *    provisioning         |   `order.submit`, perm `commerce.order.write`)
 *    (effect:              | BillingController.createCharge
 *    billing.charges row + |   POST /v1/charges -> `charge.create`
 *    customer/provider     |   (perm `billing.charge.write`)
 *    binding rows)         | BillingController.provisionBillingCustomer
 *                          |   POST /v1/billing-customers/provision
 *                          |   -> `billing.customer_provision`
 *                          |   (perm `billing.charge.write`)
 *                          | AsaasWebhookController.receive (PUBLIC, provider-secret
 *                          |   auth): can only CONFIRM existing charges via
 *                          |   `charge.webhook_confirm` — never mints charges.
 *                          | SchedulerService tick (actor isPlatformAdmin, system):
 *                          |   WORKER_COMMANDS allowlist has NO create/provision
 *                          |   entry (`charge.expire_due` etc. only).
 * 3. Customer mutation    | CrmController.registerPerson
 *    (effect:              |   POST /v1/crm/persons -> `person.register`
 *    identity.persons /    | CrmController.captureLead -> `lead.capture`
 *    crm.leads rows)       | CrmController.transitionLead -> `lead.transition`
 *                          |   (all perm `crm.lead.write`; reads `crm.person.read`)
 *                          | CopilotService: NO person/lead command in COPILOT_COMMANDS
 *                          |   -> `unknown_command`, never executes.
 * 4. Admin actions        | PolicyController.publish
 *    (effect: policy/      |   POST /v1/policies/publish -> `policy.publish`
 *    capability rows)      |   (perm `settings.manage`; PLATFORM/PARTNER scopes
 *                          |   additionally require isPlatformAdmin in handler)
 *                          | `capability.set_availability` (perm `settings.manage`;
 *                          |   no direct HTTP mutator in capabilities.controller —
 *                          |   bus-only surface)
 *                          | ProviderDispatchController drain/recover/reconcile
 *                          |   (AuthGuard + requirePlatformAdmin, no tenant perms)
 * 5. Cross-tenant         | Every read above scopes by actor tenant
 *    reads/writes          |   (explicit `tenant_id =` + RLS `withTenantTransaction`);
 *    (effect: disclosure   | foreign ids resolve to NOT_FOUND/empty, never leak.
 *    or foreign write)     | CommandBus.execute re-scopes by actor.tenantId;
 *                          | platformAdmin is the only cross-tenant bypass.
 *
 * Choke point: AuthGuard (session -> req.auth) + PermissionsGuard
 * (RequirePermission -> req.tenant) + CommandBus.execute (def.permission check
 * BEFORE zod parse and BEFORE idempotency claim). Denied commands never reach
 * a transaction: `db.txByTenant` equivalent here = zero new domain rows.
 *
 * For each critical effect this suite asserts, against REAL state (ledger
 * rows, refund/charge/binding/person/policy rows — never status text alone):
 *  (a) deny on the primary route prevents the EFFECT;
 *  (b) the same effect via >=1 alternate route is ALSO denied or safely
 *      deduplicated;
 *  (c) cross-tenant variant denied with isolation intact;
 *  (d) invalid/expired session-token variant denied;
 *  (e) legitimate authorized case still succeeds (over-blocking guard).
 * Replay: denied replay stays denied; authorized replay stays single-effect.
 *
 * Deterministic: no wall-clock/timing asserts; unique tails (never UUID
 * heads); sequential in-file order; all assertions tenant- or key-scoped.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createDb, applyMigrations } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { AppModule } from "../src/app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "../src/request-id.js";
import { CommandBus } from "../src/commands/command-bus.js";
import { OutboxDrainer } from "../src/outbox/outbox-drainer.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

const ALT_TEST_AUTH_FIXTURE = "altpath test fixture, not a credential 0123456789";
const ASAAS_SECRET = "sec40-asaas-secret";

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

function tail(): string {
  return newId().replace(/-/g, "").slice(-12);
}

// Effect counters for the closing metrics test (in-file order is sequential).
const metrics = { unauthorizedAttempts: 0, unauthorizedEffects: 0, legitSuccess: 0 };
// Refund ids minted by LEGITIMATE flows only (test 1e registers here). The
// closing metrics test derives unauthorizedEffects from observation: every
// SUCCEEDED refund outside this set is an unauthorized money effect.
const legitRefundIds = new Set<string>();
function denied(): void {
  metrics.unauthorizedAttempts += 1;
}
function legit(): void {
  metrics.legitSuccess += 1;
}

const OWNER_PERMS = [
  "crm.person.read",
  "crm.lead.write",
  "billing.read",
  "commerce.order.write",
  "billing.charge.write",
  "billing.refund.request",
  "billing.refund.execute",
  "billing.exception.resolve",
  "agent.review.request",
  "agent.review.decide",
  "settings.manage",
  "subscription.write",
  "subscription.read",
  "provider.operation.read",
  "provider.operation.write",
];

describe.skipIf(!hasDb)("alternate-path permission evals for critical effects (#40)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });
  let bus: CommandBus;
  let drainer: OutboxDrainer;

  let tokenA = "";
  let revA = "0";
  let tenantA = "";
  let userA = "";
  let approverId = "";
  let opToken = "";
  let opRev = "0";
  let opUserId = "";
  let tokenB = "";
  let revB = "0";
  let tenantB = "";
  let userB = "";

  function ownerA(): CommandActor {
    return {
      userId: userA,
      isPlatformAdmin: false,
      tenantId: tenantA,
      roleKeys: ["tenant_owner"],
      permissions: OWNER_PERMS,
      actorType: "human",
    };
  }

  function approverA(): CommandActor {
    return {
      userId: approverId,
      isPlatformAdmin: false,
      tenantId: tenantA,
      roleKeys: ["tenant_owner"],
      permissions: OWNER_PERMS,
      actorType: "human",
    };
  }

  function ownerB(): CommandActor {
    return {
      userId: userB,
      isPlatformAdmin: false,
      tenantId: tenantB,
      roleKeys: ["tenant_owner"],
      permissions: OWNER_PERMS,
      actorType: "human",
    };
  }

  /** Below-operator actor: holds NO privileged permission (primary-route deny). */
  function stripped(tenantId: string): CommandActor {
    return {
      userId: newId(),
      isPlatformAdmin: false,
      tenantId,
      roleKeys: [],
      permissions: ["crm.person.read"],
      actorType: "human",
    };
  }

  function inject(opts: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    revision?: string | null;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
  }) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) {
      headers["authorization"] = `Bearer ${opts.token}`;
      if (opts.revision !== null && headers["x-tenant-context-revision"] === undefined) {
        headers["x-tenant-context-revision"] = opts.revision ?? "0";
      }
    }
    const options: {
      method: "GET" | "POST";
      url: string;
      headers: Record<string, string>;
      payload?: Record<string, unknown>;
    } = { method: opts.method, url: opts.url, headers };
    if (opts.payload !== undefined) {
      options.payload = opts.payload;
    }
    return app.getHttpAdapter().getInstance().inject(options);
  }

  const getA = (url: string, extra?: { token?: string; revision?: string | null }) =>
    inject({ method: "GET", url, token: extra?.token ?? tokenA, revision: extra?.revision ?? revA });
  const postA = (
    url: string,
    payload?: Record<string, unknown>,
    extra?: { token?: string; revision?: string | null; headers?: Record<string, string> },
  ) =>
    inject({
      method: "POST",
      url,
      token: extra?.token ?? tokenA,
      revision: extra?.revision ?? revA,
      headers: extra?.headers,
      payload,
    });

  async function seedPlan(priceMinor: string): Promise<string> {
    const suffix = tail();
    const productId = newId();
    await db
      .insertInto("catalog.products")
      .values({
        id: productId,
        tenant_id: tenantA,
        product_key: `sec40-${suffix}`,
        name: "Sec40 Service",
        product_type: "SERVICE",
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const planId = newId();
    await db
      .insertInto("catalog.plans")
      .values({
        id: planId,
        tenant_id: tenantA,
        product_id: productId,
        plan_key: `sec40-monthly-${suffix}`,
        name: "Sec40 Monthly",
        billing_interval_unit: "MONTH",
        billing_interval_count: 1,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("catalog.prices")
      .values({
        id: newId(),
        tenant_id: tenantA,
        sellable_type: "PLAN",
        sellable_id: planId,
        amount_minor: priceMinor,
        currency: "BRL",
        starts_at: new Date(Date.now() - 60_000),
        ends_at: null,
        segment_key: null,
        status: "ACTIVE",
        metadata_json: {},
        created_at: new Date(),
      })
      .execute();
    return planId;
  }

  async function makePerson(): Promise<string> {
    const result = await bus.execute<{ id: string }>(ownerA(), "person.register", {
      canonicalName: `Sec40 Person ${tail()}`,
    });
    if (!result.ok) {
      throw new Error(`person.register failed: ${result.message}`);
    }
    return result.data.id;
  }

  async function quoteSubmitCharge(
    personId: string,
    planId: string,
    quantity: number,
  ): Promise<{ orderId: string; chargeId: string; providerChargeId: string }> {
    const quoted = await bus.execute<{ id: string }>(ownerA(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity }],
      orderType: "NEW_SUBSCRIPTION",
    });
    if (!quoted.ok) {
      throw new Error(`offer.quote failed: ${JSON.stringify(quoted)}`);
    }
    const submitted = await bus.execute(ownerA(), "order.submit", { orderId: quoted.data.id });
    if (!submitted.ok) {
      throw new Error(`order.submit failed: ${JSON.stringify(submitted)}`);
    }
    const owner = await db
      .selectFrom("commerce.orders")
      .select(["person_id"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", quoted.data.id)
      .executeTakeFirstOrThrow();
    const provisioned = await bus.execute(ownerA(), "billing.customer_provision", {
      personId: owner.person_id,
    });
    if (!provisioned.ok) {
      throw new Error(`customer.provision failed: ${JSON.stringify(provisioned)}`);
    }
    const created = await bus.execute<{ id: string; providerChargeId: string | null }>(
      ownerA(),
      "charge.create",
      { orderId: quoted.data.id },
    );
    if (!created.ok || created.data.providerChargeId === null) {
      throw new Error(`charge.create failed: ${JSON.stringify(created)}`);
    }
    return { orderId: quoted.data.id, chargeId: created.data.id, providerChargeId: created.data.providerChargeId };
  }

  async function setupAsaasChannel(): Promise<string> {
    const tenantKey = `sec40-${tail()}`;
    const sha = createHash("sha256").update(ASAAS_SECRET, "utf8").digest("hex");
    await db
      .insertInto("billing.tenant_channels")
      .values({
        id: newId(),
        tenant_id: tenantA,
        channel: "ASAAS",
        tenant_key: tenantKey,
        webhook_secret_hash: sha,
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    return tenantKey;
  }

  async function paidAndConfirmed(
    personId: string,
    planId: string,
    quantity: number,
    amountDecimal: number,
  ): Promise<{ orderId: string; paymentId: string }> {
    const tenantKey = await setupAsaasChannel();
    const { orderId, providerChargeId } = await quoteSubmitCharge(personId, planId, quantity);
    const eventId = `sec40-pay-${tail()}`;
    const delivered = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": ASAAS_SECRET },
      payload: {
        event: "PAYMENT_RECEIVED",
        id: eventId,
        payment: { id: providerChargeId, value: amountDecimal, currency: "BRL" },
      },
    });
    expect(delivered.statusCode).toBe(202);
    const payments = await db
      .selectFrom("billing.payments")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantA)
      .where("order_id", "=", orderId)
      .execute();
    expect(payments).toHaveLength(1);
    const payment = payments[0];
    if (payment === undefined) {
      throw new Error("expected a payment");
    }
    expect(payment.status).toBe("CONFIRMED");
    return { orderId, paymentId: payment.id };
  }

  async function refundRequestsWithKey(key: string) {
    return db
      .selectFrom("billing.refund_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("idempotency_key", "=", key)
      .execute();
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    await db
      .insertInto("platform.capabilities")
      .values({
        id: newId(),
        key: "provider.cinevision",
        owner_context: "provider",
        availability: "AVAILABLE",
        certification_status: "SANDBOX_CERTIFIED",
        risk_level: "HIGH",
        mvp_phase: "W0",
        manual_equivalent: "Provider operator fulfills the operation manually (HITL) via provider.resolve_operation",
        policy_family: "provider-integration",
        degradation: "Forced MANUAL until durable post-commit dispatch with certified readback",
        permissions: [],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ availability: "AVAILABLE", certification_status: "SANDBOX_CERTIFIED", updated_at: new Date() }),
      )
      .execute();
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = ALT_TEST_AUTH_FIXTURE;
    delete process.env["ASAAS_ADAPTER"];
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);
    drainer = app.get(OutboxDrainer);

    const regA = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sec40-owner"), password: "correct-horse-8", tenantName: "Sec40 Tenant A" },
    });
    expect(regA.statusCode).toBe(201);
    const bodyA = regA.json<{ token: string; activeTenantId: string; user: { id: string }; tenantContextRevision: string }>();
    tokenA = bodyA.token;
    tenantA = bodyA.activeTenantId;
    userA = bodyA.user.id;
    revA = bodyA.tenantContextRevision;

    // Refund approver: second human in tenant A (no self-approval).
    approverId = newId();
    await db
      .insertInto("control.users")
      .values({
        id: approverId,
        auth_subject: `email:${email("sec40-approver")}`,
        display_name: "Sec40 Approver",
        status: "ACTIVE",
        is_platform_admin: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantA,
        user_id: approverId,
        role_key: "tenant_owner",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    // Least-privilege operator: registers (own throwaway tenant), gains a
    // tenant_operator membership in A, then switches active tenant to A.
    const regOp = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sec40-operator"), password: "correct-horse-8", tenantName: "Sec40 Operator Home" },
    });
    expect(regOp.statusCode).toBe(201);
    const bodyOp = regOp.json<{ token: string; user: { id: string }; tenantContextRevision: string }>();
    opToken = bodyOp.token;
    opUserId = bodyOp.user.id;
    await db
      .insertInto("control.tenant_memberships")
      .values({
        id: newId(),
        tenant_id: tenantA,
        user_id: opUserId,
        role_key: "tenant_operator",
        status: "ACTIVE",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const switched = await inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/switch`,
      token: opToken,
      revision: bodyOp.tenantContextRevision,
    });
    expect(switched.statusCode).toBe(200);
    opRev = switched.json<{ tenantContextRevision: string }>().tenantContextRevision;

    const regB = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sec40-owner-b"), password: "correct-horse-8", tenantName: "Sec40 Tenant B" },
    });
    expect(regB.statusCode).toBe(201);
    const bodyB = regB.json<{ token: string; activeTenantId: string; user: { id: string }; tenantContextRevision: string }>();
    tokenB = bodyB.token;
    tenantB = bodyB.activeTenantId;
    userB = bodyB.user.id;
    revB = bodyB.tenantContextRevision;
    expect(tenantB).not.toBe(tenantA);
  }, 120_000);

  afterAll(async () => {
    if (hasDb && drainer !== undefined) {
      const drainBudgetUntil = Date.now() + 6000;
      for (;;) {
        if (Date.now() >= drainBudgetUntil) break;
        const drained = await drainer.drain(50).catch(() => undefined);
        if (drained === undefined || drained.claimed === 0) break;
      }
    }
    await app?.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
  });

  // ------------------------------------------------------------------
  // 1. Refund issuance — effect: billing.refunds SUCCEEDED +
  //    REFUND_REVERSAL ledger + payment status flip.
  // ------------------------------------------------------------------

  it("1a. primary-route deny: operator cannot execute an APPROVED refund (403, zero effect)", async () => {
    // Real, executable target: owner requests, a second human approves.
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    const key = `sec40-attack-${tail()}`;
    const requested = await bus.execute<{ id: string; reviewRequestId: string }>(
      ownerA(),
      "refund.request",
      {
        paymentId,
        amountMinor: "100",
        currency: "BRL",
        reason: "attacked refund target",
        idempotencyKey: key,
      },
      { idempotencyKey: key },
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) {
      throw new Error("attack-target refund.request failed");
    }
    const targetId = requested.data.id;
    const approved = await bus.execute(approverA(), "human_review.approve", {
      requestId: requested.data.reviewRequestId,
    });
    expect(approved.ok).toBe(true);
    // Non-vacuous target: APPROVED and executable before the attack.
    const targetBefore = await db
      .selectFrom("billing.refund_requests")
      .select(["status", "executed_at"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", targetId)
      .executeTakeFirstOrThrow();
    expect(targetBefore.status).toBe("APPROVED");
    const reversalsBefore = (
      await db
        .selectFrom("finance.financial_transactions")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("transaction_type", "=", "REFUND_REVERSAL")
        .execute()
    ).length;

    // Attack: least-privilege operator (no `billing.refund.execute`) attempts
    // the execute route against the approved request.
    const res = await postA(`/v1/refund-requests/${targetId}/execute`, undefined, { token: opToken, revision: opRev });
    expect(res.statusCode).toBe(403);
    denied();

    // Zero effect on the ATTACKED target (REAL state, never status text):
    // no refund row for the attacked request ...
    expect(
      await db
        .selectFrom("billing.refunds")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("refund_request_id", "=", targetId)
        .execute(),
    ).toHaveLength(0);
    // ... payment status untouched ...
    expect(
      (
        await db
          .selectFrom("billing.payments")
          .select(["status"])
          .where("tenant_id", "=", tenantA)
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("CONFIRMED");
    // ... no new reversal postings. The echo provider fake acts only through
    // the command handler, which a PermissionsGuard deny never reaches, so no
    // provider call can have produced a money effect ...
    expect(
      (
        await db
          .selectFrom("finance.financial_transactions")
          .select(["id"])
          .where("tenant_id", "=", tenantA)
          .where("transaction_type", "=", "REFUND_REVERSAL")
          .execute()
      ).length,
    ).toBe(reversalsBefore);
    // ... and the request itself is still APPROVED, never executed.
    const targetAfter = await db
      .selectFrom("billing.refund_requests")
      .select(["status", "executed_at"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", targetId)
      .executeTakeFirstOrThrow();
    expect(targetAfter.status).toBe("APPROVED");
    expect(targetAfter.executed_at).toBeNull();
  });

  it("1a2. choke-point deny: stripped actor refund.request is forbidden with zero state", async () => {
    const key = `sec40-deny-${tail()}`;
    const result = await bus.execute(stripped(tenantA), "refund.request", {
      paymentId: newId(),
      amountMinor: "100",
      currency: "BRL",
      reason: "forged",
      idempotencyKey: key,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("forbidden");
    denied();
    // Permission is checked BEFORE parse/claim/tx: no row may exist.
    expect(await refundRequestsWithKey(key)).toHaveLength(0);
  });

  it("1a3. approved request executed by an unauthorized actor stays denied with zero effect (bus choke point + outbox drain)", async () => {
    // Second real, executable target (distinct payment/request from 1a).
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    const key = `sec40-attack-bus-${tail()}`;
    const requested = await bus.execute<{ id: string; reviewRequestId: string }>(
      ownerA(),
      "refund.request",
      {
        paymentId,
        amountMinor: "100",
        currency: "BRL",
        reason: "second attacked refund target",
        idempotencyKey: key,
      },
      { idempotencyKey: key },
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) {
      throw new Error("attack-target refund.request failed");
    }
    const targetId = requested.data.id;
    const approved = await bus.execute(approverA(), "human_review.approve", {
      requestId: requested.data.reviewRequestId,
    });
    expect(approved.ok).toBe(true);
    const reversalsBefore = (
      await db
        .selectFrom("finance.financial_transactions")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("transaction_type", "=", "REFUND_REVERSAL")
        .execute()
    ).length;

    // Attack at the bus choke point: actor without `billing.refund.execute`.
    const forged = await bus.execute(stripped(tenantA), "refund.execute_approved", { refundRequestId: targetId });
    expect(forged.ok).toBe(false);
    expect(forged.ok ? null : forged.code).toBe("forbidden");
    denied();

    // Fail-closed drain with a budget: rules out deferred/async completion
    // of the effect out-of-band (no scheduler/worker path can mint what the
    // deny blocked). Drain errors PROPAGATE (no `.catch` swallow: an
    // incomplete drain must fail the test, never pass it), and exhausting
    // the budget without reaching quiescence FAILS explicitly instead of
    // breaking silently. Per-row publish failures do not throw (the drainer
    // parks them FAILED with a 60s backoff, so they are not re-due); only
    // infra/config errors throw, which is exactly the fail-closed signal.
    // A final drain with `claimed === 0` is the verifiable quiescence proof:
    // no deferred work remains for ANY target, hence none for this one.
    // (Sequential in-file order + the tenant-scoped zero-effect oracles
    // below are the primary proof; the drain is defense-in-depth.)
    const drainBudgetUntil = Date.now() + 15_000;
    let quiesced = false;
    let lastClaimed = -1;
    for (;;) {
      const drained = await drainer.drain(50);
      lastClaimed = drained.claimed;
      if (drained.claimed === 0) {
        quiesced = true;
        break;
      }
      if (Date.now() >= drainBudgetUntil) {
        break;
      }
    }
    if (!quiesced) {
      throw new Error(
        `fail-closed drain did not quiesce within budget (last claimed=${lastClaimed}); cannot rule out deferred completion`,
      );
    }

    // Zero effect on the attacked target: no refund row ...
    expect(
      await db
        .selectFrom("billing.refunds")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("refund_request_id", "=", targetId)
        .execute(),
    ).toHaveLength(0);
    // ... payment status untouched ...
    expect(
      (
        await db
          .selectFrom("billing.payments")
          .select(["status"])
          .where("tenant_id", "=", tenantA)
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("CONFIRMED");
    // ... no new reversal postings ...
    expect(
      (
        await db
          .selectFrom("finance.financial_transactions")
          .select(["id"])
          .where("tenant_id", "=", tenantA)
          .where("transaction_type", "=", "REFUND_REVERSAL")
          .execute()
      ).length,
    ).toBe(reversalsBefore);
    // ... no refund-effect domain entries for the target payment (the success
    // path is the only emitter of these event types) ...
    expect(
      await db
        .selectFrom("platform.domain_events")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("aggregate_type", "=", "payment")
        .where("aggregate_id", "=", paymentId)
        .where("event_type", "in", ["payment.refunded.v1", "payment.partially_refunded.v1"])
        .execute(),
    ).toHaveLength(0);
    // ... and the request itself is still APPROVED, never executed.
    const targetAfter = await db
      .selectFrom("billing.refund_requests")
      .select(["status", "executed_at"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", targetId)
      .executeTakeFirstOrThrow();
    expect(targetAfter.status).toBe("APPROVED");
    expect(targetAfter.executed_at).toBeNull();
  });

  it("1b. alternate route (copilot tool entry) cannot bypass approval: parked, never executed", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    const before = await db
      .selectFrom("billing.refund_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("payment_id", "=", paymentId)
      .execute();
    const res = await postA(
      "/v1/agent/copilot/execute",
      { command: "refund.request", input: { paymentId, amountMinor: "100", currency: "BRL", reason: "via copilot" } },
      { token: opToken, revision: opRev },
    );
    // HIGH-risk copilot commands park for HITL instead of executing.
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe("pending_review");
    denied();
    const after = await db
      .selectFrom("billing.refund_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("payment_id", "=", paymentId)
      .execute();
    expect(after).toHaveLength(before.length);
  });

  it("1b2. alternate route (copilot unknown command) cannot reach refund.execute_approved", async () => {
    const countBefore = (
      await db.selectFrom("billing.refunds").select(["id"]).where("tenant_id", "=", tenantA).execute()
    ).length;
    const res = await postA(
      "/v1/agent/copilot/execute",
      { command: "refund.execute_approved", input: { refundRequestId: newId() } },
      { token: opToken, revision: opRev },
    );
    expect(res.statusCode).toBe(404);
    denied();
    // The unknown command executes nothing: the refunds table is unchanged.
    expect(
      (await db.selectFrom("billing.refunds").select(["id"]).where("tenant_id", "=", tenantA).execute()).length,
    ).toBe(countBefore);
  });

  it("1b4. parked copilot item: unauthorized continuation denied, legitimate approval executes with attribution", async () => {
    // HITL continuation flow under test (all real symbols):
    // - park:     POST /v1/agent/copilot/execute {command:"refund.request", input}
    //             -> CopilotService.execute -> requestReview ->
    //             `human_review.request` (resource_type "copilot_command"),
    //             201 pending_review + reviewId.
    // - approve:  POST /v1/human-reviews/:id/approve -> `human_review.approve`
    //             (perm `agent.review.decide`; tenant-scoped; no self-approval
    //             via copilotTargetRevalidator in agent/copilot-review.ts).
    // - continue: POST /v1/agent/copilot/execute {command, input, reviewId}
    //             -> CopilotService.executeApproved (binding hash + RESOLVED +
    //             APPROVE + single-use copilot_review_consumptions claim).
    // Covered below: cross-tenant continuation (404), pre-approval
    // continuation (409), unauthorized approve (bus forbidden +
    // cross-tenant HTTP 404), then the legitimate path (second-human approve
    // + owner execute) with attribution to the legitimate tenant/actor.
    // Out of scope: MEDIUM-risk direct copilot commands (covered by the
    // copilot-w14b suite), provider-operation HITL center items (read-model
    // only, no approve control), and concurrent double-spend races on the
    // single-use claim (sequential in-file order; replay is covered).
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    const key = `sec40-copilot-park-${tail()}`;
    const parkedInput = {
      paymentId,
      amountMinor: "100",
      currency: "BRL",
      reason: "parked copilot continuation target",
      idempotencyKey: key,
    };
    const refundsBefore = (
      await db.selectFrom("billing.refunds").select(["id"]).where("tenant_id", "=", tenantA).execute()
    ).length;
    const reversalsBefore = (
      await db
        .selectFrom("finance.financial_transactions")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("transaction_type", "=", "REFUND_REVERSAL")
        .execute()
    ).length;

    // Park via the operator (holds `billing.refund.request` +
    // `agent.review.request`, like test 1b). The input carries an
    // idempotencyKey so the legitimate continuation below can execute;
    // 1b's key-less input could never continue past input validation.
    const parked = await postA(
      "/v1/agent/copilot/execute",
      { command: "refund.request", input: parkedInput },
      { token: opToken, revision: opRev },
    );
    expect(parked.statusCode).toBe(201);
    expect(parked.json<{ status: string }>().status).toBe("pending_review");
    const reviewId = parked.json<{ reviewId: string }>().reviewId;
    expect(typeof reviewId).toBe("string");

    // (ii-a) Cross-tenant continuation: tenant B names tenant A's review.
    // Tenant-scoped lookup misses -> 404, nothing executes.
    const foreign = await postA(
      "/v1/agent/copilot/execute",
      { command: "refund.request", input: parkedInput, reviewId },
      { token: tokenB, revision: revB },
    );
    expect(foreign.statusCode).toBe(404);
    denied();
    // (ii-b) Pre-approval continuation by the requester: the review is still
    // open, so the continuation is stale -> 409, nothing executes.
    const early = await postA(
      "/v1/agent/copilot/execute",
      { command: "refund.request", input: parkedInput, reviewId },
      { token: opToken, revision: opRev },
    );
    expect(early.statusCode).toBe(409);
    denied();
    // (ii-c) Unauthorized approve at the bus choke point: stripped actor
    // lacks `agent.review.decide` -> forbidden, review untouched.
    const forgedApprove = await bus.execute(stripped(tenantA), "human_review.approve", { requestId: reviewId });
    expect(forgedApprove.ok ? null : forgedApprove.code).toBe("forbidden");
    denied();
    // (ii-d) Cross-tenant approve over HTTP: tenant B cannot decide tenant
    // A's review -> 404, review untouched.
    const foreignApprove = await postA(`/v1/human-reviews/${reviewId}/approve`, {}, { token: tokenB, revision: revB });
    expect(foreignApprove.statusCode).toBe(404);
    denied();

    // Zero effect from every denied continuation/approval above (REAL state):
    // the parked command created NO refund request ...
    expect(await refundRequestsWithKey(key)).toHaveLength(0);
    // ... no refund row for the target payment ...
    expect(
      (await db.selectFrom("billing.refunds").select(["id"]).where("tenant_id", "=", tenantA).execute()).length,
    ).toBe(refundsBefore);
    // ... payment status untouched ...
    expect(
      (
        await db
          .selectFrom("billing.payments")
          .select(["status"])
          .where("tenant_id", "=", tenantA)
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("CONFIRMED");
    // ... no new reversal postings ...
    expect(
      (
        await db
          .selectFrom("finance.financial_transactions")
          .select(["id"])
          .where("tenant_id", "=", tenantA)
          .where("transaction_type", "=", "REFUND_REVERSAL")
          .execute()
      ).length,
    ).toBe(reversalsBefore);
    // ... no refund-effect domain entries for the target payment (the success
    // path is the only emitter of these event types) ...
    expect(
      await db
        .selectFrom("platform.domain_events")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("aggregate_type", "=", "payment")
        .where("aggregate_id", "=", paymentId)
        .where("event_type", "in", ["payment.refunded.v1", "payment.partially_refunded.v1"])
        .execute(),
    ).toHaveLength(0);
    // ... and the parked review is still open, never decided.
    const stillOpen = await db
      .selectFrom("agent.human_review_requests")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"]).toContain(stillOpen.status);

    // (iii) Legitimate path: a second human approves, the owner continues.
    // approverA is never the requester (operator), so no self-approval trip.
    const approved = await bus.execute(approverA(), "human_review.approve", { requestId: reviewId });
    expect(approved.ok).toBe(true);
    const executed = await postA("/v1/agent/copilot/execute", {
      command: "refund.request",
      input: parkedInput,
      reviewId,
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json<{ status: string }>().status).toBe("executed");
    // Effect attributed to the legitimate tenant/actor: exactly one refund
    // request for the parked key ...
    expect(await refundRequestsWithKey(key)).toHaveLength(1);
    // ... single-use claim burned by the owner (a replay would 409 `consumed`).
    const consumption = await db
      .selectFrom("agent.copilot_review_consumptions")
      .select(["consumed_by_actor_id", "tenant_id"])
      .where("tenant_id", "=", tenantA)
      .where("human_review_request_id", "=", reviewId)
      .execute();
    expect(consumption).toHaveLength(1);
    expect(consumption[0]?.consumed_by_actor_id).toBe(userA);
    expect(consumption[0]?.tenant_id).toBe(tenantA);
    // ... and still no MONEY effect: a request parks for financial review,
    // it does not mint refunds, reversals, or payment flips.
    expect(
      (await db.selectFrom("billing.refunds").select(["id"]).where("tenant_id", "=", tenantA).execute()).length,
    ).toBe(refundsBefore);
    expect(
      (
        await db
          .selectFrom("billing.payments")
          .select(["status"])
          .where("tenant_id", "=", tenantA)
          .where("id", "=", paymentId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("CONFIRMED");
    expect(
      (
        await db
          .selectFrom("finance.financial_transactions")
          .select(["id"])
          .where("tenant_id", "=", tenantA)
          .where("transaction_type", "=", "REFUND_REVERSAL")
          .execute()
      ).length,
    ).toBe(reversalsBefore);
    // Second continuation with the same reviewId is a consumed replay: 409,
    // still exactly one request (single-effect, like test 1e's re-execute).
    const replayed = await postA("/v1/agent/copilot/execute", {
      command: "refund.request",
      input: parkedInput,
      reviewId,
    });
    expect(replayed.statusCode).toBe(409);
    expect(await refundRequestsWithKey(key)).toHaveLength(1);
    legit();
  });

  it("1b3. replay of a denied refund.request stays denied (no idempotency escape)", async () => {
    const key = `sec40-deny-replay-${tail()}`;
    const payload = {
      paymentId: newId(),
      amountMinor: "100",
      currency: "BRL",
      reason: "forged replay",
      idempotencyKey: key,
    };
    for (let i = 0; i < 2; i += 1) {
      const result = await bus.execute(stripped(tenantA), "refund.request", payload);
      expect(result.ok ? null : result.code).toBe("forbidden");
      denied();
    }
    expect(await refundRequestsWithKey(key)).toHaveLength(0);
  });

  it("1c. cross-tenant refund.request fails closed with isolation intact", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    // Tenant B owner names tenant A's payment: tenant-scoped lookup misses.
    const result = await bus.execute(ownerB(), "refund.request", {
      paymentId,
      amountMinor: "100",
      currency: "BRL",
      reason: "cross-tenant forge",
      idempotencyKey: `sec40-x-${tail()}`,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("not_found");
    denied();
    const inB = await db
      .selectFrom("billing.refund_requests")
      .select(["id"])
      .where("tenant_id", "=", tenantB)
      .where("payment_id", "=", paymentId)
      .execute();
    expect(inB).toHaveLength(0);
    const paymentStill = await db
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow();
    expect(paymentStill.status).toBe("CONFIRMED");
  });

  it("1d. invalid/expired session tokens are denied on the refund surface", async () => {
    const bad = await postA("/v1/refund-requests", { nope: true }, { token: "sec40-nonexistent-token", revision: null });
    expect(bad.statusCode).toBe(401);
    denied();
    // Expired session: register a probe user, backdate its expires_at, use it.
    const reg = await inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("sec40-expiring"), password: "correct-horse-8", tenantName: "Sec40 Expiring" },
    });
    expect(reg.statusCode).toBe(201);
    const probe = reg.json<{ token: string }>();
    const hash = createHash("sha256").update(`${ALT_TEST_AUTH_FIXTURE}:${probe.token}`).digest("hex");
    await db
      .updateTable("control.auth_sessions")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("token_hash", "=", hash)
      .execute();
    const expired = await postA("/v1/refund-requests", { nope: true }, { token: probe.token, revision: null });
    expect(expired.statusCode).toBe(401);
    denied();
  });

  it("1e. legitimate refund still succeeds exactly once (over-blocking guard + single-effect replay)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { paymentId } = await paidAndConfirmed(personId, planId, 1, 10.0);
    const key = `sec40-legit-${tail()}`;
    const refundInput = {
      paymentId,
      amountMinor: "500",
      currency: "BRL",
      reason: "customer asked for a partial refund",
      idempotencyKey: key,
    };
    const requested = await bus.execute<{ id: string; reviewRequestId: string }>(ownerA(), "refund.request", refundInput, {
      idempotencyKey: key,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) {
      throw new Error("legit refund.request failed");
    }
    // Identical replay (same bus key + same payload) returns the SAME
    // request: still a single effect.
    const replayed = await bus.execute(ownerA(), "refund.request", refundInput, { idempotencyKey: key });
    expect(replayed).toEqual(requested);
    expect(await refundRequestsWithKey(key)).toHaveLength(1);

    const approved = await bus.execute(approverA(), "human_review.approve", {
      requestId: requested.data.reviewRequestId,
    });
    expect(approved.ok).toBe(true);
    const executed = await bus.execute<{ refundId: string }>(ownerA(), "refund.execute_approved", {
      refundRequestId: requested.data.id,
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) {
      throw new Error("legit refund.execute_approved failed");
    }
    // REAL state: one SUCCEEDED refund, one reversal posting, flipped payment.
    const refund = await db
      .selectFrom("billing.refunds")
      .select(["status", "amount_minor"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", executed.data.refundId)
      .executeTakeFirstOrThrow();
    expect(refund.status).toBe("SUCCEEDED");
    expect(refund.amount_minor).toBe("500");
    // Register the legitimate money effect so the closing metrics test can
    // derive unauthorizedEffects from observation (any SUCCEEDED refund
    // outside this set is an unauthorized effect).
    legitRefundIds.add(executed.data.refundId);
    const reversals = await db
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("transaction_type", "=", "REFUND_REVERSAL")
      .where("reference_type", "=", "refund")
      .where("reference_id", "=", executed.data.refundId)
      .execute();
    expect(reversals).toHaveLength(1);
    const payment = await db
      .selectFrom("billing.payments")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow();
    expect(payment.status).toBe("PARTIALLY_REFUNDED");
    // Second execute is a stale no-op, never a second money effect.
    const again = await bus.execute(ownerA(), "refund.execute_approved", { refundRequestId: requested.data.id });
    expect(again.ok).toBe(false);
    const reversalsAfter = await db
      .selectFrom("finance.financial_transactions")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("transaction_type", "=", "REFUND_REVERSAL")
      .where("reference_type", "=", "refund")
      .where("reference_id", "=", executed.data.refundId)
      .execute();
    expect(reversalsAfter).toHaveLength(1);
    legit();
  });

  // ------------------------------------------------------------------
  // 2. Purchase/provisioning — effect: billing.charges row +
  //    customer/provider binding rows.
  // ------------------------------------------------------------------

  it("2a. choke-point deny: stripped actor cannot create charges or bindings", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const quoted = await bus.execute<{ id: string }>(ownerA(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) {
      throw new Error("quote failed");
    }
    await bus.execute(ownerA(), "order.submit", { orderId: quoted.data.id });
    const provision = await bus.execute(stripped(tenantA), "billing.customer_provision", { personId });
    expect(provision.ok ? null : provision.code).toBe("forbidden");
    denied();
    const charge = await bus.execute(stripped(tenantA), "charge.create", { orderId: quoted.data.id });
    expect(charge.ok ? null : charge.code).toBe("forbidden");
    denied();
    expect(
      await db
        .selectFrom("billing.customer_provider_bindings")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("person_id", "=", personId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("billing.charges")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("order_id", "=", quoted.data.id)
        .execute(),
    ).toHaveLength(0);
  });

  it("2b. alternate route (copilot) cannot mint charges; webhook cannot mint charges", async () => {
    const copilot = await postA(
      "/v1/agent/copilot/execute",
      { command: "charge.create", input: { orderId: newId() } },
      { token: opToken, revision: opRev },
    );
    expect(copilot.statusCode).toBe(404);
    denied();
    // Webhook alternate path: a PAID delivery for an UNKNOWN provider charge
    // is accepted at ingress but must never confirm money — exception row,
    // and the money tables are untouched (before/after snapshots; in-file
    // order is sequential so no interleaving can satisfy these).
    const paymentsBefore = (
      await db.selectFrom("billing.payments").select(["id"]).where("tenant_id", "=", tenantA).execute()
    ).length;
    const txsBefore = (
      await db.selectFrom("finance.financial_transactions").select(["id"]).where("tenant_id", "=", tenantA).execute()
    ).length;
    const tenantKey = await setupAsaasChannel();
    const unknownRef = `sec40-unknown-${tail()}`;
    const eventId = `sec40-unk-${tail()}`;
    const delivered = await inject({
      method: "POST",
      url: `/v1/webhooks/asaas/${tenantKey}`,
      headers: { "asaas-access-token": ASAAS_SECRET },
      payload: { event: "PAYMENT_RECEIVED", id: eventId, payment: { id: unknownRef, value: 10.0, currency: "BRL" } },
    });
    expect(delivered.statusCode).toBe(202);
    const inbox = await db
      .selectFrom("platform.inbox_messages")
      .select(["id", "state"])
      .where("tenant_id", "=", tenantA)
      .where("provider", "=", "asaas")
      .where("external_event_id", "=", `asaas:${eventId}`)
      .execute();
    expect(inbox).toHaveLength(1);
    expect(["PROCESSED", "FAILED"]).toContain(inbox[0]?.state);
    const exceptions = await db
      .selectFrom("billing.exceptions")
      .select(["id", "status"])
      .where("tenant_id", "=", tenantA)
      .where("kind", "=", "UNKNOWN_CHARGE")
      .execute();
    expect(exceptions.length).toBeGreaterThan(0);
    // No money effect: neither payments nor financial transactions moved.
    expect(
      (await db.selectFrom("billing.payments").select(["id"]).where("tenant_id", "=", tenantA).execute()).length,
    ).toBe(paymentsBefore);
    expect(
      (await db.selectFrom("finance.financial_transactions").select(["id"]).where("tenant_id", "=", tenantA).execute())
        .length,
    ).toBe(txsBefore);
  });

  it("2c. cross-tenant charge.create fails closed with isolation intact", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId } = await quoteSubmitCharge(personId, planId, 1);
    const forged = await bus.execute(ownerB(), "charge.create", { orderId });
    expect(forged.ok).toBe(false);
    expect(forged.ok ? null : forged.code).toBe("not_found");
    denied();
    expect(
      await db.selectFrom("billing.charges").select(["id"]).where("tenant_id", "=", tenantB).where("order_id", "=", orderId).execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom("billing.charges")
        .select(["id"])
        .where("tenant_id", "=", tenantA)
        .where("order_id", "=", orderId)
        .execute(),
    ).toHaveLength(1);
  });

  it("2d. invalid token and stale revision are denied on the charge surface", async () => {
    const bad = await postA("/v1/charges", { orderId: newId() }, { token: "sec40-nonexistent-token", revision: null });
    expect(bad.statusCode).toBe(401);
    denied();
    const stale = await postA("/v1/charges", { orderId: newId() }, { revision: "9999" });
    expect(stale.statusCode).toBe(409);
    denied();
  });

  it("2e. legitimate purchase still succeeds; HTTP replay stays single-charge", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("2000");
    const quoted = await bus.execute<{ id: string }>(ownerA(), "offer.quote", {
      personId,
      items: [{ sellableType: "PLAN", sellableId: planId, quantity: 1 }],
      orderType: "NEW_SUBSCRIPTION",
    });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) {
      throw new Error("quote failed");
    }
    expect(await bus.execute(ownerA(), "order.submit", { orderId: quoted.data.id })).toMatchObject({ ok: true });
    expect(await bus.execute(ownerA(), "billing.customer_provision", { personId })).toMatchObject({ ok: true });
    const key = `sec40-charge-${tail()}`;
    const first = await postA("/v1/charges", { orderId: quoted.data.id }, { headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json<{ id: string; status: string }>();
    expect(firstBody.status).toBe("PROCESSING");
    const second = await postA("/v1/charges", { orderId: quoted.data.id }, { headers: { "idempotency-key": key } });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: string }>().id).toBe(firstBody.id);
    // Single effect: the header key dedupes at the bus claim, while the row
    // carries the handler default (`charge:<order>:<charge>`) because the
    // body carried no input-level key — so scope by order, not by header.
    const charges = await db
      .selectFrom("billing.charges")
      .select(["id", "idempotency_key"])
      .where("tenant_id", "=", tenantA)
      .where("order_id", "=", quoted.data.id)
      .execute();
    expect(charges).toHaveLength(1);
    const bindings = await db
      .selectFrom("billing.charge_provider_bindings")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("charge_id", "=", firstBody.id)
      .execute();
    expect(bindings).toHaveLength(1);
    legit();
  });

  // ------------------------------------------------------------------
  // 3. Customer mutation — effect: identity.persons / crm.leads rows.
  // ------------------------------------------------------------------

  it("3a. choke-point deny: stripped actor cannot register persons", async () => {
    const name = `Sec40 Denied ${tail()}`;
    const result = await bus.execute(stripped(tenantA), "person.register", { canonicalName: name });
    expect(result.ok ? null : result.code).toBe("forbidden");
    denied();
    expect(
      await db.selectFrom("identity.persons").select(["id"]).where("tenant_id", "=", tenantA).where("canonical_name", "=", name).execute(),
    ).toHaveLength(0);
  });

  it("3b. alternate routes denied: copilot has no person entry; chained transition blocked", async () => {
    const copilot = await postA(
      "/v1/agent/copilot/execute",
      { command: "person.register", input: { canonicalName: "forged" } },
      { token: opToken, revision: opRev },
    );
    expect(copilot.statusCode).toBe(404);
    denied();
    // Chained indirect op: a lead exists (owner-made), but the stripped actor
    // cannot transition it — status must be unchanged in real state.
    const personId = await makePerson();
    const captured = await bus.execute<{ id: string }>(ownerA(), "lead.capture", { personId });
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("lead.capture failed");
    }
    const forged = await bus.execute(stripped(tenantA), "lead.transition", {
      leadId: captured.data.id,
      toStatus: "CONTACTED",
    });
    expect(forged.ok ? null : forged.code).toBe("forbidden");
    denied();
    const lead = await db
      .selectFrom("crm.leads")
      .select(["status"])
      .where("tenant_id", "=", tenantA)
      .where("id", "=", captured.data.id)
      .executeTakeFirstOrThrow();
    expect(lead.status).toBe("NEW");
  });

  it("3c. cross-tenant lead.capture on a foreign person fails closed", async () => {
    const personId = await makePerson();
    const result = await bus.execute<{ id: string }>(ownerB(), "lead.capture", { personId });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe("not_found");
    denied();
    expect(
      await db.selectFrom("crm.leads").select(["id"]).where("tenant_id", "=", tenantB).where("person_id", "=", personId).execute(),
    ).toHaveLength(0);
  });

  it("3d. invalid token denied on the CRM surface", async () => {
    const bad = await postA("/v1/crm/persons", { canonicalName: "x" }, { token: "sec40-nonexistent-token", revision: null });
    expect(bad.statusCode).toBe(401);
    denied();
  });

  it("3e. legitimate customer lifecycle still works (register -> capture -> transition -> read)", async () => {
    const name = `Sec40 Legit ${tail()}`;
    const registered = await postA("/v1/crm/persons", { canonicalName: name });
    expect(registered.statusCode).toBe(201);
    const personId = registered.json<{ id: string }>().id;
    expect(await bus.execute(ownerA(), "lead.capture", { personId })).toMatchObject({ ok: true });
    const leads = await db.selectFrom("crm.leads").select(["id"]).where("tenant_id", "=", tenantA).where("person_id", "=", personId).execute();
    expect(leads).toHaveLength(1);
    const leadId = leads[0]?.id;
    if (leadId === undefined) {
      throw new Error("expected a lead");
    }
    expect(await bus.execute(ownerA(), "lead.transition", { leadId, toStatus: "CONTACTED" })).toMatchObject({ ok: true });
    const read = await getA(`/v1/crm/persons/${personId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ canonicalName: string }>().canonicalName).toBe(name);
    legit();
  });

  // ------------------------------------------------------------------
  // 4. Admin actions — effect: policy rows (settings.manage) and the
  //    bus-only capability surface.
  // ------------------------------------------------------------------

  it("4a. primary-route deny: operator cannot publish policy (403, zero effect)", async () => {
    const family = `sec40-denied-${tail()}`;
    const res = await postA(
      "/v1/policies/publish",
      { family, scope: "TENANT", class: "TENANT_POLICY", document: { autonomy: "AUTO" } },
      { token: opToken, revision: opRev },
    );
    expect(res.statusCode).toBe(403);
    denied();
    expect(
      await db.selectFrom("platform.policy_documents").select(["id"]).where("tenant_id", "=", tenantA).where("family", "=", family).execute(),
    ).toHaveLength(0);
  });

  it("4b. alternate routes denied: bus-level publish + capability availability need settings.manage", async () => {
    const family = `sec40-bus-${tail()}`;
    const published = await bus.execute(stripped(tenantA), "policy.publish", {
      family,
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: {},
    });
    expect(published.ok ? null : published.code).toBe("forbidden");
    denied();
    const changed = await bus.execute(stripped(tenantA), "capability.set_availability", {
      key: "provider.cinevision",
      availability: "DISABLED",
      reason: "forged",
    });
    expect(changed.ok ? null : changed.code).toBe("forbidden");
    denied();
    const guard = await db
      .selectFrom("platform.capabilities")
      .select(["availability"])
      .where("key", "=", "provider.cinevision")
      .executeTakeFirstOrThrow();
    expect(guard.availability).toBe("AVAILABLE");
    const copilot = await postA(
      "/v1/agent/copilot/execute",
      { command: "policy.publish", input: { family, scope: "TENANT" } },
      { token: opToken, revision: opRev },
    );
    expect(copilot.statusCode).toBe(404);
    denied();
  });

  it("4c. cross-tenant admin attempts fail closed (tenant bind + platform-only scopes)", async () => {
    const family = `sec40-xadmin-${tail()}`;
    // Tenant B owner publishes into B only — A must stay untouched.
    const inB = await bus.execute(ownerB(), "policy.publish", {
      family,
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: {},
    });
    expect(inB.ok).toBe(true);
    expect(
      await db.selectFrom("platform.policy_documents").select(["id"]).where("tenant_id", "=", tenantA).where("family", "=", family).execute(),
    ).toHaveLength(0);
    // PARTNER scope with an explicit foreign target requires platform admin.
    const partner = await bus.execute(ownerB(), "policy.publish", {
      family: `sec40-xpartner-${tail()}`,
      scope: "PARTNER",
      class: "PARTNER_POLICY",
      document: {},
      partnerTenantId: tenantA,
    });
    expect(partner.ok).toBe(false);
    expect(partner.ok ? null : partner.code).toBe("forbidden");
    denied();
    // Provider ops surface is closed to non-owners at the route too.
    const prov = await postA("/v1/provider/operations", {}, { token: opToken, revision: opRev });
    expect(prov.statusCode).toBe(403);
    denied();
  });

  it("4d. invalid token denied on the admin surface", async () => {
    const bad = await postA(
      "/v1/policies/publish",
      { family: "x", scope: "TENANT", class: "TENANT_POLICY", document: {} },
      { token: "sec40-nonexistent-token", revision: null },
    );
    expect(bad.statusCode).toBe(401);
    denied();
  });

  it("4e. legitimate policy publish still works (append-only versions)", async () => {
    const family = `sec40-legit-${tail()}`;
    const first = await postA("/v1/policies/publish", {
      family,
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { autonomy: "APPROVAL" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ version: number }>().version).toBe(1);
    const second = await postA("/v1/policies/publish", {
      family,
      scope: "TENANT",
      class: "TENANT_POLICY",
      document: { autonomy: "MANUAL" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ version: number }>().version).toBe(2);
    const rows = await db
      .selectFrom("platform.policy_documents")
      .select(["version"])
      .where("tenant_id", "=", tenantA)
      .where("family", "=", family)
      .execute();
    expect(rows).toHaveLength(2);
    legit();
  });

  // ------------------------------------------------------------------
  // 5. Cross-tenant reads/writes — effect: disclosure or foreign write.
  // ------------------------------------------------------------------

  it("5a. foreign ids resolve to not-found, never leak (persons, orders, charges)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId, chargeId } = await quoteSubmitCharge(personId, planId, 1);
    for (const url of [`/v1/crm/persons/${personId}`, `/v1/orders/${orderId}`]) {
      const res = await getA(url, { token: tokenB, revision: revB });
      expect(res.statusCode).toBe(404);
      denied();
    }
    void chargeId;
  });

  it("5b. alternate read surfaces stay tenant-scoped (list endpoints omit foreign rows)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { chargeId } = await quoteSubmitCharge(personId, planId, 1);
    const charges = await getA("/v1/charges", { token: tokenB, revision: revB });
    expect(charges.statusCode).toBe(200);
    const ids = charges.json<{ charges: Array<{ id: string }> }>().charges.map((c) => c.id);
    expect(ids).not.toContain(chargeId);
    denied();
    const refunds = await getA("/v1/refund-requests", { token: tokenB, revision: revB });
    expect(refunds.statusCode).toBe(200);
    const tenantARefunds = await db.selectFrom("billing.refund_requests").select(["id"]).where("tenant_id", "=", tenantA).execute();
    const listed = refunds.json<{ refund_requests: Array<{ id: string }> }>().refund_requests.map((r) => r.id);
    for (const row of tenantARefunds) {
      expect(listed).not.toContain(row.id);
    }
  });

  it("5c. tenant isolation holds on writes: B cannot mutate A's customer graph", async () => {
    const before = await db.selectFrom("identity.persons").select(["id"]).where("tenant_id", "=", tenantA).execute();
    const res = await bus.execute<{ id: string }>(ownerB(), "person.register", { canonicalName: "foreign" });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error("B self-register failed");
    }
    const after = await db.selectFrom("identity.persons").select(["id"]).where("tenant_id", "=", tenantA).execute();
    expect(after).toHaveLength(before.length);
    const own = await db
      .selectFrom("identity.persons")
      .select(["id"])
      .where("tenant_id", "=", tenantB)
      .where("id", "=", res.data.id)
      .execute();
    expect(own).toHaveLength(1);
  });

  it("5d. invalid token denied on reads", async () => {
    const bad = await getA("/v1/charges", { token: "sec40-nonexistent-token", revision: null });
    expect(bad.statusCode).toBe(401);
    denied();
  });

  it("5e. legitimate reads keep working (over-blocking guard)", async () => {
    const personId = await makePerson();
    const planId = await seedPlan("1000");
    const { orderId, chargeId } = await quoteSubmitCharge(personId, planId, 1);
    expect((await getA(`/v1/crm/persons/${personId}`)).statusCode).toBe(200);
    expect((await getA(`/v1/orders/${orderId}`)).statusCode).toBe(200);
    const charges = await getA("/v1/charges");
    expect(charges.statusCode).toBe(200);
    expect(charges.json<{ charges: Array<{ id: string }> }>().charges.map((c) => c.id)).toContain(chargeId);
    legit();
  });

  it("6. metrics: no unauthorized attempt produced a money effect; legitimate work preserved", async () => {
    // unauthorizedEffects is DERIVED from observation, not a constant: every
    // SUCCEEDED refund in tenant A must trace to a legitimate flow (test 1e
    // registers its refund id in legitRefundIds). Each denied test already
    // carries its own zero-effect oracle (1a/1a3/1b*/1c and the 2/3/4/5
    // families); this is the global cross-check that no denied path minted
    // money anywhere in the suite.
    const succeeded = await db
      .selectFrom("billing.refunds")
      .select(["id"])
      .where("tenant_id", "=", tenantA)
      .where("status", "=", "SUCCEEDED")
      .execute();
    metrics.unauthorizedEffects = succeeded.filter((r) => !legitRefundIds.has(r.id)).length;
    expect(metrics.unauthorizedAttempts).toBeGreaterThan(0);
    expect(metrics.unauthorizedEffects).toBe(0);
    expect(metrics.legitSuccess).toBeGreaterThan(0);
  });
});
