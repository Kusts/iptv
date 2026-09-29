import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import {
  resetGatewayForTests,
  setGatewayForTests,
  WahaGatewayAdapter,
  type MessagingGatewayPort,
  type SendTextInput,
  type SendTextResult,
} from "../src/communications/messaging-gateway.js";
import {
  registerCommunicationCommands,
} from "../src/communications/communications.commands.js";
import {
  getRiskState,
  setRiskState,
} from "../src/communications/waha-risk-state.js";
import {
  bindSession,
  clearSessionBindingsForTests,
  expectedSessionFor,
  noteSessionRestart,
  validateSessionForTenant,
} from "../src/communications/waha-sessions.js";
import {
  normalizeWahaStatus,
  riskForSessionStatus,
} from "../src/communications/waha-normalizer.js";
import { WahaWebhookService } from "../src/communications/waha-webhook.service.js";
import { MemoryDb, MemoryInboxStore } from "./fakes/memory-fakes.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

function actor(tenantId: string = TENANT): CommandActor {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    isPlatformAdmin: false,
    tenantId,
    roleKeys: ["tenant_owner"],
    permissions: ["crm.person.read", "crm.lead.write", "conversation.reply"],
    actorType: "human",
  };
}

function setup() {
  const db = new MemoryDb();
  const bus = new CommandBus(db);
  registerCrmCommands(bus);
  registerCommunicationCommands(bus);
  return { db, bus };
}

async function registerPerson(bus: CommandBus, tenant: string = TENANT, identities: Array<{ identityType: string; normalizedValue: string }> = []) {
  return (await bus.execute<{ id: string }>(actor(tenant), "person.register", {
    canonicalName: "P",
    identities,
  })) as { ok: true; data: { id: string } };
}

async function startConversation(bus: CommandBus, personId: string, tenant: string = TENANT) {
  return bus.execute<{ id: string }>(actor(tenant), "conversation.start_manual", {
    personId,
    channel: "WHATSAPP",
  });
}

afterEach(() => {
  resetGatewayForTests();
  clearSessionBindingsForTests();
});

