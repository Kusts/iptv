import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@iptv/domain";
import type { CommandActor } from "@iptv/domain";
import { CommandBus } from "../src/commands/command-bus.js";
import { registerCrmCommands } from "../src/crm/crm.commands.js";
import {
  GatewayUnknownError,
  LocalEchoGateway,
  WahaGatewayAdapter,
  gatewayFromEnv,
  resetGatewayForTests,
  setGatewayForTests,
  type MessagingGatewayPort,
  type SendTextResult,
} from "../src/communications/messaging-gateway.js";
import {
  normalizeSender,
  normalizeWahaPayload,
} from "../src/communications/waha-normalizer.js";
import {
  registerCommunicationCommands,
  suppressionDecision,
} from "../src/communications/communications.commands.js";
import { MemoryDb } from "./fakes/memory-fakes.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as unknown;
}

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

afterEach(() => {
  resetGatewayForTests();
});

describe("WAHA normalizer (fixture-driven)", () => {
  it("maps the standard WAHA message shape", () => {
    const out = normalizeWahaPayload(fixture("waha-message.json"));
    expect(out.kind).toBe("message");
    if (out.kind !== "message") {
      throw new Error("expected message");
    }
    expect(out.externalId).toBe("wamsg-001");
    expect(out.from).toBe("5511999990001@c.us");
    expect(out.text).toBe("Olá, quero saber mais");
    expect(out.occurredAt).toBe("2025-09-26T18:40:00.000Z");
    expect(out.session).toBe("default");
  });

  it("maps the flat author/text variant", () => {
    const out = normalizeWahaPayload(fixture("waha-message-flat.json"));
    expect(out.kind).toBe("message");
    if (out.kind !== "message") {
      throw new Error("expected message");
    }
    expect(out.externalId).toBe("wamsg-flat-002");
    expect(out.from).toBe("5511999990002@s.whatsapp.net");
    expect(out.text).toBe("Preço do plano mensal?");
  });

  it("acks unknown event types without mutating", () => {
    expect(normalizeWahaPayload(fixture("waha-unknown-event.json"))).toEqual({
      kind: "unknown",
      rawEvent: "session.status",
    });
    expect(normalizeWahaPayload(null)).toEqual({ kind: "unknown", rawEvent: "malformed" });
  });

  it("ignores own outbound echoes and delivery acks", () => {
    expect(normalizeWahaPayload(fixture("waha-from-me.json"))).toEqual({
      kind: "unknown",
      rawEvent: "message:fromMe",
    });
    expect(normalizeWahaPayload(fixture("waha-ack.json"))).toEqual({
      kind: "unknown",
      rawEvent: "message.ack",
    });
  });

  it("normalizes sender addresses for identity matching", () => {
    expect(normalizeSender("5511999990001@c.us")).toBe("5511999990001");
    expect(normalizeSender("5511999990002@s.whatsapp.net")).toBe("5511999990002");
    expect(normalizeSender("+55 11 99999-0001")).toBe("+5511999990001");
  });
});

describe("messaging gateway selection", () => {
  it("defaults to the echo gateway without WAHA env", () => {
    const gateway = gatewayFromEnv({});
    expect(gateway.name).toBe("echo");
  });

  it("selects WAHA when env is configured", () => {
    const gateway = gatewayFromEnv({ WAHA_BASE_URL: "http://waha:3000", WAHA_API_KEY: "k" });
    expect(gateway.name).toBe("waha");
  });

  it("echo gateway returns an echo: provider id without network", async () => {
    const result = await new LocalEchoGateway().sendText({
      tenantId: TENANT,
      conversationId: newId(),
      to: "5511999990001@c.us",
      text: "hi",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.providerMessageId.startsWith("echo:")).toBe(true);
    }
  });

  it("WAHA adapter maps connection failure to FAILED (known not applied)", async () => {
    const adapter = new WahaGatewayAdapter("http://127.0.0.1:1", "key", "default", 3000);
    const result = await adapter.sendText({
      tenantId: TENANT,
      conversationId: newId(),
      to: "5511999990001@c.us",
      text: "hi",
    });
    expect(result).toEqual({ ok: false, code: "FAILED", message: expect.any(String) });
  });
});

