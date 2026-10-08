import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import type { FastifyRequest, FastifyReply } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { AgentPipeline } from "./pipeline.js";
import { CopilotService, type CopilotScreen } from "./copilot.service.js";
import { runAgentEvalSet, type AgentEvalSummary } from "./eval-runner.js";

function actorFromRequest(req: FastifyRequest): CommandActor {
  const auth = req.auth as NonNullable<FastifyRequest["auth"]>;
  const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
  return commandActorFromRequestParts({
    userId: auth.userId,
    isPlatformAdmin: auth.isPlatformAdmin,
    tenantId: tenant.id,
    roleKeys: tenant.roleKeys,
    permissions: tenant.permissions,
    actorType: "human",
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wave 3 agent surface:
 * - `GET /v1/agent/runs` — tenant-scoped evaluation history per conversation.
 * - `POST /v1/agent/evals/run` — offline eval fixture set through the echo
 *   gateway (never a live model; platform or tenant admin).
 * - `POST /v1/agent/reviews/:id/approve|reject` — HITL resume path: approve
 *   revalidates conversation state and sends via `message.send_manual`;
 *   reject discards (logged, nothing sent).
 * - Wave 14-COPILOT (G18): `GET /v1/agent/copilot/context` (permission-scoped
 *   screen context, silent per-section denial), `POST /v1/agent/copilot/ask`
 *   (deterministic explain + draft proposals, never writes domain rows) and
 *   `POST /v1/agent/copilot/execute` (authorized pipeline only; HIGH risk
 *   creates a HumanReviewRequest instead of executing).
 */
@Controller("v1/agent")
export class AgentController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Inject(AgentPipeline) private readonly pipeline: AgentPipeline,
    @Inject(CopilotService) private readonly copilot: CopilotService,
  ) {
    void this.bus;
  }

  private requireDb(): Kysely<Database> {
    if (this.db === null) {
      throw new HttpException({ code: "UNAVAILABLE", message: "database is not configured" }, 503);
    }
    return this.db;
  }

  @Get("runs")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async listRuns(@Req() req: FastifyRequest, @Query("conversationId") conversationId?: string) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) {
      throw new HttpException({ code: "INVALID_CONVERSATION", message: "conversationId (uuid) is required" }, 400);
    }
    // P1.5-057 (P1.3 FIX1 mirror): tenant-scoped read inside the request
    // tenant's context — direct reads fail-closed under `iptv_app`.
    const rows = await withTenantTransaction(this.requireDb(), tenant.id, (trx) =>
      trx
        .selectFrom("agent.agent_runs")
      .select([
        "id",
        "conversation_id",
        "release_key",
        "release_version",
        "mode",
        "model",
        "status",
        "proposal_kind",
        "proposal_label",
        "proposal_text",
        "human_review_request_id",
        "created_at",
        "decided_at",
      ])
      .where("tenant_id", "=", tenant.id)
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .execute(),
    );
    return {
      runs: rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        releaseKey: r.release_key,
        releaseVersion: Number(r.release_version),
        mode: r.mode,
        model: r.model,
        status: r.status,
        proposalKind: r.proposal_kind,
        proposalLabel: r.proposal_label,
        proposalText: r.proposal_text,
        humanReviewRequestId: r.human_review_request_id,
        createdAt: r.created_at.toISOString(),
        decidedAt: r.decided_at?.toISOString() ?? null,
      })),
    };
  }

  @Post("evals/run")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.eval.run")
  async runEvals(): Promise<AgentEvalSummary> {
    return runAgentEvalSet();
  }

  @Get("copilot/context")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async copilotContext(
    @Req() req: FastifyRequest,
    @Query("route") route?: string,
    @Query("entityKind") entityKind?: string,
    @Query("entityId") entityId?: string,
    @Query("selection") selectionRaw?: string,
    @Query("filters") filtersRaw?: string,
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    const screen = parseCopilotScreen(route, entityKind, entityId, selectionRaw, filtersRaw);
    return this.copilot.buildContext(tenant.id, actorFromRequest(req), screen);
  }

  @Post("copilot/ask")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async copilotAsk(@Req() req: FastifyRequest, @Body() body: { question?: unknown; screen?: unknown }) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof body.question !== "string" || body.question.trim().length === 0 || body.question.length > 2000) {
      throw new HttpException({ code: "INVALID_QUESTION", message: "question (1..2000 chars) is required" }, 400);
    }
    const screen = parseCopilotScreenBody(body.screen);
    return this.copilot.ask(tenant.id, actorFromRequest(req), body.question, screen);
  }

  @Post("copilot/execute")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.request")
  async copilotExecute(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() body: { command?: unknown; input?: unknown; reviewId?: unknown; idempotencyKey?: unknown },
  ) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (typeof body.command !== "string" || body.command.length === 0 || body.command.length > 120) {
      throw new HttpException({ code: "INVALID_COMMAND", message: "command is required" }, 400);
    }
    if (typeof body.input !== "object" || body.input === null || Array.isArray(body.input)) {
      throw new HttpException({ code: "INVALID_INPUT", message: "input (object) is required" }, 400);
    }
    const reviewId = body.reviewId === undefined ? undefined : body.reviewId;
    if (reviewId !== undefined && typeof reviewId !== "string") {
      throw new HttpException({ code: "INVALID_REVIEW", message: "reviewId must be a string" }, 400);
    }
    // Idempotency: the `Idempotency-Key` header wins (bus convention, same
    // as every other command controller); the body field stays as a
    // documented fallback for non-HTTP callers.
    const idempotencyKey = idempotencyKeyOf(req) ?? body.idempotencyKey;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
      throw new HttpException({ code: "INVALID_INPUT", message: "idempotencyKey must be a string" }, 400);
    }
    const outcome = await this.copilot.execute(
      tenant.id,
      actorFromRequest(req),
      body.command,
      body.input as Record<string, unknown>,
      { reviewId, idempotencyKey, correlationId: req.id },
    );
    if (outcome.http >= 400) {
      throw new HttpException(
        { code: outcome.body.status.toUpperCase(), message: outcome.body.message },
        outcome.http as 400 | 403 | 404 | 409,
      );
    }
    // Nest defaults POST to 201: honor the pipeline outcome (200 executed,
    // 201 parked for approval) explicitly.
    res.status(outcome.http);
    return outcome.body;
  }

  @Post("reviews/:id/approve")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async approve(@Param("id") id: string, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (!UUID_RE.test(id)) {
      throw new HttpException({ code: "INVALID_REVIEW", message: "review id (uuid) is required" }, 400);
    }
    const result = await this.pipeline.resumeApproved({ tenantId: tenant.id, reviewId: id, actor: actorFromRequest(req) });
    if (!result.ok) {
      throw new HttpException(
        { code: result.code.toUpperCase(), message: result.message },
        commandResultHttpStatus(result),
      );
    }
    return result;
  }

  @Post("reviews/:id/reject")
  @UseGuards(AuthGuard, PermissionsGuard)
  @RequirePermission("agent.review.decide")
  async reject(@Param("id") id: string, @Body() body: { note?: unknown }, @Req() req: FastifyRequest) {
    const tenant = req.tenant as NonNullable<FastifyRequest["tenant"]>;
    if (!UUID_RE.test(id)) {
      throw new HttpException({ code: "INVALID_REVIEW", message: "review id (uuid) is required" }, 400);
    }
    const note = typeof body.note === "string" ? body.note : undefined;
    const result = await this.pipeline.resumeRejected({
      tenantId: tenant.id,
      reviewId: id,
      actor: actorFromRequest(req),
      note,
    });
    if (!result.ok) {
      throw new HttpException(
        { code: result.code.toUpperCase(), message: result.message },
        commandResultHttpStatus(result),
      );
    }
    return result;
  }
}

