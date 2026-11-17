import { describe, expect, it, vi } from "vitest";
import {
  composeResponse,
  composePaymentResponse,
  composeDeliveryResponse,
  getOrderState,
  listSellablePlans,
  resolveOrCreateLead,
  type BotContractDependencies,
} from "../src/bot/streammax-bot-contract.js";

describe("StreamMax bot contract", () => {
  it("resolves the same tenant WhatsApp identity without duplicate creation", async () => {
    const identities = new Map<string, { personId: string; leadId: string | null }>();
    let people = 0;
    let leads = 0;
    const deps: BotContractDependencies = {
      findPersonByWaId: async (tenantId, waId) => identities.get(`${tenantId}:${waId}`) ?? null,
      registerPerson: async (contact) => {
        const personId = `person-${++people}`;
        identities.set(`${contact.tenantId}:${contact.waId}`, { personId, leadId: null });
        return personId;
      },
      captureLead: async (tenantId, personId) => {
        const leadId = `lead-${++leads}`;
        const identity = [...identities.entries()].find(([, value]) => value.personId === personId);
        if (identity) identities.set(identity[0], { personId, leadId });
        return leadId;
      },
      listActivePlans: async () => [],
    };
    const contact = { tenantId: "t1", waId: "wa-1" };
    expect(await resolveOrCreateLead(contact, deps)).toEqual({ personId: "person-1", leadId: "lead-1", isNew: true });
    expect(await resolveOrCreateLead(contact, deps)).toEqual({ personId: "person-1", leadId: "lead-1", isNew: false });
    expect([people, leads]).toEqual([1, 1]);
    const other = await resolveOrCreateLead({ ...contact, waId: "wa-2" }, deps);
    expect(other).toEqual({ personId: "person-2", leadId: "lead-2", isNew: true });
  });

  it("propagates tenant scope and returns only active plans with active prices", async () => {
    let tenantSeen = "";
    const deps: BotContractDependencies = {
      findPersonByWaId: async (tenantId) => {
        tenantSeen = tenantId;
        return null;
      },
      registerPerson: async (contact) => {
        expect(contact.tenantId).toBe("tenant-7");
        return "p";
      },
      captureLead: async (tenantId) => {
        expect(tenantId).toBe("tenant-7");
        return "l";
      },
      listActivePlans: async (tenantId) => {
        tenantSeen = tenantId;
        return [
          { planId: "ok", name: "Plano", active: true, price: { amountMinor: 1234n, currency: "BRL", active: true } },
          { planId: "off", name: "Inativo", active: false, price: { amountMinor: 2n, currency: "BRL", active: true } },
          { planId: "no-price", name: "Sem preço", active: true, price: null },
        ];
      },
    };
    await resolveOrCreateLead({ tenantId: "tenant-7", waId: "wa" }, deps);
    expect(tenantSeen).toBe("tenant-7");
    expect(await listSellablePlans("tenant-7", deps)).toEqual([
      { planId: "ok", name: "Plano", amountMinor: 1234n, currency: "BRL" },
    ]);
  });

  it("resumes an existing person without a lead and isolates identical WhatsApp IDs by tenant", async () => {
    const identities = new Map<string, { personId: string; leadId: string | null }>([
      ["t1:shared", { personId: "existing", leadId: null }],
    ]);
    let registered = 0;
    const deps: BotContractDependencies = {
      findPersonByWaId: async (tenant, wa) => identities.get(`${tenant}:${wa}`) ?? null,
      registerPerson: async () => { registered++; return "unexpected"; },
      captureLead: async (_tenant, personId) => `lead-${personId}`,
      listActivePlans: async () => [],
    };
    expect(await resolveOrCreateLead({ tenantId: "t1", waId: "shared" }, deps))
      .toEqual({ personId: "existing", leadId: "lead-existing", isNew: false });
    expect(await resolveOrCreateLead({ tenantId: "t2", waId: "shared" }, deps))
      .toEqual({ personId: "unexpected", leadId: "lead-unexpected", isNew: true });
    expect(registered).toBe(1);
  });

  it("ensures a conversation for an existing person without releasing an existing takeover", async () => {
    const ensureConversation = vi.fn();
    const deps: BotContractDependencies = {
      findPersonByWaId: async () => ({ personId: "existing", leadId: "lead-existing" }),
      registerPerson: async () => "unexpected",
      captureLead: async () => "unexpected",
      ensureConversation,
      listActivePlans: async () => [],
    };
    const result = await resolveOrCreateLead({ tenantId: "t", waId: "wa" }, deps);
    expect(result).toEqual({ personId: "existing", leadId: "lead-existing", isNew: false });
    expect(ensureConversation).toHaveBeenCalledWith("t", "existing", { release: false });
  });

  it("composes only supplied official data and stays neutral without plans", () => {
    const lead = { tenantId: "t", personId: "p", leadId: "l", contactName: "Ana" };
    expect(composeResponse(lead, [])).toContain("aguardando as condições comerciais oficiais");
    expect(composeResponse(lead, [])).not.toMatch(/pagamento|ativad[oa]|renova|teste grátis/i);
    const response = composeResponse(lead, [{ planId: "x", name: "Essencial", amountMinor: 2500n, currency: "BRL" }]);
    expect(response).toContain("25,00");
    expect(response).not.toContain("menor unidade");
    expect(response).not.toMatch(/pagamento|ativad[oa]|renova/i);
    expect(composeResponse({ ...lead, contactName: "  Ana\nSilva  " }, [])).toContain("Ana Silva");
    expect(composeResponse({ ...lead, contactName: "A".repeat(100) }, [])).toContain("A".repeat(80));
  });

  it("uses the injected order query and stays pending until settled", async () => {
    let args: unknown[] = [];
    const deps = {
      getOrderState: async (...input: [string, string, string]) => {
        args = input;
        return { order: { orderId: "o", status: "AWAITING_PAYMENT", netAmountMinor: 100n, currency: "BRL" }, charge: null, settled: false };
      },
    } as unknown as BotContractDependencies;
    const state = await getOrderState("t", "p", "o", deps);
    expect(args).toEqual(["t", "p", "o"]);
    expect(composePaymentResponse(state)).toContain("aguardando confirmação");
    expect(composePaymentResponse(state)).not.toMatch(/pago|ativado/i);
  });

  it("does not claim payment when charge effect is uncertain", () => {
    const text = composePaymentResponse({ order: { orderId: "o", status: "AWAITING_PAYMENT", netAmountMinor: 1n, currency: "BRL" }, charge: { chargeId: "c", status: "PROCESSING", effectUncertain: true }, settled: false });
    expect(text).toContain("confirmando a geração da cobrança");
    expect(text).not.toMatch(/pago|aprovado/i);
  });

  it("does not claim activation while an operator is verifying", () => {
    for (const status of ["PAID_AWAITING_OPERATOR", "VERIFYING"] as const) {
      const response = composeDeliveryResponse({ status: status as "PAID_AWAITING_OPERATOR" });
      expect(response).not.toMatch(/ativ[oa]/i);
    }
  });

  it("stays neutral when an operator is verifying without verified settlement", () => {
    expect(composeDeliveryResponse({ status: "ACTION_NEEDED" })).not.toMatch(/pagamento confirmado/i);
  });
});
