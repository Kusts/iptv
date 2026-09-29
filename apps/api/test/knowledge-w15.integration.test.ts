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

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "..", "db", "migrations");

const connectionString = process.env["TEST_DATABASE_URL"];
const hasDb = typeof connectionString === "string" && connectionString.length > 0;

function email(prefix: string): string {
  return `${prefix}-${newId().replace(/-/g, "").slice(-12)}@example.com`;
}

const PERMISSIONS = [
  "crm.lead.write",
  "support.ticket.read",
  "support.ticket.write",
  "knowledge.read",
  "knowledge.write",
];

describe.skipIf(!hasDb)("Wave 15 Knowledge maturation (requires TEST_DATABASE_URL)", () => {
  let app: NestFastifyApplication;
  const db = createDb({ connectionString: connectionString as string });

  let token = "";
  let tenantId = "";
  let userId = "";
  let otherToken = "";
  let bus: CommandBus;

  function actor(): CommandActor {
    return {
      userId,
      isPlatformAdmin: false,
      tenantId,
      roleKeys: ["tenant_owner"],
      permissions: PERMISSIONS,
      actorType: "human",
    };
  }

  function otherActor(): CommandActor {
    return { ...actor(), tenantId: otherTenantId, permissions: PERMISSIONS };
  }
  let otherTenantId = "";

  function injectRaw(opts: {
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

  async function ok<T>(result: { ok: boolean; data?: T; message?: string }, what: string): Promise<T> {
    if (!result.ok) {
      throw new Error(`${what} failed: ${(result as { message: string }).message}`);
    }
    return (result as { ok: true; data: T }).data;
  }

  async function eventTypesFor(aggregateId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("platform.domain_events")
      .select("event_type")
      .where("aggregate_id", "=", aggregateId)
      .execute();
    return rows.map((r) => r.event_type);
  }

  beforeAll(async () => {
    await applyMigrations(connectionString as string, { migrationsDir: MIGRATIONS_DIR });
    process.env["DATABASE_URL"] = connectionString as string;
    process.env["BETTER_AUTH_SECRET"] = "integration-test-secret-0123456789";
    app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
    registerRequestIdHook(app);
    await app.init();
    bus = app.get(CommandBus);

    const register = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w15"), password: "correct-horse-15", tenantName: "Wave15 Tenant" },
    });
    expect(register.statusCode).toBe(201);
    const body = register.json<{ token: string; activeTenantId: string; user: { id: string } }>();
    token = body.token;
    tenantId = body.activeTenantId;
    userId = body.user.id;

    const other = await injectRaw({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: email("w15other"), password: "correct-horse-15", tenantName: "Wave15 Other" },
    });
    expect(other.statusCode).toBe(201);
    const otherBody = other.json<{ token: string; activeTenantId: string }>();
    otherToken = otherBody.token;
    otherTenantId = otherBody.activeTenantId;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("verifies items with evidence and keeps re-verify idempotent", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FAQ",
        contentText: "Reinicie o app e valide a credencial.",
      }),
      "item.create",
    );
    const verified = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id, evidence: "validado no ticket #1" }),
      "item.verify",
    );
    expect(verified.status).toBe("VERIFIED");
    expect(await eventTypesFor(created.id)).toContain("knowledge.item.verified.v1");

    const again = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id }),
      "item.verify idempotent",
    );
    expect(again.status).toBe("VERIFIED");

    const missing = await bus.execute(actor(), "knowledge.item.verify", { itemId: newId() });
    expect(missing.ok).toBe(false);

    await ok(await bus.execute(actor(), "knowledge.item.archive", { itemId: created.id }), "archive");
    const afterArchive = await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id });
    expect(afterArchive.ok).toBe(false);
  });

  it("supersedes verified items with a substitute version", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "PROCEDURE",
        contentText: "Passo antigo de ativacao.",
      }),
      "item.create",
    );
    await ok(await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id }), "verify");
    const superseded = await ok<{ id: string; version: number; status: string }>(
      await bus.execute(actor(), "knowledge.item.supersede", {
        itemId: created.id,
        contentText: "Passo novo de ativacao.",
        evidence: "procedimento atualizado",
      }),
      "item.supersede",
    );
    expect(superseded.status).toBe("SUPERSEDED");
    expect(superseded.version).toBe(2);
    expect(await eventTypesFor(created.id)).toContain("knowledge.superseded.v1");

    const selfRef = await bus.execute(actor(), "knowledge.item.supersede", {
      itemId: created.id,
      supersededByItemId: created.id,
    });
    // Already SUPERSEDED → idempotent short-circuit wins over the self check.
    expect(selfRef.ok).toBe(true);

    const other = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FAQ",
        contentText: "Outro conteudo.",
      }),
      "other.create",
    );
    const badSelf = await bus.execute(otherActor(), "knowledge.item.supersede", {
      itemId: other.id,
      supersededByItemId: other.id,
    });
    expect(badSelf.ok).toBe(false);
  });

  it("applies corrections as new versions and rejects the rest", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FAQ",
        contentText: "Texto com erro de digitacao.",
      }),
      "item.create",
    );
    await ok(await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id }), "verify");

    const proposed = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.correction.propose", {
        itemId: created.id,
        proposedText: "Texto corrigido.",
      }),
      "correction.propose",
    );
    expect(proposed.status).toBe("OPEN");

    const applied = await ok<{ id: string; status: string; version: number | null }>(
      await bus.execute(actor(), "knowledge.correction.apply", { correctionId: proposed.id }),
      "correction.apply",
    );
    expect(applied.status).toBe("APPLIED");
    expect(applied.version).toBe(2);
    expect(await eventTypesFor(created.id)).toContain("knowledge.correction.applied.v1");

    const current = await db
      .selectFrom("knowledge.knowledge_versions")
      .select(["version_no", "content_text"])
      .where("tenant_id", "=", tenantId)
      .where("knowledge_item_id", "=", created.id)
      .orderBy("version_no", "desc")
      .limit(1)
      .executeTakeFirst();
    expect(current?.content_text).toBe("Texto corrigido.");

    const second = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.correction.propose", {
        itemId: created.id,
        proposedText: "Outra sugestao.",
      }),
      "second propose",
    );
    const rejected = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.correction.reject", { correctionId: second.id, reason: "fora de escopo" }),
      "correction.reject",
    );
    expect(rejected.status).toBe("REJECTED");
    const reapply = await bus.execute(actor(), "knowledge.correction.apply", { correctionId: second.id });
    expect(reapply.ok).toBe(false);
  });

  it("records gaps from tickets without usable solutions and closes them", async () => {
    const personId = (
      await ok<{ id: string }>(await bus.execute(actor(), "person.register", { canonicalName: "W15 Person" }), "person")
    ).id;
    const ticket = await ok<{ id: string }>(
      await bus.execute(actor(), "support.ticket.open", {
        personId,
        priority: "HIGH",
        summary: "Erro desconhecido ao renovar assinatura",
      }),
      "ticket.open",
    );

    const gap = await ok<{ id: string; status: string; ticketHadSolution: boolean | null }>(
      await bus.execute(actor(), "knowledge.gap.record", {
        question: "Como resolver o erro desconhecido na renovacao?",
        supportTicketId: ticket.id,
      }),
      "gap.record",
    );
    expect(gap.status).toBe("OPEN");
    expect(gap.ticketHadSolution).toBe(false);

    const unknownTicket = await bus.execute(actor(), "knowledge.gap.record", {
      question: "Pergunta orfa?",
      supportTicketId: newId(),
    });
    expect(unknownTicket.ok).toBe(false);

    // Idempotent replay: the same idempotency key returns the same gap.
    const key = `w15-gap-${newId()}`;
    const first = await ok<{ id: string }>(
      await bus.execute(
        actor(),
        "knowledge.gap.record",
        { question: "Pergunta com replay?" },
        { idempotencyKey: key },
      ),
      "gap first",
    );
    const replay = await ok<{ id: string }>(
      await bus.execute(
        actor(),
        "knowledge.gap.record",
        { question: "Pergunta com replay?" },
        { idempotencyKey: key },
      ),
      "gap replay",
    );
    expect(replay.id).toBe(first.id);

    const closed = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.gap.close", { gapId: gap.id }),
      "gap.close",
    );
    expect(closed.status).toBe("CLOSED");
    const closedAgain = await ok<{ id: string; status: string }>(
      await bus.execute(actor(), "knowledge.gap.close", { gapId: gap.id }),
      "gap.close idempotent",
    );
    expect(closedAgain.status).toBe("CLOSED");
  });

  it("drives gap candidates from proposal to publish via HTTP", async () => {
    const gap = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.gap.record", { question: "Como configurar o app na TV?" }),
      "gap.record",
    );
    const proposed = await injectRaw({
      method: "POST",
      url: `/v1/knowledge/gaps/${gap.id}/candidates`,
      token,
      payload: { knowledgeType: "FAQ", contentText: "Abra ajustes e informe o codigo." },
    });
    expect(proposed.statusCode).toBe(201);
    const candidate = proposed.json<{ candidateId: string; itemId: string; status: string }>();
    expect(candidate.status).toBe("PROPOSED");

    const decide = await injectRaw({
      method: "POST",
      url: `/v1/knowledge/candidates/${candidate.candidateId}/decision`,
      token,
      payload: { decision: "PUBLISHED" },
    });
    expect(decide.statusCode).toBe(201);
    expect(decide.json<{ status: string }>().status).toBe("PUBLISHED");

    const item = await injectRaw({ method: "GET", url: `/v1/knowledge/items/${candidate.itemId}`, token });
    expect(item.statusCode).toBe(200);
    expect(item.json<{ item: { status: string } }>().item.status).toBe("VERIFIED");

    const gaps = await injectRaw({ method: "GET", url: "/v1/knowledge/gaps?status=RESEARCHING", token });
    expect(gaps.statusCode).toBe(200);
    expect(gaps.json<{ gaps: { id: string }[] }>().gaps.map((g) => g.id)).toContain(gap.id);

    const stored = await db
      .selectFrom("knowledge.knowledge_gaps")
      .select("status")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", gap.id)
      .executeTakeFirst();
    expect(stored?.status).toBe("RESEARCHING");
  });

  it("refreshes freshness and degrades stale verified items", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FACT",
        contentText: "Fato que envelhece.",
      }),
      "item.create",
    );
    await ok(await bus.execute(actor(), "knowledge.item.verify", { itemId: created.id }), "verify");
    // Age the item beyond any reasonable half-life (direct row touch on
    // the mutable item pointer only — version history stays append-only).
    const ancient = new Date(Date.now() - 400 * 86_400_000);
    await db
      .updateTable("knowledge.knowledge_items")
      .set({ updated_at: ancient })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", created.id)
      .execute();

    const refreshed = await ok<{ refreshed: number; degraded: string[] }>(
      await bus.execute(actor(), "knowledge.freshness.refresh", {}),
      "freshness.refresh",
    );
    expect(refreshed.refreshed).toBeGreaterThanOrEqual(1);
    expect(refreshed.degraded).toContain(created.id);

    const row = await db
      .selectFrom("knowledge.knowledge_items")
      .select(["status", "freshness_score"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", created.id)
      .executeTakeFirst();
    expect(row?.status).toBe("DEGRADED");
    expect(Number(row?.freshness_score)).toBeLessThan(0.3);
    expect(await eventTypesFor(created.id)).toContain("knowledge.degraded.v1");

    const listed = await injectRaw({ method: "GET", url: "/v1/knowledge/items?status=DEGRADED", token });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toContain(created.id);
  });

  it("isolates knowledge maturation per tenant (F14: failures never touch sales)", async () => {
    const created = await ok<{ id: string }>(
      await bus.execute(actor(), "knowledge.item.create", {
        knowledgeType: "FAQ",
        contentText: "Conteudo do tenant A.",
      }),
      "item.create",
    );
    // Cross-tenant verify sees nothing (tenant-scoped reads).
    const foreign = await bus.execute(otherActor(), "knowledge.item.verify", { itemId: created.id });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.code).toBe("not_found");
    }
    const foreignCorrections = await injectRaw({ method: "GET", url: "/v1/knowledge/corrections", token: otherToken });
    expect(foreignCorrections.statusCode).toBe(200);
    expect(foreignCorrections.json<{ corrections: unknown[] }>().corrections).toHaveLength(0);
    const foreignGaps = await injectRaw({ method: "GET", url: "/v1/knowledge/gaps", token: otherToken });
    expect(foreignGaps.statusCode).toBe(200);
    expect(foreignGaps.json<{ gaps: unknown[] }>().gaps).toHaveLength(0);

    // A failed knowledge command leaves every other aggregate usable:
    // the sales-adjacent support flow still opens tickets afterwards.
    const failed = await bus.execute(actor(), "knowledge.item.verify", { itemId: newId() });
    expect(failed.ok).toBe(false);
    const personId = (
      await ok<{ id: string }>(
        await bus.execute(actor(), "person.register", { canonicalName: "W15 After Failure" }),
        "person after failure",
      )
    ).id;
    const ticket = await ok<{ id: string }>(
      await bus.execute(actor(), "support.ticket.open", { personId, priority: "NORMAL", summary: "Vendas seguem ok" }),
      "ticket after knowledge failure",
    );
    expect(ticket.id).toBeTruthy();
  });
});
