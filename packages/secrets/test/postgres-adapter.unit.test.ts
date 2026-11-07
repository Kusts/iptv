import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  NoopSecretsPort,
  PostgresSecretsAdapter,
  SecretsError,
  asSecretsWriter,
  buildIntegrationSecretRef,
  encryptSecret,
  rotateSecret,
  secretAad,
  type SecretRowStore,
} from "../src/index.js";

const KEY = randomBytes(32);
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

class MemoryStore implements SecretRowStore {
  readonly rows = new Map<string, string>();
  calls: string[] = [];

  private key(tenantId: string, ref: string): string {
    return `${tenantId}\u0000${ref}`;
  }

  async get(tenantId: string, ref: string): Promise<{ ciphertext: string } | undefined> {
    this.calls.push(`get:${ref}`);
    const ciphertext = this.rows.get(this.key(tenantId, ref));
    return ciphertext === undefined ? undefined : { ciphertext };
  }

  async upsert(row: { tenantId: string; ref: string; ciphertext: string }): Promise<boolean> {
    this.calls.push(`put:${row.ref}`);
    const key = this.key(row.tenantId, row.ref);
    const created = !this.rows.has(key);
    this.rows.set(key, row.ciphertext);
    return created;
  }

  async remove(tenantId: string, ref: string): Promise<boolean> {
    this.calls.push(`del:${ref}`);
    return this.rows.delete(this.key(tenantId, ref));
  }
}

function adapter(tenantId: string, store: MemoryStore): PostgresSecretsAdapter {
  return new PostgresSecretsAdapter({ store, tenantId, key: KEY });
}

function refFor(tenantId: string, key = "ASAAS_API_KEY"): string {
  return buildIntegrationSecretRef({
    tenantId,
    provider: "asaas",
    environment: "SANDBOX",
    key,
  });
}

function codeOf(err: unknown): string | null {
  return err instanceof SecretsError ? err.code : null;
}

describe("PostgresSecretsAdapter", () => {
  it("stores ciphertext only and round-trips the value", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const target = {
      tenantId: TENANT_A,
      provider: "asaas" as const,
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "api-key-value",
    };
    const put = await port.putSecret(target);
    expect(put.ref.startsWith("pgsecret://")).toBe(true);
    expect(store.rows.size).toBe(1);
    expect([...store.rows.values()].join("")).not.toContain("api-key-value");
    await expect(port.getSecret(put.ref)).resolves.toBe("api-key-value");
    const again = await port.putSecret({ ...target, value: "rotated-value" });
    expect(again.ref).toBe(put.ref);
    expect(again.created).toBe(false);
    await expect(port.getSecret(put.ref)).resolves.toBe("rotated-value");
  });

  it("resolves legacy infisical:// refs by exact value (migration compatibility)", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const legacyRef = `infisical://SANDBOX/integrations/${TENANT_A}/asaas/ASAAS_API_KEY`;
    store.rows.set(
      `${TENANT_A}\u0000${legacyRef}`,
      encryptSecret("legacy-value", KEY, secretAad(TENANT_A, legacyRef)),
    );
    await expect(port.getSecret(legacyRef)).resolves.toBe("legacy-value");
    expect(refFor(TENANT_A).startsWith("pgsecret://")).toBe(true);
  });

  it("isolates tenants: a foreign ref is NOT_FOUND and the store is never read", async () => {
    const store = new MemoryStore();
    const portB = adapter(TENANT_B, store);
    const foreignRef = refFor(TENANT_A);
    await expect(portB.getSecret(foreignRef)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.calls).toEqual([]);
  });

  it("does not expose whether another tenant's secret exists", async () => {
    const store = new MemoryStore();
    await adapter(TENANT_A, store).putSecret({
      tenantId: TENANT_A,
      provider: "asaas",
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "a-value",
    });
    const err = await adapter(TENANT_B, store)
      .getSecret(refFor(TENANT_A))
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe("NOT_FOUND");
    expect(String(err)).not.toContain("a-value");
  });

  it("fails closed on tampered ciphertext", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const put = await port.putSecret({
      tenantId: TENANT_A,
      provider: "asaas",
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "value",
    });
    const rowKey = `${TENANT_A}\u0000${put.ref}`;
    const stored = store.rows.get(rowKey) as string;
    const parts = stored.split(".");
    const data = parts[3] as string;
    const flipped = data.startsWith("A") ? `B${data.slice(1)}` : `A${data.slice(1)}`;
    store.rows.set(rowKey, `${parts[0]}.${parts[1]}.${parts[2]}.${flipped}`);
    await expect(port.getSecret(put.ref)).rejects.toMatchObject({ code: "SERVER" });
  });

  it("rejects refs outside the namespace before touching storage", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    for (const ref of [
      `pgsecret://SANDBOX/${TENANT_A}/asaas/ASAAS_API_KEY`,
      "pgsecret://SANDBOX/integrations/t/unknown/KEY",
      "pgsecret://SANDBOX/integrations/t/asaas/FREE_FORM",
      "http://example.test/x",
    ]) {
      await expect(port.getSecret(ref)).rejects.toMatchObject({ code: "MALFORMED_REF" });
    }
    expect(store.calls).toEqual([]);
  });

  it("delete is idempotent-aware (second delete is NOT_FOUND)", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const put = await port.putSecret({
      tenantId: TENANT_A,
      provider: "asaas",
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "value",
    });
    await port.deleteSecret(put.ref);
    await expect(port.deleteSecret(put.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rotateSecret stages, probes, cuts over and cleans the stage", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const target = {
      tenantId: TENANT_A,
      provider: "asaas" as const,
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "candidate",
    };
    const liveRef = buildIntegrationSecretRef(target);
    await port.putSecret({ ...target, value: "live" });
    const probed: string[] = [];
    const result = await rotateSecret(port, {
      ...target,
      probe: async (stagedRef) => {
        probed.push(stagedRef);
        await expect(port.getSecret(stagedRef)).resolves.toBe("candidate");
      },
    });
    expect(result.ref).toBe(liveRef);
    expect(result.stagedRef).toBe(`${liveRef}__next`);
    expect(probed).toEqual([result.stagedRef]);
    await expect(port.getSecret(liveRef)).resolves.toBe("candidate");
    await expect(port.getSecret(result.stagedRef)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rotateSecret keeps the live ref when the probe rejects", async () => {
    const store = new MemoryStore();
    const port = adapter(TENANT_A, store);
    const target = {
      tenantId: TENANT_A,
      provider: "asaas" as const,
      environment: "SANDBOX",
      key: "ASAAS_API_KEY",
      value: "candidate",
    };
    const liveRef = buildIntegrationSecretRef(target);
    await port.putSecret({ ...target, value: "live" });
    await expect(
      rotateSecret(port, {
        ...target,
        probe: async () => {
          throw new Error("probe rejected");
        },
      }),
    ).rejects.toMatchObject({ code: "ROTATE_FAILED" });
    await expect(port.getSecret(liveRef)).resolves.toBe("live");
    await expect(port.getSecret(`${liveRef}__next`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("NoopSecretsPort / asSecretsWriter", () => {
  it("fails closed and still narrows to the writer facet", async () => {
    const port = new NoopSecretsPort();
    expect(port.name).toBe("noop");
    expect(asSecretsWriter(port)).not.toBeNull();
    await expect(port.getSecret("pgsecret://SANDBOX/x/Y")).rejects.toMatchObject({ code: "CONFIG" });
  });
});