describe("F05 risk-state gating", () => {
  it("starts HEALTHY and blocks new outreach while CAPPED", async () => {
    const { db, bus } = setup();
    expect(getRiskState(TENANT, "WHATSAPP")).toBe("HEALTHY");
    const person = await registerPerson(bus);
    setRiskState(TENANT, "WHATSAPP", "CAPPED", "timelock");
    const started = await startConversation(bus, person.data.id);
    expect(started.ok ? null : started.code).toBe("precondition_failed");
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("conversation.started.v1");
  });

  it("defers send on a new conversation but keeps existing conversations sending", async () => {
    const { bus } = setup();
    const sentInputs: SendTextInput[] = [];
    const counting: MessagingGatewayPort = {
      name: "counting",
      async sendText(input: SendTextInput): Promise<SendTextResult> {
        sentInputs.push(input);
        return { ok: true, providerMessageId: "counting:1" };
      },
    };
    setGatewayForTests(counting);
    const person = await registerPerson(bus);
    const fresh = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const existing = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const first = await bus.execute(actor(), "message.send_manual", {
      conversationId: existing.data.id,
      text: "before cap",
    });
    expect(first.ok).toBe(true);
    setRiskState(TENANT, "WHATSAPP", "CAPPED", "timelock");
    const blocked = await bus.execute(actor(), "message.send_manual", {
      conversationId: fresh.data.id,
      text: "new outreach",
    });
    expect(blocked.ok ? null : blocked.code).toBe("precondition_failed");
    const allowed = await bus.execute(actor(), "message.send_manual", {
      conversationId: existing.data.id,
      text: "follow-up still works",
    });
    expect(allowed.ok).toBe(true);
    expect(sentInputs).toHaveLength(2);
  });

  it("keeps inbound ingest working while CAPPED", async () => {
    const { bus } = setup();
    const person = await registerPerson(bus, TENANT, [
      { identityType: "WHATSAPP", normalizedValue: "5511999990001" },
    ]);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    setRiskState(TENANT, "WHATSAPP", "CAPPED", "timelock");
    const ingested = (await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-inbound-capped",
      from: "5511999990001@c.us",
      text: "client reply",
      occurredAt: new Date().toISOString(),
    })) as { ok: true; data: { messageId: string; conversationId: string; duplicate: boolean } };
    expect(ingested.data.conversationId).toBe(conv.data.id);
    expect(ingested.data.duplicate).toBe(false);
  });

  it("records a provider CAPPED refusal once and defers later new outreach without retry", async () => {
    const { bus } = setup();
    let calls = 0;
    const cappedOnce: MessagingGatewayPort = {
      name: "capped-once",
      async sendText(): Promise<SendTextResult> {
        calls += 1;
        return { ok: false, code: "CAPPED", message: "timelock" };
      },
    };
    setGatewayForTests(cappedOnce);
    const person = await registerPerson(bus);
    const first = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const second = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const attempt = (await bus.execute(actor(), "message.send_manual", {
      conversationId: first.data.id,
      text: "try once",
    })) as { ok: true; data: { deliveryStatus: string } };
    expect(attempt.data.deliveryStatus).toBe("FAILED");
    expect(getRiskState(TENANT, "WHATSAPP")).toBe("CAPPED");
    const deferred = await bus.execute(actor(), "message.send_manual", {
      conversationId: second.data.id,
      text: "must not retry",
    });
    expect(deferred.ok ? null : deferred.code).toBe("precondition_failed");
    expect(calls).toBe(1);
  });

  it("maps WAHA HTTP 429 to CAPPED", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Too many requests" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const adapter = new WahaGatewayAdapter(`http://127.0.0.1:${port}`, "key", "default", 3000);
      const result = await adapter.sendText({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990001@c.us",
        text: "hi",
      });
      expect(result).toEqual({ ok: false, code: "CAPPED", message: expect.any(String) });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies WAHA session status payloads into risk states", () => {
    expect(normalizeWahaStatus({ event: "message", session: "default", payload: {} })).toEqual({
      kind: "not-status",
    });
    const failed = normalizeWahaStatus({ event: "session.status", session: "default", payload: { status: "FAILED" } });
    expect(failed).toEqual({ kind: "status", session: "default", status: "FAILED" });
    if (failed.kind === "status") {
      expect(riskForSessionStatus(failed.status)).toBe("DEGRADED");
    }
    expect(riskForSessionStatus("TIMELOCKED")).toBe("CAPPED");
    expect(riskForSessionStatus("WORKING")).toBe("HEALTHY");
    expect(riskForSessionStatus("something-else")).toBeNull();
  });

  it("applies session status webhooks to risk state without domain mutation", async () => {
    const { db, bus } = setup();
    const inbox = new MemoryInboxStore();
    const service = new WahaWebhookService(null, inbox, bus);
    const accepted = await service.acceptRaw({
      tenantId: TENANT,
      channel: "WHATSAPP",
      externalEventId: "waha-status-1",
      payload: { event: "session.status", session: "default", payload: { status: "TIMELOCKED" } },
    });
    expect(accepted.inserted).toBe(true);
    await service.processRow(TENANT, accepted.inboxId, {
      event: "session.status",
      session: "default",
      payload: { status: "TIMELOCKED" },
    });
    expect(getRiskState(TENANT, "WHATSAPP")).toBe("CAPPED");
    expect(db.txFor(TENANT).events).toHaveLength(0);
  });
});

