import { randomUUID } from "node:crypto";
import { withSpan } from "@iptv/observability";
import {
  currentOutboundAttachmentStore,
  resolveOutboundAttachmentWithStore,
  validateOutboundAttachmentRef,
  type OutboundAttachmentStore,
} from "./waha-outbound-attachments.js";
import { expectedSessionFor } from "./waha-sessions.js";

/**
 * Wave 2 messaging gateway port. The external provider (WAHA today, GOWS
 * later) is NEVER the source of truth for business state — it only carries
 * an already-persisted outbound message. All implementations are swappable
 * behind this port.
 */

export interface SendTextInput {
  tenantId: string;
  conversationId: string;
  /** Provider-routable destination (e.g. `5511999999999@c.us`). */
  to: string;
  text: string;
  session?: string;
}

export type SendTextResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: "UNKNOWN_EFFECT" | "FAILED" | "CAPPED" | "SESSION_MISMATCH"; message: string };

/** Outbound media kinds (test-only doubles, zero live network). */
export type SendMediaKind = "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO";

export interface SendMediaInput {
  tenantId: string;
  conversationId: string;
  /** Provider-routable destination (e.g. `5511999999999@c.us`). */
  to: string;
  kind: SendMediaKind;
  /** Internal attachment reference persisted on the message row (never a live file URL in tests). */
  attachmentRef: string;
  mimeType: string;
  fileName: string | null;
  caption: string | null;
  durationSeconds: number | null;
  session?: string;
}

export type SendMediaResult = SendTextResult;

/** WAHA endpoint per media kind. */
export const SEND_MEDIA_ENDPOINT: Record<SendMediaKind, string> = {
  IMAGE: "sendImage",
  DOCUMENT: "sendFile",
  AUDIO: "sendVoice",
  VIDEO: "sendVideo",
};

/** Transport failure with uncertain effect (timeout after the send attempt). */
export class GatewayUnknownError extends Error {
  readonly code = "UNKNOWN_EFFECT";
  constructor(message = "gateway effect unknown: timeout after send attempt") {
    super(message);
  }
}

export interface MessagingGatewayPort {
  readonly name: string;
  sendText(input: SendTextInput): Promise<SendTextResult>;
  /**
   * Optional media send. Legacy doubles implement only `sendText`; the
   * command layer treats a missing `sendMedia` as unavailable (FAILED),
   * never as a reason to touch `sendText` semantics.
   */
  sendMedia?(input: SendMediaInput): Promise<SendMediaResult>;
}

/** Default when no WAHA env is configured: logs and returns a fake id. */
export class LocalEchoGateway implements MessagingGatewayPort {
  readonly name = "echo";
  readonly sentInputs: SendTextInput[] = [];
  readonly sentMediaInputs: SendMediaInput[] = [];
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    this.sentInputs.push(input);
    // Visible in server logs; never touches a real provider.
    console.log(`[echo-gateway] tenant=${input.tenantId} to=${input.to} text=${input.text.slice(0, 80)}`);
    return { ok: true, providerMessageId: `echo:${randomUUID()}` };
  }
  async sendMedia(input: SendMediaInput): Promise<SendMediaResult> {
    this.sentMediaInputs.push(input);
    console.log(`[echo-gateway] tenant=${input.tenantId} to=${input.to} kind=${input.kind} ref=${input.attachmentRef.slice(0, 80)}`);
    return { ok: true, providerMessageId: `echo:${randomUUID()}` };
  }
}

/**
 * WAHA HTTP adapter. Maps transport outcomes per the tool-failure taxonomy:
 * abort/timeout AFTER the request left → UNKNOWN_EFFECT (verify before any
 * retry); other failures → FAILED (known not applied).
 */