describe("suppression / preference decision (pure)", () => {
  const at = new Date("2026-09-26T12:00:00Z");
  it("passes with no rows", () => {
    expect(
      suppressionDecision({ suppressions: [], preferences: [], personId: "p", identityIds: [], channel: "WHATSAPP", at }),
    ).toEqual({ blocked: false });
  });

  it("blocks on an active person+channel suppression", () => {
    expect(
      suppressionDecision({
        suppressions: [
          { personId: "p", identityId: null, channel: "WHATSAPP", startsAt: new Date("2026-01-01"), endsAt: null },
        ],
        preferences: [],
        personId: "p",
        identityIds: [],
        channel: "WHATSAPP",
        at,
      }),
    ).toEqual({ blocked: true, reason: "recipient is suppressed for this channel" });
  });

  it("never treats an identity-only row as a tenant-wide wildcard", () => {
    expect(
      suppressionDecision({
        suppressions: [
          { personId: null, identityId: "other-identity", channel: "WHATSAPP", startsAt: new Date("2026-01-01"), endsAt: null },
        ],
        preferences: [],
        personId: "p",
        identityIds: ["my-identity"],
        channel: "WHATSAPP",
        at,
      }),
    ).toEqual({ blocked: false });
  });

  it("blocks via a linked identity suppression", () => {
    expect(
      suppressionDecision({
        suppressions: [
          { personId: null, identityId: "my-identity", channel: "WHATSAPP", startsAt: new Date("2026-01-01"), endsAt: null },
        ],
        preferences: [],
        personId: "p",
        identityIds: ["my-identity"],
        channel: "WHATSAPP",
        at,
      }),
    ).toEqual({ blocked: true, reason: "recipient is suppressed for this channel" });
  });

  it("ignores expired suppressions and other channels", () => {
    expect(
      suppressionDecision({
        suppressions: [
          { personId: "p", identityId: null, channel: "WHATSAPP", startsAt: new Date("2026-01-01"), endsAt: new Date("2026-02-01") },
          { personId: "p", identityId: null, channel: "SMS", startsAt: new Date("2026-01-01"), endsAt: null },
        ],
        preferences: [],
        personId: "p",
        identityIds: [],
        channel: "WHATSAPP",
        at,
      }),
    ).toEqual({ blocked: false });
  });

  it("honors a DENIED channel preference (opt-out)", () => {
    expect(
      suppressionDecision({
        suppressions: [],
        preferences: [{ personId: "p", channel: "WHATSAPP", status: "DENIED" }],
        personId: "p",
        identityIds: [],
        channel: "WHATSAPP",
        at,
      }),
    ).toEqual({ blocked: true, reason: "channel opted out by preference" });
  });
});

describe("CRM commands (memory store)", () => {
  it("registers a person with identities and emits person.created.v1", async () => {
    const { db, bus } = setup();
    const result = await bus.execute<{ id: string }>(actor(), "person.register", {
      canonicalName: "Lead Um",
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990001@c.us" }],
    });
    expect(result.ok).toBe(true);
    const tx = db.txFor(TENANT);
    expect(tx.events.map((e) => e.event_type)).toEqual(["person.created.v1"]);
    expect(tx.audits.map((a) => a.action)).toEqual(["crm.person.register"]);
  });

  it("rejects a duplicate identity in the same tenant, allows it in another tenant", async () => {
    const { bus } = setup();
    const input = {
      canonicalName: "Dup",
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990009" }],
    };
    expect((await bus.execute(actor(), "person.register", input)).ok).toBe(true);
    const dup = await bus.execute(actor(), "person.register", input);
    expect(dup.ok ? null : dup.code).toBe("precondition_failed");
    // Tenant isolation: the same natural key is a different fact elsewhere.
    expect((await bus.execute(actor(OTHER_TENANT), "person.register", input)).ok).toBe(true);
  });

  it("captures a lead around an existing person and emits lead.created.v1", async () => {
    const { db, bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", { canonicalName: "P" })) as {
      ok: true;
      data: { id: string };
    };
    const lead = await bus.execute<{ id: string }>(actor(), "lead.capture", { personId: person.data.id });
    expect(lead.ok).toBe(true);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toEqual(["person.created.v1", "lead.created.v1"]);
    const missing = await bus.execute(actor(), "lead.capture", { personId: newId() });
    expect(missing.ok ? null : missing.code).toBe("not_found");
    // Cross-tenant person reference is invisible.
    const foreign = await bus.execute(actor(OTHER_TENANT), "lead.capture", { personId: person.data.id });
    expect(foreign.ok ? null : foreign.code).toBe("not_found");
  });

  it("enforces owning-context lead transitions", async () => {
    const { bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {})) as {
      ok: true;
      data: { id: string };
    };
    const lead = (await bus.execute<{ id: string }>(actor(), "lead.capture", { personId: person.data.id })) as {
      ok: true;
      data: { id: string };
    };
    const ok = await bus.execute(actor(), "lead.transition", { leadId: lead.data.id, toStatus: "CONTACTED" });
    expect(ok).toEqual({ ok: true, data: { id: lead.data.id, status: "CONTACTED" } });
    const bad = await bus.execute(actor(), "lead.transition", { leadId: lead.data.id, toStatus: "CONVERTED" });
    expect(bad.ok ? null : bad.code).toBe("precondition_failed");
    // No event is invented for transitions; the audit row is the trace.
  });
});

