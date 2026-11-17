import { createHash } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import type { AppConfig } from "@iptv/config";
import { resolveBotCredential } from "./bot-credential-resolver.js";

export type BotServiceRequest = {
  credentialId: string;
  tenantId: string;
  scopes: string[];
  tokenPrefix: string;
};

declare module "fastify" {
  interface FastifyRequest {
    botService?: BotServiceRequest;
  }
}

@Injectable()
export class BotServiceGuard implements CanActivate {
  constructor(
    @Inject("DB") private readonly db: Kysely<Database> | null,
    @Inject("APP_CONFIG") private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.STREAMMAX_BOT_API_ENABLED !== "true") {
      throw new HttpException({ code: "NOT_FOUND", message: "not found" }, 404);
    }
    if (this.db === null || this.config.BOT_SERVICE_TOKEN_PEPPER === undefined) {
      throw new HttpException({ code: "UNAVAILABLE", message: "service unavailable" }, 503);
    }
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
    if (!match) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "invalid service credential" }, 401);
    }
    const token = match[1] as string;
    const hash = createHash("sha256").update(`${this.config.BOT_SERVICE_TOKEN_PEPPER}:${token}`).digest("hex");
    const credential = await resolveBotCredential(this.db, hash);
    if (credential === null) {
      throw new HttpException({ code: "UNAUTHENTICATED", message: "invalid service credential" }, 401);
    }
    if (!credential.scopes.includes("bot.streammax.execute")) {
      throw new HttpException({ code: "FORBIDDEN", message: "forbidden" }, 403);
    }
    req.botService = { ...credential, tokenPrefix: token.slice(0, 8) };
    return true;
  }
}
