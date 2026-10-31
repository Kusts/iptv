import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CINEVISION_MANUAL_GUIDANCE,
  CINEVISION_PROBE_COMMANDS,
  CINEVISION_WORKER_TIMEOUT_MS_DEFAULT,
  CINEVISION_WORKER_TIMEOUT_MS_MAX,
  CINEVISION_WORKER_TIMEOUT_MS_MIN,
  buildCinevisionWorkerEnv,
  cinevisionProfileRoot,
  mapWorkerOutcome,
  parseWorkerEnvelope,
  parseWorkerTimeoutMs,
  runWorkerCommand,
  workerProfileBase,
} from "../src/integrations/cinevision-worker-probe.js";

/**
 * S4A-CINE-VALIDATE (Issue #88): unidade do probe cinevision — tudo mockado
 * (spawn real só de `node -e`, zero rede/CINEVISION/segredo real).
 */
const INPUT = {
  tenantId: "tenant-a",
  providerAccountId: "acct-1",
  username: "s4a-synthetic-user",
  password: "s4a-synthetic-pass",
};

function envelope(status: string, errorCode: string): string {
  return JSON.stringify({
    correlationId: "test",
    providerAccountId: "acct-1",
    status,
    identityMatched: false,
    readbackMatched: false,
    needsHuman: false,
    errorCode,
  });
}

