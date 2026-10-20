/**
 * BOUNDED EXPERIMENT #27 (DISCOVERY-RESEARCH) — read-model cacheado/projetado.
 *
 * Scope: fixture offline local-only. Nenhum swap de provider/model (só
 * `EchoModelGateway`, zero chamada externa), nenhum toque em
 * `apps/api/src/agent/context-builder.ts`, policies ou budgets. Todos os
 * helpers vivem neste arquivo; código de produção intacto.
 *
 * Fixture: 1 contexto read-only estilo `list-customers` (janela cheia de 20
 * mensagens recentes, cf. `AGENT_MESSAGE_WINDOW = 20` do ContextBuilder) vs.
 * projeção cacheada (mesmos fatos de policy/supressão + última mensagem +
 * contagem). Chave de cache inclui tenant + policy (controlMode, autonomia,
 * notes, supressão, qtd reviews) para nunca servir stale através de mudança
 * de policy; read-only puro, sem pós-condição de escrita).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentHarness } from "../src/harness.js";
import { EchoModelGateway, renderUserBlock } from "../src/model-gateway.js";
import { InMemoryAgentReleaseStore } from "../src/release-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { estimateCostMicros, estimateTokensForChars } from "../src/budgets.js";
import type { AgentRunRequest, ContextBundle } from "../src/types.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";

/** Janela cheia como a que o ContextBuilder entrega (bounded-20). */
function fullReadContext(): ContextBundle {
  const recentMessages = Array.from({ length: 20 }, (_, i) => ({
    direction: (i % 2 === 0 ? "INBOUND" : "OUTBOUND") as "INBOUND" | "OUTBOUND",
    senderType: i % 2 === 0 ? "customer" : "agent",
    bodyText: `mensagem de histórico ${i + 1} sobre a conta e o atendimento regular`,
    occurredAt: new Date(Date.UTC(2026, 9, 20, 10, i, 0)).toISOString(),
  }));
  return {
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    channel: "WHATSAPP",
    controlMode: "AI_CONTROL",
    personSummary: { personId: PERSON_ID, canonicalName: "Lead", locale: "pt-BR" },
    recentMessages,
    policySummary: { allowAutonomous: false, notes: [] },
    suppressionsActive: false,
    openReviewCount: 0,
  };
}

/**
 * Projeção read-only experiment-local: preserva TODOS os fatos de
 * policy/supressão/tenant (nunca bypass), troca o histórico verboso por
 * última mensagem + contagem. Chave de cache inclui controlMode/autonomia/
 * notes/supressão/reviews para nunca servir stale através de mudança de policy.
 */
function projectReadModel(full: ContextBundle): ContextBundle {
  const last = full.recentMessages[full.recentMessages.length - 1];
  return {
    ...full,
    recentMessages:
      last === undefined
        ? []
        : [
            {
              direction: last.direction,
              senderType: last.senderType,
              bodyText: `${last.bodyText} (histórico projetado: ${full.recentMessages.length} mensagens)`,
              occurredAt: last.occurredAt,
            },
          ],
  };
}

function policyKey(ctx: ContextBundle): string {
  return [
    `mode:${ctx.controlMode}`,
    ctx.policySummary.allowAutonomous ? "auto" : "manual",
    `notes:${JSON.stringify(ctx.policySummary.notes)}`,
    ctx.suppressionsActive ? "supp" : "nosupp",
    `rev${ctx.openReviewCount}`,
  ].join("|");
}

interface CacheEntry {
  tenantId: string;
  policyKey: string;
  projected: ContextBundle;
}

/** Cache experiment-local: chave = tenant:conversation:inbound + tenant + policy validados no hit. */
class ExperimentReadCache {
  private readonly store = new Map<string, CacheEntry>();

  private key(tenantId: string, conversationId: string, inboundText: string): string {
    return `${tenantId}:${conversationId}:${inboundText}`;
  }

  get(full: ContextBundle, inboundText: string): ContextBundle | null {
    const entry = this.store.get(this.key(full.tenantId, full.conversationId, inboundText));
    if (entry === undefined) {
      return null;
    }
    // Fail-closed: tenant divergente nunca acerta (sem leak entre tenants).
    if (entry.tenantId !== full.tenantId) {
      return null;
    }
    // Sem stale: policy/supressão mudaram → miss, reconstrói.
    if (entry.policyKey !== policyKey(full)) {
      return null;
    }
    return entry.projected;
  }