describe("communications commands (memory store)", () => {
  async function startConversation(bus: CommandBus, personId: string) {
    return (await bus.execute<{ id: string }>(actor(), "conversation.start_manual", {
      personId,
      channel: "WHATSAPP",
    })) as { ok: true; data: { id: string } };
  }

  it("starts a manual conversation and emits conversation.started.v1", async () => {
    const { db, bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {})) as {
      ok: true;
      data: { id: string };
    };
    const conv = await startConversation(bus, person.data.id);
    expect(conv.ok).toBe(true);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("conversation.started.v1");
  });

  it("send_manual happy path appends message + SENT delivery via echo", async () => {
    const { db, bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990001" }],
    })) as { ok: true; data: { id: string } };
    const conv = await startConversation(bus, person.data.id);
    const sent = await bus.execute<{
      messageId: string;
      deliveryStatus: string;
      providerMessageId: string | null;
    }>(actor(), "message.send_manual", { conversationId: conv.data.id, text: "Olá!" });
    expect(sent).toEqual({
      ok: true,
      data: {
        messageId: expect.any(String),
        deliveryStatus: "SENT",
        providerMessageId: expect.stringMatching(/^echo:/),
      },
    });
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("message.sent.v1");
  });

  it("send_manual on a closed conversation is rejected", async () => {
    const { bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {})) as {
      ok: true;
      data: { id: string };
    };
    const conv = await startConversation(bus, person.data.id);
    expect((await bus.execute(actor(), "conversation.close", { conversationId: conv.data.id })).ok).toBe(true);
    const sent = await bus.execute(actor(), "message.send_manual", {
      conversationId: conv.data.id,
      text: "too late",
    });
    expect(sent.ok ? null : sent.code).toBe("precondition_failed");
  });

  it("unknown gateway effect parks delivery as QUEUED + PAUSED/RECONCILE_REQUIRED (no retry)", async () => {
    const { db, bus } = setup();
    const flaky: MessagingGatewayPort = {
      name: "flaky",
      sendText(): Promise<SendTextResult> {
        throw new GatewayUnknownError();
      },
    };
    setGatewayForTests(flaky);
    try {
      const person = (await bus.execute<{ id: string }>(actor(), "person.register", {})) as {
        ok: true;
        data: { id: string };
      };
      const conv = await startConversation(bus, person.data.id);
      const sent = (await bus.execute(actor(), "message.send_manual", {
        conversationId: conv.data.id,
        text: "uncertain",
      })) as {
        ok: true;
        data: { messageId: string; deliveryStatus: string; providerMessageId: string | null };
      };
      expect(sent.data.deliveryStatus).toBe("QUEUED");
      expect(sent.data.providerMessageId).toBeNull();
      expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("conversation.paused.v1");
      expect(db.txFor(TENANT).events.map((e) => e.event_type)).not.toContain("message.sent.v1");
    } finally {
      resetGatewayForTests();
    }
  });

  it("takeover and return append control events and are idempotent", async () => {
    const { db, bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {})) as {
      ok: true;
      data: { id: string };
    };
    const conv = await startConversation(bus, person.data.id);
    // start_manual already opens in HUMAN_CONTROL → assign is a no-op.
    const assign = await bus.execute(actor(), "conversation.assign", { conversationId: conv.data.id });
    expect(assign).toEqual({
      ok: true,
      data: { id: conv.data.id, controlMode: "HUMAN_CONTROL", already: true },
    });
    const release = await bus.execute(actor(), "conversation.release", { conversationId: conv.data.id });
    expect(release).toEqual({
      ok: true,
      data: { id: conv.data.id, controlMode: "AI_CONTROL", already: false },
    });
    const events = db.txFor(TENANT).events.map((e) => e.event_type);
    expect(events).toContain("conversation.returned_to_ai.v1");
  });

  it("ingest matches by identity and dedupes; unknown senders queue exceptions", async () => {
    const { db, bus } = setup();
    const person = (await bus.execute<{ id: string }>(actor(), "person.register", {
      identities: [{ identityType: "WHATSAPP", normalizedValue: "5511999990001" }],
    })) as { ok: true; data: { id: string } };
    const conv = await startConversation(bus, person.data.id);
    const first = (await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-001",
      from: "5511999990001@c.us",
      text: "Olá",
      occurredAt: new Date().toISOString(),
    })) as { ok: true; data: { messageId: string; conversationId: string; duplicate: boolean } };
    expect(first.data.conversationId).toBe(conv.data.id);
    expect(first.data.duplicate).toBe(false);
    const second = await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-001",
      from: "5511999990001@c.us",
      text: "Olá",
      occurredAt: new Date().toISOString(),
    });
    expect(second).toEqual({
      ok: true,
      data: { messageId: first.data.messageId, conversationId: conv.data.id, exceptionId: null, duplicate: true },
    });
    const unknown = (await bus.execute(actor(), "message.ingest", {
      channel: "WHATSAPP",
      externalMessageId: "wamsg-999",
      from: "5511888880000@c.us",
      text: "quem sou eu?",
      occurredAt: new Date().toISOString(),
    })) as { ok: true; data: { exceptionId: string } };
    expect(unknown.data.exceptionId).toMatch(/^[0-9a-f-]{36}$/);
    const resolved = await bus.execute(actor(), "exception.resolve", {
      exceptionId: unknown.data.exceptionId,
      action: "map",
      personId: person.data.id,
    });
    expect((resolved as { ok: boolean }).ok).toBe(true);
    expect(db.txFor(TENANT).events.map((e) => e.event_type)).toContain("message.received.v1");
  });
});