export class WahaGatewayAdapter implements MessagingGatewayPort {
  readonly name = "waha";
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly session = "default",
    private readonly timeoutMs = 8000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly attachmentStore?: OutboundAttachmentStore,
  ) {}

  async sendText(input: SendTextInput): Promise<SendTextResult> {
    const session = input.session ?? this.session;
    const expected = expectedSessionFor(input.tenantId);
    if (session !== expected) {
      return {
        ok: false,
        code: "SESSION_MISMATCH",
        message: `tenant session mismatch: expected ${expected}, got ${session}`,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/sendText`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({ chatId: input.to, text: input.text, session }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        return { ok: false, code: "CAPPED", message: "waha rejected send: HTTP 429 (timelock/capping)" };
      }
      if (!res.ok) {
        return { ok: false, code: "FAILED", message: `waha rejected send: HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const providerMessageId = typeof body?.id === "string" && body.id.length > 0 ? body.id : null;
      if (providerMessageId === null) {
        // HTTP 2xx without an observable provider id is inconclusive: the
        // send may or may not have been applied. Never record SENT with an
        // invented id — surface UNKNOWN so the caller parks for reconcile.
        throw new GatewayUnknownError("waha send confirmation inconclusive: HTTP 2xx without observable provider id");
      }
      return { ok: true, providerMessageId };
    } catch (err) {
      if (err instanceof GatewayUnknownError) {
        // Inconclusive confirmation (thrown above) already is UNKNOWN —
        // never downgrade it to FAILED.
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        // The request may already have been applied provider-side.
        throw new GatewayUnknownError();
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "FAILED", message: `waha send failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * WAHA media send (test-only doubles, zero live network). Same transport
   * taxonomy as `sendText`: session validated before any fetch, 429→CAPPED,
   * non-2xx→FAILED, abort→UNKNOWN, 2xx-without-id→UNKNOWN (never invent an
   * id). Kind selects the endpoint (`SEND_MEDIA_ENDPOINT`).
   */
  async sendMedia(input: SendMediaInput): Promise<SendMediaResult> {
    const session = input.session ?? this.session;
    const expected = expectedSessionFor(input.tenantId);
    if (session !== expected) {
      return {
        ok: false,
        code: "SESSION_MISMATCH",
        message: `tenant session mismatch: expected ${expected}, got ${session}`,
      };
    }
    // Defense-in-depth (delegated-SSRF guard): the adapter NEVER POSTs a
    // free-URL `attachmentRef` to WAHA — the WAHA server would fetch it.
    // Opaque tenant-authorized refs only; the command layer resolves them
    // server-side before calling here, so this also catches bypasses.
    const refCheck = validateOutboundAttachmentRef(input.attachmentRef);
    if (!refCheck.ok) {
      return { ok: false, code: "FAILED", message: `refused outbound attachment_ref: ${refCheck.message}` };
    }
    // Adapter-side revalidation (FIX-WAHA-FINAL): resolve tenant-scoped
    // registration/content through the injected store (default: the active
    // fail-closed global registry) BEFORE any network. Unknown refs,
    // cross-tenant refs, kind/MIME/content mismatches → FAILED, zero fetch.
    const store = this.attachmentStore ?? currentOutboundAttachmentStore();
    const resolved = await resolveOutboundAttachmentWithStore(store, {
      tenantId: input.tenantId,
      attachmentRef: input.attachmentRef,
      kind: input.kind,
      declaredMimeType: input.mimeType,
      declaredFileSizeBytes: undefined,
    });
    if (!resolved.ok) {
      return { ok: false, code: "FAILED", message: `refused outbound attachment_ref: ${resolved.message}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/${SEND_MEDIA_ENDPOINT[input.kind]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({
          chatId: input.to,
          session,
          caption: input.caption,
          file: { url: input.attachmentRef, mimetype: resolved.resolved.mimeType, filename: resolved.resolved.fileName },
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        return { ok: false, code: "CAPPED", message: "waha rejected media send: HTTP 429 (timelock/capping)" };
      }
      if (!res.ok) {
        return { ok: false, code: "FAILED", message: `waha rejected media send: HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const providerMessageId = typeof body?.id === "string" && body.id.length > 0 ? body.id : null;
      if (providerMessageId === null) {
        throw new GatewayUnknownError("waha media send confirmation inconclusive: HTTP 2xx without observable provider id");
      }
      return { ok: true, providerMessageId };
    } catch (err) {
      if (err instanceof GatewayUnknownError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new GatewayUnknownError();
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "FAILED", message: `waha media send failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Select the gateway from env: WAHA when configured, echo otherwise. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): MessagingGatewayPort {
  const baseUrl = env["WAHA_BASE_URL"];
  const apiKey = env["WAHA_API_KEY"];
  if (typeof baseUrl === "string" && baseUrl.length > 0 && typeof apiKey === "string" && apiKey.length > 0) {
    return new WahaGatewayAdapter(baseUrl, apiKey, env["WAHA_SESSION"] || "default");
  }
  return new LocalEchoGateway();
}

let activeGateway: MessagingGatewayPort = tracedGateway(gatewayFromEnv());

export function currentGateway(): MessagingGatewayPort {
  return activeGateway;
}

export function setGatewayForTests(gateway: MessagingGatewayPort): void {
  activeGateway = tracedGateway(gateway);
}

export function resetGatewayForTests(): void {
  activeGateway = tracedGateway(gatewayFromEnv());
}

/**
 * W1-12 span decorator for gateway sends. Attributes are gateway name +
 * tenant only — destination, text and media refs are NEVER telemetry.
 */
export function tracedGateway(inner: MessagingGatewayPort): MessagingGatewayPort {
  return {
    name: inner.name,
    sendText: (input) =>
      withSpan("gateway.send_text", { gateway: inner.name, tenant: input.tenantId }, () =>
        inner.sendText(input),
      ),
    ...(typeof inner.sendMedia === "function"
      ? {
          sendMedia: (input: SendMediaInput) =>
            withSpan("gateway.send_media", { gateway: inner.name, tenant: input.tenantId }, () =>
              (inner.sendMedia as (media: SendMediaInput) => Promise<SendMediaResult>)(input),
            ),
        }
      : {}),
  };
}