describe("F06 tenant session routing", () => {
  it("resolves the default session and validates explicit bindings", () => {
    expect(expectedSessionFor(TENANT)).toBe("default");
    expect(validateSessionForTenant(TENANT, undefined)).toEqual({ ok: true, session: "default" });
    expect(validateSessionForTenant(TENANT, "default")).toEqual({ ok: true, session: "default" });
    bindSession(TENANT, "tenant-a");
    expect(expectedSessionFor(TENANT)).toBe("tenant-a");
    expect(validateSessionForTenant(TENANT, "tenant-a")).toEqual({ ok: true, session: "tenant-a" });
    const mismatch = validateSessionForTenant(TENANT, "tenant-b");
    expect(mismatch).toEqual({ ok: false, expected: "tenant-a", observed: "tenant-b" });
  });

  it("routes outbound through the tenant-bound session", async () => {
    const { bus } = setup();
    bindSession(TENANT, "tenant-a-session");
    const sentInputs: SendTextInput[] = [];
    const recording: MessagingGatewayPort = {
      name: "recording",
      async sendText(input: SendTextInput): Promise<SendTextResult> {
        sentInputs.push(input);
        return { ok: true, providerMessageId: "recording:1" };
      },
    };
    setGatewayForTests(recording);
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const sent = await bus.execute(actor(), "message.send_manual", {
      conversationId: conv.data.id,
      text: "hello",
    });
    expect(sent.ok).toBe(true);
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]?.session).toBe("tenant-a-session");
  });

  it("refuses a cross-session send at the adapter without touching the network", async () => {
    bindSession(TENANT, "tenant-a-session");
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "wamsg-ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const adapter = new WahaGatewayAdapter(`http://127.0.0.1:${port}`, "key", "tenant-a-session", 3000);
      const ok = await adapter.sendText({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990001@c.us",
        text: "hi",
        session: "tenant-a-session",
      });
      expect(ok).toEqual({ ok: true, providerMessageId: "wamsg-ok" });
      const mixed = await adapter.sendText({
        tenantId: TENANT,
        conversationId: newId(),
        to: "5511999990001@c.us",
        text: "hi",
        session: "tenant-b-session",
      });
      expect(mixed).toEqual({
        ok: false,
        code: "SESSION_MISMATCH",
        message: expect.any(String),
      });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("quarantines inbound with a foreign session instead of mixing conversations", async () => {
    const { bus } = setup();
    bindSession(TENANT, "tenant-a-session");
    bindSession(OTHER_TENANT, "tenant-b-session");
    const person = await registerPerson(bus, TENANT, [
      { identityType: "WHATSAPP", normalizedValue: "5511999990001" },
    ]);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    const foreign = (await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-foreign-session",
      from: "5511999990001@c.us",
      text: "wrong session",
      occurredAt: new Date().toISOString(),
      session: "tenant-b-session",
    })) as { ok: true; data: { messageId: string | null; conversationId: string | null; exceptionId: string } };
    expect(foreign.data.messageId).toBeNull();
    expect(foreign.data.conversationId).toBeNull();
    expect(foreign.data.exceptionId).toMatch(/^[0-9a-f-]{36}$/);
    const own = (await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-own-session",
      from: "5511999990001@c.us",
      text: "right session",
      occurredAt: new Date().toISOString(),
      session: "tenant-a-session",
    })) as { ok: true; data: { conversationId: string } };
    expect(own.data.conversationId).toBe(conv.data.id);
  });

  it("keeps routing correct across a session restart", async () => {
    const { bus } = setup();
    bindSession(TENANT, "tenant-a-session");
    expect(noteSessionRestart(TENANT, "tenant-a-session")).toEqual({ ok: true, session: "tenant-a-session" });
    const bad = noteSessionRestart(TENANT, "tenant-b-session");
    expect(bad).toEqual({ ok: false, expected: "tenant-a-session", observed: "tenant-b-session" });
    const sentInputs: SendTextInput[] = [];
    const recording: MessagingGatewayPort = {
      name: "recording-restart",
      async sendText(input: SendTextInput): Promise<SendTextResult> {
        sentInputs.push(input);
        return { ok: true, providerMessageId: "recording:2" };
      },
    };
    setGatewayForTests(recording);
    const person = await registerPerson(bus);
    const conv = (await startConversation(bus, person.data.id)) as { ok: true; data: { id: string } };
    expect(noteSessionRestart(TENANT, "tenant-a-session").ok).toBe(true);
    const sent = await bus.execute(actor(), "message.send_manual", {
      conversationId: conv.data.id,
      text: "after restart",
    });
    expect(sent.ok).toBe(true);
    expect(sentInputs[0]?.session).toBe("tenant-a-session");
  });
});