const COPILOT_ROUTE_RE = /^\/[A-Za-z0-9/_-]{0,199}$/;

function parseCopilotScreen(
  route: string | undefined,
  entityKind: string | undefined,
  entityId: string | undefined,
  selectionRaw: string | undefined,
  filtersRaw: string | undefined,
): CopilotScreen {
  if (typeof route !== "string" || !COPILOT_ROUTE_RE.test(route) || route.length === 0) {
    throw new HttpException({ code: "INVALID_SCREEN", message: "route (path) is required" }, 400);
  }
  return {
    route,
    entityKind: boundedToken(entityKind, 40),
    entityId: boundedToken(entityId, 60),
    selection: parseSelection(selectionRaw),
    filters: parseFilters(filtersRaw),
  };
}

function parseCopilotScreenBody(screen: unknown): CopilotScreen {
  if (typeof screen !== "object" || screen === null) {
    throw new HttpException({ code: "INVALID_SCREEN", message: "screen (object) is required" }, 400);
  }
  const s = screen as Record<string, unknown>;
  return parseCopilotScreen(
    typeof s["route"] === "string" ? s["route"] : undefined,
    typeof s["entityKind"] === "string" ? s["entityKind"] : undefined,
    typeof s["entityId"] === "string" ? s["entityId"] : undefined,
    typeof s["selection"] === "string" ? s["selection"] : s["selection"] === undefined ? undefined : JSON.stringify(s["selection"]),
    typeof s["filters"] === "string" ? s["filters"] : s["filters"] === undefined ? undefined : JSON.stringify(s["filters"]),
  );
}

function boundedToken(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length === 0 || value.length > max) {
    return undefined;
  }
  if (!/^[A-Za-z0-9/_-]+$/.test(value)) {
    return undefined;
  }
  return value;
}

function parseSelection(raw: string | undefined): CopilotScreen["selection"] {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpException({ code: "INVALID_SCREEN", message: "selection must be JSON" }, 400);
  }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new HttpException({ code: "INVALID_SCREEN", message: "selection must be an array (max 20)" }, 400);
  }
  const out: Array<{ kind: string; id: string }> = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      throw new HttpException({ code: "INVALID_SCREEN", message: "selection items must be objects" }, 400);
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec["kind"] !== "string" || typeof rec["id"] !== "string") {
      throw new HttpException({ code: "INVALID_SCREEN", message: "selection items need kind/id" }, 400);
    }
    out.push({ kind: rec["kind"].slice(0, 40), id: rec["id"].slice(0, 60) });
  }
  return out;
}

function parseFilters(raw: string | undefined): CopilotScreen["filters"] {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpException({ code: "INVALID_SCREEN", message: "filters must be JSON" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpException({ code: "INVALID_SCREEN", message: "filters must be an object" }, 400);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 20) {
    throw new HttpException({ code: "INVALID_SCREEN", message: "filters (max 20)" }, 400);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string") {
      throw new HttpException({ code: "INVALID_SCREEN", message: "filter values must be strings" }, 400);
    }
    out[k.slice(0, 60)] = v.slice(0, 200);
  }
  return out;
}

function idempotencyKeyOf(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}
