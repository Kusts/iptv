import { describe, expect, it } from "vitest";
import {
  buildAuditRow,
  writeAudit,
  type AuditRow,
} from "../src/audit.js";

const TENANT = "22222222-2222-4222-8222-222222222222";
const CORRELATION = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("buildAuditRow", () => {
  it("shapes a valid auth audit row", () => {
    const row = buildAuditRow({
      tenantId: TENANT,
      actorType: "human",
      actorId: "user-1",
      action: "auth.login",
      resourceType: "user",
      resourceId: "11111111-1111-4111-8111-111111111111",
      correlationId: CORRELATION,
      metadata: { after: { email: "op@example.com" } },
    });
    expect(row).toMatchObject({
      tenant_id: TENANT,
      actor_type: "human",
      action_key: "auth.login",
      correlation_id: CORRELATION,
    });
  });

  it("rejects invalid tenant, correlation and resource ids", () => {
    expect(() =>
      buildAuditRow({ tenantId: "nope", actorType: "human", action: "x", resourceType: "y" }),
    ).toThrow();
    expect(() =>
      buildAuditRow({
        tenantId: TENANT,
        actorType: "human",
        action: "x",
        resourceType: "y",
        correlationId: "nope",
      }),
    ).toThrow();
  });

  it("rejects unknown actor types and blank action/resource", () => {
    expect(() =>
      buildAuditRow({
        tenantId: TENANT,
        actorType: "llm" as never,
        action: "x",
        resourceType: "y",
      }),
    ).toThrow();
    expect(() =>
      buildAuditRow({ tenantId: TENANT, actorType: "human", action: " ", resourceType: "y" }),
    ).toThrow();
  });

  it("refuses secret-bearing metadata", () => {
    expect(() =>
      buildAuditRow({
        tenantId: TENANT,
        actorType: "human",
        action: "auth.login",
        resourceType: "user",
        metadata: { password_hash: "scrypt$..." },
      }),
    ).toThrow(/secrets/i);
  });
});

describe("writeAudit", () => {
  it("writes through the fake writer", async () => {
    const written: AuditRow[] = [];
    const row = await writeAudit(
      {
        write: async (r: AuditRow) => {
          written.push(r);
        },
      },
      {
        tenantId: TENANT,
        actorType: "human",
        actorId: "user-1",
        action: "tenant.switch",
        resourceType: "tenant",
        resourceId: TENANT,
        correlationId: CORRELATION,
        metadata: { after: { activeTenantId: TENANT } },
      },
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual(row);
  });
});