  put(full: ContextBundle, inboundText: string, projected: ContextBundle): void {
    this.store.set(this.key(full.tenantId, full.conversationId, inboundText), {
      tenantId: full.tenantId,
      policyKey: policyKey(full),
      projected,
    });
  }
}

function experimentHarness(): AgentHarness {
  const tools = new ToolRegistry();
  // R0 read-only, igual ao harness de produção (dispatcher puro, sem DB/provider).
  tools.register({
    name: "crm.lookup_person",
    tenantScope: "tenant",
    riskClass: "R0",
    inputSchema: z.object({ personId: z.string().uuid() }),
    execute: async () => ({ ok: true, output: { canonicalName: "Lead" } }),
  });
  return new AgentHarness({
    gateway: new EchoModelGateway(),
    releases: new InMemoryAgentReleaseStore(),
    tools,
  });
}

function runRequest(context: ContextBundle, inboundText: string): AgentRunRequest {
  return {
    tenantId: context.tenantId,
    conversationId: context.conversationId,
    releaseId: "customer-agent-v1",
    mode: "SHADOW",
    allowedTools: ["crm.lookup_person"],
    context,
    inboundText,
  };
}

const INBOUND = "quero ver meus dados e a lista de clientes, página 1";

describe("EXP#27 read-model cacheado/projetado (bounded, offline)", () => {
  it("mantém a mesma decisão tool-correta com menos tokens/run no caminho cacheado", async () => {
    const harness = experimentHarness();
    const cache = new ExperimentReadCache();
    const full = fullReadContext();

    const echoStartedAt = performance.now();
    const echo = await harness.run(runRequest(full, INBOUND));
    const echoLatencyMs = performance.now() - echoStartedAt;

    const firstLookup = cache.get(full, INBOUND);
    const cacheHit = firstLookup !== null;
    const projected = firstLookup ?? projectReadModel(full);
    if (!cacheHit) {
      cache.put(full, INBOUND, projected);
    }
    const cacheStartedAt = performance.now();
    const cached = await harness.run(runRequest(projected, INBOUND));
    const cacheLatencyMs = performance.now() - cacheStartedAt;

    // Segunda leitura acerta o cache (read-only puro: mesma chave, mesma policy)
    // e o harness executado SOBRE o hit real preserva a paridade de decisão.
    const secondHit = cache.get(full, INBOUND);
    expect(secondHit).not.toBeNull();
    if (secondHit === null) {
      throw new Error("expected cache hit on second read");
    }
    // Paridade afirmada de forma independente sobre o hit real (não reutiliza
    // `cached`): claim restrito ao cenário coberto aqui (`happy_reply`).
    const hitRun = await harness.run(runRequest(secondHit, INBOUND));
    expect(hitRun.proposals[0]?.label).toBe(echo.proposals[0]?.label);
    expect(hitRun.proposals[0]?.label).toBe("happy_reply");
    expect(hitRun.proposals[0]?.kind).toBe(echo.proposals[0]?.kind);
    expect(hitRun.toolCalls).toHaveLength(echo.toolCalls.length);
    expect(hitRun.toolCalls[0]).toMatchObject({ name: "crm.lookup_person", status: "SUCCEEDED" });

    // Mesma taxa tool-correta: mesma proposta + mesma chamada R0.
    expect(cached.proposals[0]?.label).toBe(echo.proposals[0]?.label);
    expect(cached.proposals[0]?.kind).toBe(echo.proposals[0]?.kind);
    expect(cached.toolCalls).toHaveLength(echo.toolCalls.length);
    expect(cached.toolCalls[0]).toMatchObject({ name: "crm.lookup_person", status: "SUCCEEDED" });

    // Custo/run medido menor no caminho projetado, pela heurística canônica
    // de tokens (chars/4, a mesma que os budgets usam no pre-call cap).
    // NOTA honesta: `completion.usage` do EchoModelGateway NÃO serve como
    // medida aqui — `usageOf` concatena os comprimentos como string
    // (`lengths.join("")`), então devolve ~3 para qualquer contexto deste
    // tamanho (artefato fora do escopo: gateway prod intocado).
    const echoBlock = renderUserBlock(full, INBOUND, "SHADOW");
    const cacheBlock = renderUserBlock(projected, INBOUND, "SHADOW");
    const echoTokens = estimateTokensForChars(echoBlock.length);
    const cacheTokens = estimateTokensForChars(cacheBlock.length);
    expect(cacheTokens).toBeLessThan(echoTokens);
    const echoCost = estimateCostMicros(echoTokens, echo.usage.outputTokens, {
      inputMicrosPerToken: 0.15,
      outputMicrosPerToken: 0.6,
    });
    const cacheCost = estimateCostMicros(cacheTokens, cached.usage.outputTokens, {
      inputMicrosPerToken: 0.15,
      outputMicrosPerToken: 0.6,
    });
    expect(cacheCost).toBeLessThan(echoCost);

    // Latência apenas observada (harness local é ruído de ms); ambas limitadas.
    expect(echoLatencyMs).toBeLessThan(5000);
    expect(cacheLatencyMs).toBeLessThan(5000);
    expect(cacheHit).toBe(false); // primeira projeção: miss → put (honesto)
    console.log(
      `[EXP#27] echoTokens=${echoTokens} cacheTokens=${cacheTokens} ` +
        `saved=${echoTokens - cacheTokens} echoMs=${echoLatencyMs.toFixed(2)} ` +
        `cacheMs=${cacheLatencyMs.toFixed(2)} echoCost=${echoCost.toFixed(2)} ` +
        `cacheCost=${cacheCost.toFixed(2)} label=${cached.proposals[0]?.label ?? "none"}`,
    );
  });

  it("fail-closed entre tenants: tenant distinto nunca acerta o cache (sem bypass)", async () => {
    const cache = new ExperimentReadCache();
    const full = fullReadContext();
    cache.put(full, INBOUND, projectReadModel(full));

    const foreign = { ...full, tenantId: OTHER_TENANT_ID };
    expect(cache.get(foreign, INBOUND)).toBeNull();

    // E o harness também falha fechado no mismatch tenant/request.
    const harness = experimentHarness();
    const mismatch = await harness.run({
      ...runRequest(full, INBOUND),
      tenantId: OTHER_TENANT_ID,
    });
    expect(mismatch.finishReason).toBe("escalated");
    expect(mismatch.proposals[0]?.label).toBe("tenant_scope_mismatch");
  });

  it("sem stale: mudança de policy/supressão invalida o cache (read-only puro)", () => {
    const cache = new ExperimentReadCache();
    const full = fullReadContext();
    cache.put(full, INBOUND, projectReadModel(full));

    const suppressed = { ...full, suppressionsActive: true };
    expect(cache.get(suppressed, INBOUND)).toBeNull();

    const autonomous = {
      ...full,
      policySummary: { allowAutonomous: true, notes: [] as string[] },
    };
    expect(cache.get(autonomous, INBOUND)).toBeNull();

    const reviewBump = { ...full, openReviewCount: full.openReviewCount + 1 };
    expect(cache.get(reviewBump, INBOUND)).toBeNull();

    const controlChanged = { ...full, controlMode: "HUMAN_CONTROL" };
    expect(cache.get(controlChanged, INBOUND)).toBeNull();

    const notesChanged = {
      ...full,
      policySummary: { allowAutonomous: false, notes: ["hold: aguardar revisao humana"] },
    };
    expect(cache.get(notesChanged, INBOUND)).toBeNull();

    // A entrada original segue válida (sem pós-condição de escrita).
    expect(cache.get(full, INBOUND)).not.toBeNull();
  });

  it("notes com vírgula não colidem: ['hold,manual'] vs ['hold','manual']", () => {
    const cache = new ExperimentReadCache();
    const full = fullReadContext();
    const commaJoined = {
      ...full,
      policySummary: { allowAutonomous: false, notes: ["hold,manual"] },
    };
    cache.put(commaJoined, INBOUND, projectReadModel(commaJoined));

    const splitNotes = {
      ...full,
      policySummary: { allowAutonomous: false, notes: ["hold", "manual"] },
    };
    // Serialização estrutural: chaves distintas, sem falso hit.
    expect(policyKey(commaJoined)).not.toBe(policyKey(splitNotes));
    expect(cache.get(splitNotes, INBOUND)).toBeNull();
    // A entrada original segue válida.
    expect(cache.get(commaJoined, INBOUND)).not.toBeNull();
  });
});
