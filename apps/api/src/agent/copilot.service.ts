import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../commands/command-bus.js";

/**
 * Wave 14-COPILOT (G18): Tenant Copilot service.
 *
 * - Screen context is assembled permission-scoped: every section is gated
 *   by the caller's own `agent.*`/read permission. A denied section is
 *   silently omitted (never a global 403), and entity reads are strictly
 *   tenant-scoped (foreign ids resolve to null, never leak).
 * - `ask` is a deterministic stub (no real LLM call): it explains the
 *   current screen from permission-scoped facts and MAY propose
 *   `draftCommands`. It NEVER writes a domain row.
 * - `execute` never runs a command directly past authorization: the target
 *   command permission is re-checked, HIGH-risk commands create a
 *   `HumanReviewRequest` (existing HITL) instead of executing, and
 *   MEDIUM/LOW commands run through the normal `CommandBus` (same
 *   command/policy/audit pipeline as the manual UI).
 */

export interface CopilotScreen {
  route: string;
  entityKind?: string;
  entityId?: string;
  selection?: Array<{ kind: string; id: string }>;
  filters?: Record<string, string>;
}

export interface CopilotSection {
  key: string;
  title: string;
  summary: string;
  deepLink: string;
  entity: Record<string, unknown> | null;
}

export interface CopilotContextResponse {
  route: string;
  sections: CopilotSection[];
  generatedAt: string;
}

export interface CopilotSuggestion {
  kind: "navigate" | "draft" | "info";
  label: string;
  deepLink?: string;
  draftCommand?: string;
  draftInput?: Record<string, unknown>;
  needsInput?: string[];
  reason?: string;
}

export interface CopilotAskResponse {
  summary: string;
  confidence: "OBSERVED" | "INFERRED";
  sectionsUsed: string[];
  data: Record<string, unknown>;
  suggestions: CopilotSuggestion[];
  deepLinks: Array<{ label: string; href: string }>;
}

export type CopilotExecuteStatus =
  | "executed"
  | "pending_review"
  | "denied"
  | "stale"
  | "consumed"
  | "unknown_command"
  | "not_found"
  | "invalid";

export interface CopilotExecuteResponse {
  status: CopilotExecuteStatus;
  message: string;
  command: string;
  data?: Record<string, unknown>;
  reviewId?: string;
}

interface AllowedCommand {
  permission: string;
  risk: "MEDIUM" | "HIGH";
  label: string;
}

/**
 * Closed allowlist: only these commands may run through the Copilot, each
 * with its target permission and risk class. Unknown names are rejected
 * before any permission check (deny-by-default).
 */