describe("cinevision probe unit (S4A)", () => {
  it("allowlist de comandos é fixa: só leituras certificadas", () => {
    expect([...CINEVISION_PROBE_COMMANDS]).toEqual(["read-identity", "list-servers"]);
  });

  it("timeout bounded com clamp fail-closed", () => {
    expect(parseWorkerTimeoutMs(undefined)).toBe(CINEVISION_WORKER_TIMEOUT_MS_DEFAULT);
    expect(parseWorkerTimeoutMs("")).toBe(CINEVISION_WORKER_TIMEOUT_MS_DEFAULT);
    expect(parseWorkerTimeoutMs("abc")).toBe(CINEVISION_WORKER_TIMEOUT_MS_DEFAULT);
    expect(parseWorkerTimeoutMs("1000")).toBe(CINEVISION_WORKER_TIMEOUT_MS_MIN);
    expect(parseWorkerTimeoutMs("999999999")).toBe(CINEVISION_WORKER_TIMEOUT_MS_MAX);
    expect(parseWorkerTimeoutMs("30000")).toBe(30_000);
  });

  it("profile root isolado por tenant, sem ids crus no caminho", () => {
    const base = workerProfileBase({} as NodeJS.ProcessEnv);
    expect(base.length).toBeGreaterThan(0);
    const rootA = cinevisionProfileRoot("/tmp/base", "tenant-a");
    const rootB = cinevisionProfileRoot("/tmp/base", "tenant-b");
    expect(rootA).not.toBe(rootB);
    expect(rootA).not.toContain("tenant-a");
    expect(rootB).not.toContain("tenant-b");
    expect(dirname(rootA)).toBe(resolve("/tmp/base"));
    expect(rootA).toMatch(/t-[0-9a-f]{32}$/);
    // Determinístico por tenant (mesmo tenant, mesma raiz).
    expect(cinevisionProfileRoot("/tmp/base", "tenant-a")).toBe(rootA);
    // Base relativa falha fechado.
    expect(() => cinevisionProfileRoot("relative/path", "tenant-a")).toThrowError();
  });

  it("child env carrega só o necessário (sem vazar segredos do pai)", () => {
    const parent = {
      INFISICAL_SITE_URL: "https://api-vault.example.test",
      INFISICAL_CLIENT_SECRET: "parent-api-secret-never-inherited",
      ASAAS_API_KEY: "parent-asaas-key-never-inherited",
      LOCALAPPDATA: "D:/tmp/bw-localappdata",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      CINEVISION_ALLOWED_ORIGIN: "https://panel.example.test",
      CINEVISION_LOGIN_PATH: "/api/auth/login",
      BROWSER_INFISICAL_SITE_URL: "https://worker-vault.example.test",
      BROWSER_INFISICAL_CLIENT_SECRET: "worker-identity-secret",
    } as NodeJS.ProcessEnv;
    const env = buildCinevisionWorkerEnv(INPUT, parent);
    // Credencial da invocação presente…
    expect(env["CINEVISION_EMAIL"]).toBe(INPUT.username);
    expect(env["CINEVISION_PASSWORD"]).toBe(INPUT.password);
    expect(env["BROWSER_WORKER_ENABLED"]).toBe("1");
    expect(env["BROWSER_WORKER_PROVIDER"]).toBe("CINEVISION");
    expect(env["BROWSER_WORKER_TENANT_ID"]).toBe(INPUT.tenantId);
    expect(env["BROWSER_WORKER_PROVIDER_ACCOUNT_ID"]).toBe(INPUT.providerAccountId);
    // …identidade do worker herdada (deployment) e config não-secreta…
    expect(env["BROWSER_INFISICAL_SITE_URL"]).toBe("https://worker-vault.example.test");
    expect(env["LOCALAPPDATA"]).toBe("D:/tmp/bw-localappdata");
    expect(env["CINEVISION_ALLOWED_ORIGIN"]).toBe("https://panel.example.test");
    // …mas segredos do pai (API/vault/asaas) NUNCA entram.
    const dumped = JSON.stringify(env);
    expect(dumped).not.toContain("parent-api-secret-never-inherited");
    expect(dumped).not.toContain("https://api-vault.example.test");
    expect(dumped).not.toContain("parent-asaas-key-never-inherited");
    // Profile root por tenant, sem id cru.
    expect(env["BROWSER_WORKER_PROFILE_ROOT"]).toBe(
      cinevisionProfileRoot(workerProfileBase(parent), INPUT.tenantId),
    );
    expect(env["BROWSER_WORKER_PROFILE_ROOT"]).not.toContain(INPUT.tenantId);
  });

  it("concorrência: tenants distintos nunca partilham perfil/sessão", () => {
    const parent = {} as NodeJS.ProcessEnv;
    const envA = buildCinevisionWorkerEnv({ ...INPUT, tenantId: "tenant-a" }, parent);
    const envB = buildCinevisionWorkerEnv({ ...INPUT, tenantId: "tenant-b" }, parent);
    expect(envA["BROWSER_WORKER_PROFILE_ROOT"]).not.toBe(envB["BROWSER_WORKER_PROFILE_ROOT"]);
  });

  it("env inválido falha fechado (sem spawn)", () => {
    expect(() =>
      buildCinevisionWorkerEnv({ ...INPUT, tenantId: "../evil" }, {} as NodeJS.ProcessEnv),
    ).toThrowError();
    expect(() =>
      buildCinevisionWorkerEnv({ ...INPUT, username: "  " }, {} as NodeJS.ProcessEnv),
    ).toThrowError();
  });

  it("parse: stdout no exit 0, stderr na falha, lixo vira null", () => {
    expect(parseWorkerEnvelope(envelope("READ_CONFIRMED", "NONE"), "", 0)).toEqual({
      status: "READ_CONFIRMED",
      errorCode: "NONE",
    });
    expect(parseWorkerEnvelope("", envelope("HUMAN_REQUIRED", "CHALLENGE_DETECTED"), 2)).toEqual({
      status: "HUMAN_REQUIRED",
      errorCode: "CHALLENGE_DETECTED",
    });
    // Última linha não-vazia vence (logs + envelope).
    expect(
      parseWorkerEnvelope(`noise line\n${envelope("READ_CONFIRMED", "NONE")}\n`, "", 0),
    ).toEqual({ status: "READ_CONFIRMED", errorCode: "NONE" });
    expect(parseWorkerEnvelope("not json at all", "also not json", 2)).toBeNull();
    expect(parseWorkerEnvelope(JSON.stringify({ status: 42 }), "", 0)).toBeNull();
  });

  it("map: READ_CONFIRMED ok; falhas com códigos distintos", () => {
    expect(mapWorkerOutcome({ status: "READ_CONFIRMED", errorCode: "NONE" }, false)).toEqual({
      ok: true,
    });
    expect(
      mapWorkerOutcome({ status: "HUMAN_REQUIRED", errorCode: "IDENTITY_MISMATCH" }, false),
    ).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(
      mapWorkerOutcome({ status: "HUMAN_REQUIRED", errorCode: "SESSION_EXPIRED" }, false),
    ).toEqual({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(
      mapWorkerOutcome({ status: "HUMAN_REQUIRED", errorCode: "CHALLENGE_DETECTED" }, false),
    ).toEqual({ ok: false, code: "CHALLENGE_DETECTED" });
    expect(
      mapWorkerOutcome({ status: "HUMAN_REQUIRED", errorCode: "PERMISSION_DENIED" }, false),
    ).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
    // Budget do worker estourado conta como timeout.
    expect(mapWorkerOutcome({ status: "INCONCLUSIVE", errorCode: "TRANSPORT" }, false)).toEqual({
      ok: false,
      code: "TIMEOUT",
    });
    expect(mapWorkerOutcome({ status: "INCONCLUSIVE", errorCode: "RATE_LIMITED" }, false)).toEqual({
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
    });
    // Timeout do spawn vence qualquer envelope + envelope nulo.
    expect(mapWorkerOutcome({ status: "READ_CONFIRMED", errorCode: "NONE" }, true)).toEqual({
      ok: false,
      code: "TIMEOUT",
    });
    expect(mapWorkerOutcome(null, false)).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });

  it("guidance manual cobre todos os códigos (instrução HUMAN_REQUIRED)", () => {
    for (const code of [
      "INVALID_CREDENTIALS",
      "CHALLENGE_DETECTED",
      "TIMEOUT",
      "PROVIDER_UNAVAILABLE",
    ] as const) {
      const text = CINEVISION_MANUAL_GUIDANCE[code];
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(20);
    }
    // Challenge exige conclusão manual — nunca sugere desativar/ignorar o controle.
    expect(CINEVISION_MANUAL_GUIDANCE.CHALLENGE_DETECTED).toMatch(/manual/i);
    expect(CINEVISION_MANUAL_GUIDANCE.CHALLENGE_DETECTED).not.toMatch(
      /desativ|desabilit|ignor|burl/,
    );
  });

  it("spawn: sucesso parseia o envelope (node -e, sem browser)", async () => {
    const out = envelope("READ_CONFIRMED", "NONE");
    const script = `process.stdout.write(${JSON.stringify(out)} + "\\n");`;
    const result = await runWorkerCommand({
      argv: ["-e", script],
      env: {} as NodeJS.ProcessEnv,
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(mapWorkerOutcome(parseWorkerEnvelope(result.stdout, result.stderr, 0), false)).toEqual(
      { ok: true },
    );
  });

  it("spawn: timeout mata (SIGKILL) e não deixa órfão", async () => {
    const before = Date.now();
    const result = await runWorkerCommand({
      argv: ["-e", "setInterval(() => {}, 1000);"],
      env: {} as NodeJS.ProcessEnv,
      timeoutMs: 500,
    });
    const elapsed = Date.now() - before;
    expect(result.timedOut).toBe(true);
    // Kill rápido: resolveu bem antes do sleep de 30s+s.
    expect(elapsed).toBeLessThan(15_000);
    expect(mapWorkerOutcome(parseWorkerEnvelope(result.stdout, result.stderr, null), true)).toEqual(
      { ok: false, code: "TIMEOUT" },
    );
  });

  it("spawn: falha com envelope em stderr mapeia challenge", async () => {
    const err = envelope("HUMAN_REQUIRED", "CHALLENGE_DETECTED");
    const script = `process.stderr.write(${JSON.stringify(err)} + "\\n"); process.exit(2);`;
    const result = await runWorkerCommand({
      argv: ["-e", script],
      env: {} as NodeJS.ProcessEnv,
      timeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(
      mapWorkerOutcome(parseWorkerEnvelope(result.stdout, result.stderr, 2), false),
    ).toEqual({ ok: false, code: "CHALLENGE_DETECTED" });
  });

  it("módulo nunca loga valores (sem logger; inspeção)", () => {
    const seen: string[] = [];
    for (const method of ["debug", "info", "log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
      });
    }
    try {
      buildCinevisionWorkerEnv(INPUT, {} as NodeJS.ProcessEnv);
      parseWorkerEnvelope(envelope("READ_CONFIRMED", "NONE"), "", 0);
      mapWorkerOutcome({ status: "READ_CONFIRMED", errorCode: "NONE" }, false);
      expect(seen).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
