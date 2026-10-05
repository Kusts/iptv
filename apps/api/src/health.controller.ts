import { Controller, Get, HttpException, Inject, Optional, Req, Res } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import type { Database } from "@iptv/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SchedulerService } from "./scheduler/scheduler.service.js";

export const API_VERSION = "0.1.0";

/**
 * Budget for the readiness `SELECT 1`. Long enough for a cold pool on a
 * loaded host, short enough that a wedged database turns into a failing
 * probe (and an orchestrator stop) instead of a hanging request.
 */
export const READINESS_PROBE_TIMEOUT_MS = 2000;

/** Body of `GET /v1/health/ready`. Fixed vocabulary, no driver detail. */
export interface ReadinessBody {
  status: "ok" | "unavailable";
  checks: { database: "ok" | "error" };
}

@Controller("v1")
export class HealthController {
  constructor(
    @Optional() @Inject(SchedulerService) private readonly scheduler?: SchedulerService | null,
    @Optional() @Inject("DB") private readonly db?: Kysely<Database> | null,
  ) {}

  @Get("health")
  health(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): {
    status: string;
    version: string;
    requestId: string;
    scheduler: string;
    tickSeconds: number;
  } {
    // Single request id from the HTTP boundary (Fastify `request.id`,
    // also mirrored to logs and the `x-request-id` response header).
    const requestId = req.id;
    res.header("x-request-id", requestId);
    const enabled = this.scheduler?.isEnabled() ?? false;
    return {
      status: "ok",
      version: API_VERSION,
      requestId,
      scheduler: enabled ? "enabled" : "disabled",
      tickSeconds: this.scheduler?.tickSeconds() ?? 60,
    };
  }

  /**
   * Readiness — public and unauthenticated, exactly like `/v1/health`, so an
   * orchestrator can gate traffic on it without holding a credential.
   *
   * Liveness (`/v1/health`) stays dependency-free on purpose: a database
   * blip must NOT make the container look dead and get it restarted. This
   * endpoint answers `503` while the database is unreachable, which keeps the
   * container running but out of the load balancer until it recovers.
   */
  @Get("health/ready")
  async ready(): Promise<ReadinessBody> {
    if (!(await this.databaseReachable())) {
      // Fixed reason only — a driver message can carry host/user/database
      // details that have no business in a public response body.
      throw new HttpException({ status: "unavailable", checks: { database: "error" } }, 503);
    }
    return { status: "ok", checks: { database: "ok" } };
  }

  /** `SELECT 1` against the API pool, bounded by `READINESS_PROBE_TIMEOUT_MS`. */
  private async databaseReachable(): Promise<boolean> {
    const db = this.db;
    if (db === undefined || db === null) {
      // No connection string configured (or none resolvable): the API cannot
      // serve traffic, so it is not ready.
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness probe timeout")),
          READINESS_PROBE_TIMEOUT_MS,
        );
      });
      await Promise.race([db.executeQuery(sql`select 1`.compile(db)), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      // Always cleared: a pending timer would keep the event loop alive.
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}