export const COPILOT_COMMANDS: Record<string, AllowedCommand> = {
  "support.ticket.open": {
    permission: "support.ticket.write",
    risk: "MEDIUM",
    label: "Abrir ticket de suporte",
  },
  "support.ticket.add_solution_attempt": {
    permission: "support.ticket.write",
    risk: "MEDIUM",
    label: "Registrar tentativa de solução",
  },
  "support.ticket.resolve": {
    permission: "support.ticket.write",
    risk: "HIGH",
    label: "Resolver ticket de suporte",
  },
  "support.ticket.close": {
    permission: "support.ticket.write",
    risk: "HIGH",
    label: "Encerrar ticket de suporte",
  },
  "support.ticket.reopen": {
    permission: "support.ticket.write",
    risk: "HIGH",
    label: "Reabrir ticket de suporte",
  },
  "billing.refund.request": {
    permission: "billing.refund.request",
    risk: "HIGH",
    label: "Solicitar reembolso",
  },
  "subscription.cancel_at_period_end": {
    permission: "subscription.write",
    risk: "HIGH",
    label: "Cancelar assinatura ao fim do período",
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPEN_TICKET_STATUSES = [
  "NEW",
  "TRIAGING",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "WAITING_PROVIDER",
];

const OPEN_REVIEW_STATUSES = ["REQUESTED", "QUEUED", "ACKNOWLEDGED", "IN_REVIEW"];

function hasPermission(actor: CommandActor, permission: string): boolean {
  if (actor.isPlatformAdmin) {
    return true;
  }
  return actor.permissions.includes(permission);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function inputHash(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input), "utf8").digest("hex");
}

@Injectable()
export class CopilotService {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
  ) {}

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new Error("database is not configured");
    }
    return this.db;
  }

  // ------------------------------------------------------------------
  // Screen context (permission-scoped reads, silent per-section denial).
  // ------------------------------------------------------------------

  async buildContext(tenantId: string, actor: CommandActor, screen: CopilotScreen): Promise<CopilotContextResponse> {
    const db = this.requireDb();
    const sections: CopilotSection[] = [];

    if (hasPermission(actor, "support.ticket.read")) {
      const counts = await db
        .selectFrom("support.support_tickets")
        .select([(eb) => eb.fn.countAll().as("n"), "status"])
        .where("tenant_id", "=", tenantId)
        .groupBy("status")
        .execute();
      const open = counts.filter((c) => OPEN_TICKET_STATUSES.includes(c.status)).reduce((acc, c) => acc + Number(c.n), 0);
      let entity: Record<string, unknown> | null = null;
      if (screen.entityKind === "ticket" && screen.entityId !== undefined && UUID_RE.test(screen.entityId)) {
        const row = await db
          .selectFrom("support.support_tickets")
          .select(["id", "status", "priority", "summary", "person_id"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", screen.entityId)
          .executeTakeFirst();
        entity =
          row === undefined
            ? null
            : { id: row.id, status: row.status, priority: row.priority, summary: row.summary, personId: row.person_id };
      }
      sections.push({
        key: "tickets",
        title: "Suporte",
        summary: `${open} ticket(s) aberto(s) neste tenant.`,
        deepLink: "/support",
        entity,
      });
    }

    if (hasPermission(actor, "crm.person.read")) {
      const counts = await db
        .selectFrom("communication.conversations")
        .select([(eb) => eb.fn.countAll().as("n"), "status"])
        .where("tenant_id", "=", tenantId)
        .groupBy("status")
        .execute();
      const open = counts.filter((c) => c.status === "OPEN").reduce((acc, c) => acc + Number(c.n), 0);
      let entity: Record<string, unknown> | null = null;
      if (screen.entityKind === "conversation" && screen.entityId !== undefined && UUID_RE.test(screen.entityId)) {
        const row = await db
          .selectFrom("communication.conversations")
          .select(["id", "status", "control_mode", "channel", "person_id"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", screen.entityId)
          .executeTakeFirst();
        entity =
          row === undefined
            ? null
            : {
                id: row.id,
                status: row.status,
                controlMode: row.control_mode,
                channel: row.channel,
                personId: row.person_id,
              };
      }
      sections.push({
        key: "conversations",
        title: "Conversas",
        summary: `${open} conversa(s) aberta(s) neste tenant.`,
        deepLink: "/conversations",
        entity,
      });
    }

    if (hasPermission(actor, "billing.read")) {
      const counts = await db
        .selectFrom("commerce.orders")
        .select([(eb) => eb.fn.countAll().as("n"), "status"])
        .where("tenant_id", "=", tenantId)
        .groupBy("status")
        .execute();
      const total = counts.reduce((acc, c) => acc + Number(c.n), 0);
      let entity: Record<string, unknown> | null = null;
      if (screen.entityKind === "order" && screen.entityId !== undefined && UUID_RE.test(screen.entityId)) {
        const row = await db
          .selectFrom("commerce.orders")
          .select(["id", "status", "currency", "net_amount_minor", "settled_amount_minor"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", screen.entityId)
          .executeTakeFirst();
        entity =
          row === undefined
            ? null
            : {
                id: row.id,
                status: row.status,
                currency: row.currency,
                netAmountMinor: String(row.net_amount_minor),
                settledAmountMinor: String(row.settled_amount_minor),
              };
      }
      sections.push({
        key: "orders",
        title: "Pedidos",
        summary: `${total} pedido(s) neste tenant.`,
        deepLink: "/orders",
        entity,
      });
    }

    if (hasPermission(actor, "subscription.read")) {
      const active = await db
        .selectFrom("subscription.subscriptions")
        .select([(eb) => eb.fn.countAll().as("n")])
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "ACTIVE")
        .executeTakeFirstOrThrow();
      let entity: Record<string, unknown> | null = null;
      if (screen.entityKind === "subscription" && screen.entityId !== undefined && UUID_RE.test(screen.entityId)) {
        const row = await db
          .selectFrom("subscription.subscriptions")
          .select(["id", "status", "current_period_end"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", screen.entityId)
          .executeTakeFirst();
        entity =
          row === undefined
            ? null
            : {
                id: row.id,
                status: row.status,
                currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
              };
      }
      sections.push({
        key: "subscriptions",
        title: "Assinaturas",
        summary: `${Number(active.n)} assinatura(s) ativa(s) neste tenant.`,
        deepLink: "/subscriptions",
        entity,
      });
    }

    if (hasPermission(actor, "agent.review.request")) {
      const open = await db
        .selectFrom("agent.human_review_requests")
        .select([(eb) => eb.fn.countAll().as("n")])
        .where("tenant_id", "=", tenantId)
        .where("status", "in", OPEN_REVIEW_STATUSES)
        .executeTakeFirstOrThrow();
      sections.push({
        key: "reviews",
        title: "Revisões humanas",
        summary: `${Number(open.n)} item(ns) aguardando revisão humana.`,
        deepLink: "/hitl",
        entity: null,
      });
    }

    return { route: screen.route, sections, generatedAt: new Date().toISOString() };
  }

  // ------------------------------------------------------------------
  // Ask (deterministic stub — reads only, never writes domain rows).
  // ------------------------------------------------------------------

  async ask(tenantId: string, actor: CommandActor, question: string, screen: CopilotScreen): Promise<CopilotAskResponse> {
    const context = await this.buildContext(tenantId, actor, screen);
    const normalized = question.toLowerCase();
    const byKey = new Map(context.sections.map((s) => [s.key, s]));
    const sectionsUsed = context.sections.map((s) => s.key);

    const parts: string[] = [];
    parts.push(`Você está em ${screen.route}.`);
    const tickets = byKey.get("tickets");
    if (tickets !== undefined) {
      parts.push(tickets.summary);
    }
    const conversations = byKey.get("conversations");
    if (conversations !== undefined) {
      parts.push(conversations.summary);
    }
    const reviews = byKey.get("reviews");
    if (reviews !== undefined) {
      parts.push(reviews.summary);
    }
    const focused = context.sections.find((s) => s.entity !== null && s.entity !== undefined);
    if (focused?.entity !== null && focused?.entity !== undefined) {
      const entity = focused.entity as { id: string; status?: string };
      parts.push(`Registro em foco: ${focused.key} ${entity.id} (status ${String(entity.status ?? "desconhecido")}).`);
    }
    if (screen.filters !== undefined && Object.keys(screen.filters).length > 0) {
      parts.push(`Filtros ativos: ${Object.entries(screen.filters).map(([k, v]) => `${k}=${v}`).join(", ")}.`);
    }

    const suggestions: CopilotSuggestion[] = [];
    const deepLinks: Array<{ label: string; href: string }> = context.sections.map((s) => ({
      label: s.title,
      href: s.deepLink,
    }));

    const selectionPerson = (screen.selection ?? []).find((s) => s.kind === "person" && UUID_RE.test(s.id));

    if (/abr(ir|a|e)|criar|nov[oa]\s+ticket|open\s+ticket/.test(normalized) && byKey.has("tickets")) {
      if (selectionPerson !== undefined) {
        suggestions.push({
          kind: "draft",
          label: "Preparar abertura de ticket",
          draftCommand: "support.ticket.open",
          draftInput: { personId: selectionPerson.id, priority: "NORMAL", summary: question.slice(0, 500) },
          reason: "Comando de risco médio: executa pelo pipeline autorizado.",
        });
      } else {
        suggestions.push({
          kind: "draft",
          label: "Preparar abertura de ticket",
          draftCommand: "support.ticket.open",
          draftInput: { priority: "NORMAL", summary: question.slice(0, 500) },
          needsInput: ["personId"],
          reason: "Informe a pessoa (cliente) para concluir o draft.",
        });
      }
    } else if (
      /resolver|concluir/.test(normalized) &&
      focused?.key === "tickets" &&
      focused.entity !== null
    ) {
      const entity = focused.entity as { id: string; status?: string };
      suggestions.push({
        kind: "draft",
        label: "Preparar resolução do ticket em foco",
        draftCommand: "support.ticket.resolve",
        draftInput: { ticketId: entity.id, expectedStatus: entity.status },
        reason: "Ação sensível: exige aprovação humana (HITL) antes de executar.",
      });
    } else if (/fechar|encerrar/.test(normalized) && focused?.key === "tickets" && focused.entity !== null) {
      const entity = focused.entity as { id: string; status?: string };
      suggestions.push({
        kind: "draft",
        label: "Preparar encerramento do ticket em foco",
        draftCommand: "support.ticket.close",
        draftInput: { ticketId: entity.id },
        reason: "Ação sensível: exige aprovação humana (HITL) antes de executar.",
      });
    } else if (/reembols|refund/.test(normalized)) {
      suggestions.push({
        kind: "draft",
        label: "Preparar solicitação de reembolso",
        draftCommand: "billing.refund.request",
        draftInput: {},
        needsInput: ["paymentId", "amountMinor"],
        reason: "Ação financeira: exige aprovação humana (HITL) antes de executar.",
      });
    } else {
      const target =
        /conversa|inbox|whatsapp/.test(normalized)
          ? "/conversations"
          : /pedido|cobran|pagamento|order/.test(normalized)
            ? "/orders"
            : /assinatura|subscription/.test(normalized)
              ? "/subscriptions"
              : /revis|aprov|hitl/.test(normalized)
                ? "/hitl"
                : null;
      if (target !== null) {
        suggestions.push({ kind: "navigate", label: `Abrir visão filtrada: ${target}`, deepLink: target });
      } else {
        suggestions.push({
          kind: "info",
          label: "Nenhuma ação proposta: refine a pergunta ou selecione um registro.",
        });
      }
    }

    return {
      summary: parts.join(" "),
      confidence: "OBSERVED",
      sectionsUsed,
      data: Object.fromEntries(context.sections.map((s) => [s.key, { summary: s.summary, entity: s.entity }])),
      suggestions,
      deepLinks,
    };
  }

  // ------------------------------------------------------------------
  // Execute (authorized pipeline only; HIGH risk → HITL review).
  // ------------------------------------------------------------------

  async execute(
    tenantId: string,
    actor: CommandActor,
    command: string,
    input: Record<string, unknown>,
    opts: { reviewId?: string; idempotencyKey?: string; correlationId?: string } = {},
  ): Promise<{ http: number; body: CopilotExecuteResponse }> {
    const allowed = COPILOT_COMMANDS[command];
    if (allowed === undefined) {
      return {
        http: 404,
        body: { status: "unknown_command", message: `comando não suportado pelo Copilot: ${command}`, command },
      };
    }
    if (!hasPermission(actor, allowed.permission)) {
      return {
        http: 403,
        body: {
          status: "denied",
          message: `Você não tem permissão para ${allowed.label} (${allowed.permission}).`,
          command,
        },
      };
    }

    if (allowed.risk === "HIGH") {
      if (opts.reviewId === undefined) {
        return this.requestReview(tenantId, actor, command, allowed, input, opts.correlationId);
      }
      return this.executeApproved(
        tenantId,
        actor,
        command,
        allowed,
        input,
        opts.reviewId,
        opts.idempotencyKey,
        opts.correlationId,
      );
    }

    const stale = await this.checkStale(tenantId, command, input);
    if (stale !== null) {
      return { http: 409, body: { status: "stale", message: stale, command } };
    }
    const result = await this.bus.execute(actor, command, input, {
      idempotencyKey: opts.idempotencyKey,
      correlationId: opts.correlationId ?? newId(),
      causationId: null,
    });
    return this.fromBusResult(command, result);
  }

  private async requestReview(
    tenantId: string,
    actor: CommandActor,
    command: string,
    allowed: AllowedCommand,
    input: Record<string, unknown>,
    correlationId?: string,
  ): Promise<{ http: number; body: CopilotExecuteResponse }> {
    if (!hasPermission(actor, "agent.review.request")) {
      return {
        http: 403,
        body: { status: "denied", message: "Você não tem permissão para solicitar revisão humana.", command },
      };
    }
    const db = this.requireDb();
    const hash = inputHash(input);
    const open = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "context_json"])
      .where("tenant_id", "=", tenantId)
      .where("resource_type", "=", "copilot_command")
      .where("status", "in", OPEN_REVIEW_STATUSES)
      .execute();
    const existing = open.find((r) => {
      const ctx = (r.context_json ?? {}) as Record<string, unknown>;
      return ctx["copilotCommand"] === command && ctx["copilotInputHash"] === hash;
    });
    if (existing !== undefined) {
      return {
        http: 201,
        body: {
          status: "pending_review",
          message: "Já existe uma revisão pendente para esta ação; nada foi executado.",
          command,
          reviewId: existing.id,
        },
      };
    }
    const created = await this.bus.execute<{ id: string }>(
      actor,
      "human_review.request",
      {
        resourceType: "copilot_command",
        resourceId: newId(),
        reviewMode: "APPROVAL",
        reason: "RISK_REVIEW",
        riskClass: "R2",
        priority: "NORMAL",
        summary: `Copilot: ${allowed.label} (${command})`.slice(0, 500),
        contextJson: { copilot: true, copilotCommand: command, copilotInput: input, copilotInputHash: hash },
      },
      { correlationId: correlationId ?? newId(), causationId: null },
    );
    if (!created.ok) {
      return this.fromBusResult(command, created);
    }
    return {
      http: 201,
      body: {
        status: "pending_review",
        message: "Ação sensível enviada para aprovação humana; nada foi executado.",
        command,
        reviewId: created.data.id,
      },
    };
  }

  private async executeApproved(
    tenantId: string,
    actor: CommandActor,
    command: string,
    allowed: AllowedCommand,
    input: Record<string, unknown>,
    reviewId: string,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<{ http: number; body: CopilotExecuteResponse }> {
    if (!UUID_RE.test(reviewId)) {
      return { http: 400, body: { status: "invalid", message: "reviewId inválido.", command } };
    }
    const db = this.requireDb();
    const review = await db
      .selectFrom("agent.human_review_requests")
      .select(["id", "status", "resource_type", "requested_by_id", "context_json"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", reviewId)
      .executeTakeFirst();
    if (review === undefined || review.resource_type !== "copilot_command") {
      return { http: 404, body: { status: "not_found", message: "Revisão não encontrada neste tenant.", command } };
    }
    const ctx = (review.context_json ?? {}) as Record<string, unknown>;
    if (ctx["copilotCommand"] !== command || ctx["copilotInputHash"] !== inputHash(input)) {
      return {
        http: 409,
        body: { status: "stale", message: "A aprovação não corresponde a este comando/insumo.", command },
      };
    }
    if (review.status !== "RESOLVED") {
      return {
        http: 409,
        body: { status: "stale", message: `Revisão ainda não aprovada (status ${review.status}).`, command },
      };
    }
    const approval = await db
      .selectFrom("agent.human_review_actions")
      .select(["action_type", "actor_user_id"])
      .where("tenant_id", "=", tenantId)
      .where("human_review_request_id", "=", reviewId)
      .where("action_type", "in", ["APPROVE", "REJECT"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (approval === undefined || approval.action_type !== "APPROVE") {
      return { http: 409, body: { status: "stale", message: "Revisão não foi aprovada.", command } };
    }
    // Defense in depth (approval-time revalidator is the primary guard):
    // even a legacy approval granted before the no-self-approval rule must
    // not execute when the requester approved their own action.
    if (review.requested_by_id !== null && approval.actor_user_id === review.requested_by_id) {
      return {
        http: 403,
        body: {
          status: "denied",
          message: "Autoaprovação proibida: o solicitante não pode aprovar a própria ação.",
          command,
        },
      };
    }
    void allowed;
    const stale = await this.checkStale(tenantId, command, input);
    if (stale !== null) {
      return { http: 409, body: { status: "stale", message: stale, command } };
    }
    // Single-use authorization: atomically claim the approval before
    // executing. The UNIQUE guard makes the claim conditional — a second
    // execute with the same reviewId loses the race and fails with 409.
    const claimed = await this.claimConsumption(tenantId, reviewId, command, inputHash(input), actor.userId);
    if (!claimed) {
      return {
        http: 409,
        body: { status: "consumed", message: "Aprovação já utilizada por uma execução anterior.", command },
      };
    }
    let result: Awaited<ReturnType<CommandBus["execute"]>>;
    try {
      result = await this.bus.execute(actor, command, input, {
        idempotencyKey,
        correlationId: correlationId ?? newId(),
        causationId: null,
      });
    } catch (err) {
      await this.releaseConsumption(tenantId, reviewId);
      throw err;
    }
    if (!result.ok) {
      // Nothing executed (validation/forbidden/precondition leave no state
      // behind), so release the claim and let the caller retry honestly.
      await this.releaseConsumption(tenantId, reviewId);
    }
    return this.fromBusResult(command, result);
  }

  /**
   * Conditional single-use claim: INSERT wins exactly once per review
   * (UNIQUE on tenant + review). Returns false when another execution
   * already consumed the approval.
   */
  private async claimConsumption(
    tenantId: string,
    reviewId: string,
    command: string,
    commandHash: string,
    actorUserId: string,
  ): Promise<boolean> {
    try {
      await this.requireDb()
        .insertInto("agent.copilot_review_consumptions")
        .values({
          id: newId(),
          tenant_id: tenantId,
          human_review_request_id: reviewId,
          command,
          command_hash: commandHash,
          consumed_by_actor_id: actorUserId,
          consumed_at: new Date(),
        })
        .execute();
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        return false;
      }
      throw err;
    }
  }

  private async releaseConsumption(tenantId: string, reviewId: string): Promise<void> {
    await this.requireDb()
      .deleteFrom("agent.copilot_review_consumptions")
      .where("tenant_id", "=", tenantId)
      .where("human_review_request_id", "=", reviewId)
      .execute();
  }

  /**
   * Optimistic stale guard for ticket commands carrying `expectedStatus`:
   * re-reads the current status under the tenant scope before executing.
   * Foreign ids are "not found" (never leak cross-tenant existence).
   */
  private async checkStale(tenantId: string, command: string, input: Record<string, unknown>): Promise<string | null> {
    if (!command.startsWith("support.ticket.")) {
      return null;
    }
    const expected = input["expectedStatus"];
    if (typeof expected !== "string" || expected.length === 0) {
      return null;
    }
    const ticketId = input["ticketId"];
    if (typeof ticketId !== "string" || !UUID_RE.test(ticketId)) {
      return null;
    }
    const row = await this.requireDb()
      .selectFrom("support.support_tickets")
      .select(["status"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", ticketId)
      .executeTakeFirst();
    if (row === undefined) {
      return "Registro não encontrado neste tenant.";
    }
    if (row.status !== expected) {
      return `Recurso desatualizado: esperado ${expected}, atual ${row.status}. Recarregue e tente de novo.`;
    }
    return null;
  }

  private fromBusResult(
    command: string,
    result:
      | { ok: true; data: unknown }
      | { ok: false; code: "not_found" | "forbidden" | "validation_failed" | "precondition_failed"; message: string },
  ): { http: number; body: CopilotExecuteResponse } {
    if (result.ok) {
      return {
        http: 200,
        body: { status: "executed", message: "Comando executado pelo pipeline autorizado.", command, data: result.data as Record<string, unknown> },
      };
    }
    switch (result.code) {
      case "forbidden":
        return { http: 403, body: { status: "denied", message: result.message, command } };
      case "not_found":
        return { http: 404, body: { status: "not_found", message: result.message, command } };
      case "precondition_failed":
        return { http: 409, body: { status: "stale", message: result.message, command } };
      default:
        return { http: 400, body: { status: "invalid", message: result.message, command } };
    }
  }
}
