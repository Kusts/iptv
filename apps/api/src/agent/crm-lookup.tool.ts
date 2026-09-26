import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import type { ToolDescriptor, ToolDispatcher, ToolExecResult } from "@iptv/ai-runtime";

export const lookupPersonInput = z.object({ personId: z.string().uuid() });

/**
 * `crm.lookup_person` — the single Wave 3 specialist-as-tool example.
 * Read-only (R0): resolves the SAME tenant-scoped person/identity rows the
 * CRM API reads. Execution flows through the injected dispatcher so host
 * permission checks apply (tool existence never implies authorization);
 * the descriptor itself touches no database or provider.
 */
export function createCrmLookupTool(): ToolDescriptor {
  return {
    name: "crm.lookup_person",
    tenantScope: "tenant",
    riskClass: "R0",
    inputSchema: lookupPersonInput,
    execute: async (ctx, input, dispatch: ToolDispatcher) => dispatch(ctx, "crm.lookup_person", input),
  };
}

/**
 * Host dispatcher for agent tools: permission-gated, tenant-scoped reads
 * over the same tables the CRM/Communications API uses. No raw provider
 * calls, no cross-tenant access (queries always filter by `ctx.tenantId`).
 */
export function createToolDispatcher(db: Kysely<Database> | null): ToolDispatcher {
  return async (ctx, command, input): Promise<ToolExecResult> => {
    if (command !== "crm.lookup_person") {
      return { ok: false, code: "NOT_FOUND", message: `unknown tool command: ${command}`, failureKind: "FATAL" };
    }
    const parsed = lookupPersonInput.safeParse(input);
    if (!parsed.success) {
      return { ok: false, code: "VALIDATION_FAILED", message: "invalid tool input", failureKind: "FATAL" };
    }
    if (db === null) {
      return { ok: false, code: "DEPENDENCY_UNAVAILABLE", message: "database is not configured", failureKind: "TRANSIENT" };
    }
    try {
      const person = await db
        .selectFrom("identity.persons")
        .select(["id", "canonical_name", "locale", "status"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("id", "=", parsed.data.personId)
        .executeTakeFirst();
      if (person === undefined) {
        // Tenant-scoped miss: invisible foreign rows look the same as absent.
        return { ok: false, code: "NOT_FOUND", message: "person not found in this tenant", failureKind: "FATAL" };
      }
      const identities = await db
        .selectFrom("identity.identities")
        .select(["identity_type", "normalized_value"])
        .where("tenant_id", "=", ctx.tenantId)
        .where("person_id", "=", person.id)
        .where("detached_at", "is", null)
        .execute();
      return {
        ok: true,
        output: {
          person_id: person.id,
          canonical_name: person.canonical_name,
          locale: person.locale,
          status: person.status,
          identity_count: identities.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "DEPENDENCY_UNAVAILABLE", message, failureKind: "TRANSIENT" };
    }
  };
}
