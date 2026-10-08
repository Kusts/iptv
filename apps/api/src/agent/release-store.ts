import { Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import {
  InMemoryAgentReleaseStore,
  defaultCustomerAgentRelease,
  type AgentRelease,
  type AgentReleaseStore,
} from "@iptv/ai-runtime";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Kysely-backed `AgentReleaseStore`: prompts keyed by release key/version
 * from `agent.agent_releases` (PUBLISHED only). Without a database (unit
 * context) it delegates to the in-memory default release so the harness
 * stays testable.
 */
@Injectable()
export class KyselyAgentReleaseStore implements AgentReleaseStore {
  private readonly fallback = new InMemoryAgentReleaseStore([defaultCustomerAgentRelease()]);

  constructor(@Inject("DB") private readonly db: Kysely<Database> | null) {}

  async getPublished(key: string): Promise<AgentRelease | null> {
    if (this.db === null) {
      return this.fallback.getPublished(key);
    }
    // P1.5-058: GLOBAL catalog read (`agent.agent_releases` — no tenant_id,
    // no RLS by design) intentionally WITHOUT `withTenantTransaction`: the
    // release lookup runs pre-context (pipeline harness path), so an RLS
    // policy could only fail-closed every evaluation.
    const row = await this.db
      .selectFrom("agent.agent_releases")
      .select(["key", "version", "profile", "system_prompt", "developer_prompt", "model", "allowed_tools", "status"])
      .where("key", "=", key)
      .where("status", "=", "PUBLISHED")
      .orderBy("version", "desc")
      .executeTakeFirst();
    if (row === undefined) {
      return null;
    }
    const profile = row.profile === "tenant_copilot" ? "tenant_copilot" : "customer_agent";
    return {
      key: row.key,
      version: Number(row.version),
      profile,
      systemPrompt: row.system_prompt,
      developerPrompt: row.developer_prompt,
      model: row.model,
      allowedTools: asStringArray(row.allowed_tools),
      status: "PUBLISHED",
    };
  }
}
