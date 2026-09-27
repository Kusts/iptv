import { randomUUID } from "node:crypto";
import { withSpan } from "@iptv/observability";

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
}

export type SendTextResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: "UNKNOWN_EFFECT" | "FAILED"; message: string };

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
}

/** Default when no WAHA env is configured: logs and returns a fake id. */
export class LocalEchoGateway implements MessagingGatewayPort {
  readonly name = "echo";
  async sendText(input: SendTextInput): Promise<SendTextResult> {
    // Visible in server logs; never touches a real provider.
    console.log(`[echo-gateway] tenant=${input.tenantId} to=${input.to} text=${input.text.slice(0, 80)}`);
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
  ) {}

  async sendText(input: SendTextInput): Promise<SendTextResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/sendText`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({ chatId: input.to, text: input.text, session: this.session }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, code: "FAILED", message: `waha rejected send: HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const providerMessageId = typeof body?.id === "string" ? body.id : `waha:${randomUUID()}`;
      return { ok: true, providerMessageId };
    } catch (err) {
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
 * tenant only — destination and text are NEVER telemetry.
 */
export function tracedGateway(inner: MessagingGatewayPort): MessagingGatewayPort {
  return {
    name: inner.name,
    sendText: (input) =>
      withSpan("gateway.send_text", { gateway: inner.name, tenant: input.tenantId }, () =>
        inner.sendText(input),
      ),
  };
}
