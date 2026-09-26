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
  UseGuards,
} from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { commandResultHttpStatus } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/auth.guard.js";
import { RequirePermission, PermissionsGuard } from "../auth/permissions.guard.js";
import { CommandBus, commandActorFromRequestParts } from "../commands/command-bus.js";
import { AgentPipeline } from "./pipeline.js";
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
 */
@Controller("v1/agent")
export class AgentController {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject(CommandBus) private readonly bus: CommandBus,
    @Inject(AgentPipeline) private readonly pipeline: AgentPipeline,
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
    const rows = await this.requireDb()
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
      .execute();
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
