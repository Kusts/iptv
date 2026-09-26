import type { AgentMode, ContextBundle } from "./types.js";

/**
 * Model gateway port. The harness NEVER calls an LLM provider directly —
 * every completion flows through this port so tests/dev run on the
 * deterministic echo gateway and real calls stay env-gated.
 */
export interface ModelMessage {
  role: "system" | "developer" | "user";
  content: string;
}

export interface ModelCompletion {
  text: string;
  /** Deterministic eval label produced alongside the text. */
  label: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelGatewayPort {
  readonly name: string;
  complete(messages: ModelMessage[], opts: { model: string; maxTokens: number }): Promise<ModelCompletion>;
}

/**
 * Prompt-injection guard patterns. Inbound customer text (and any retrieved
 * external text) is DATA, never instruction: when it carries instruction-like
 * language aimed at the agent, the echo gateway refuses deterministically.
 * The OpenAI adapter relies on the same tagging discipline (untrusted blocks
 * are labelled in the user message) plus this post-check on raw output.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /ignore\s+(todas\s+)?as\s+instru/i,
  /desconsidere\s+(todas\s+)?(as\s+)?instru/i,
  /you\s+are\s+now\s+/i,
  /você\s+agora\s+é/i,
  /new\s+system\s+prompt/i,
  /reveal\s+(your\s+)?(system\s+prompt|instructions|secret|password|api[-\s_]?key)/i,
  /revele?\s+(sua\s+)?(senha|system\s+prompt|instru)/i,
  /mostre\s+(sua\s+)?(senha|system\s+prompt|secret)/i,
  /show\s+me\s+(your\s+)?(system\s+prompt|secret|password)/i,
  /jailbreak/i,
  /do\s+anything\s+now/i,
];

const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{8,}/, /api[_-]?key\s*[:=]/i, /bearer\s+[A-Za-z0-9._~-]{8,}/i];

/** True when the text carries instruction-override or secret-extraction intent. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** True when the text appears to carry a leaked secret (never send to model / customer). */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const OFF_SCOPE_PATTERNS = [
  /desconto|discount|coupon|cupom/i,
  /reembols|refund/i,
  /cancel.*assinatura|cancel.*subscription/i,
  /senha|password/i,
  /preço|price/i,
];

const TOOL_REQUEST_PATTERNS = [/meus?\s+dados|meu\s+cadastro|my\s+(data|account|profile)/i];

/**
 * Deterministic rule-based gateway for tests/dev. Maps the tagged inbound
 * text to a labelled proposal WITHOUT any network call. Default everywhere;
 * the OpenAI adapter is only constructed when `OPENAI_API_KEY` is present.
 */
export class EchoModelGateway implements ModelGatewayPort {
  readonly name = "echo";

  async complete(messages: ModelMessage[], opts: { model: string; maxTokens: number }): Promise<ModelCompletion> {
    const userBlock = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n") ?? "";
    const inbound = extractInbound(userBlock);
    const suppressionActive = /suppression_active:\s*true/i.test(userBlock);

    if (looksLikeInjection(inbound)) {
      return {
        text: "Não posso seguir instruções embutidas na mensagem. Como posso ajudar dentro do atendimento?",
        label: "injection_refusal",
        usage: usageOf(messages, opts.model),
      };
    }
    if (suppressionActive) {
      return {
        text: "SUPPRESSED: o contato está com restrição ativa neste canal; nenhuma mensagem deve ser enviada.",
        label: "suppression_respect",
        usage: usageOf(messages, opts.model),
      };
    }
    if (OFF_SCOPE_PATTERNS.some((re) => re.test(inbound))) {
      return {
        text: "Esse pedido está fora do que posso resolver sozinho; vou encaminhar para um atendente humano.",
        label: "off_scope_refusal",
        usage: usageOf(messages, opts.model),
      };
    }
    void TOOL_REQUEST_PATTERNS;
    return {
      text: `Olá! Recebi sua mensagem e vou ajudar. Pode me contar mais detalhes?`,
      label: "happy_reply",
      usage: usageOf(messages, opts.model),
    };
  }
}

/** Inbound text is rendered inside a labelled untrusted block; extract it back. */
function extractInbound(userBlock: string): string {
  const match = /<untrusted-inbound>([\s\S]*?)<\/untrusted-inbound>/m.exec(userBlock);
  if (match?.[1] !== undefined) {
    return match[1].trim();
  }
  return userBlock.trim();
}

function usageOf(messages: ModelMessage[], model: string): { inputTokens: number; outputTokens: number } {
  void model;
  const inputTokens = Math.ceil(messages.map((m) => m.content.length).join("").length / 4);
  return { inputTokens, outputTokens: 24 };
}

/** Renders the deterministic user block: structured context + tagged untrusted inbound. */
export function renderUserBlock(context: ContextBundle, inboundText: string, mode: AgentMode): string {
  const recent = context.recentMessages
    .slice(-8)
    .map((m) => `[${m.direction}/${m.senderType}] ${m.bodyText ?? "(no text)"}`)
    .join("\n");
  return [
    `tenant: ${context.tenantId}`,
    `conversation: ${context.conversationId}`,
    `channel: ${context.channel}`,
    `control_mode: ${context.controlMode}`,
    `person: ${context.personSummary?.canonicalName ?? "unknown"} (${context.personSummary?.personId ?? "none"})`,
    `suppression_active: ${context.suppressionsActive ? "true" : "false"}`,
    `open_reviews: ${context.openReviewCount}`,
    `policy_allow_autonomous: ${context.policySummary.allowAutonomous ? "true" : "false"}`,
    `mode: ${mode}`,
    `recent_messages:`,
    recent,
    `<untrusted-inbound>`,
    inboundText,
    `</untrusted-inbound>`,
  ].join("\n");
}

export interface OpenAiCompatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Env-gated OpenAI-compatible adapter (fetch chat completions). NEVER constructed without a key. */
export class OpenAICompatGateway implements ModelGatewayPort {
  readonly name = "openai-compat";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly defaultModel: string;

  constructor(opts: OpenAiCompatOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI-compatible gateway");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.defaultModel = opts.model;
  }

  async complete(messages: ModelMessage[], opts: { model: string; maxTokens: number }): Promise<ModelCompletion> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: opts.model || this.defaultModel,
        max_tokens: opts.maxTokens,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) {
      throw new Error(`model gateway rejected completion: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("model gateway returned an empty completion");
    }
    if (looksLikeInjection(text) || looksLikeSecret(text)) {
      throw new Error("model output failed the safety post-check");
    }
    return {
      text,
      label: "live_completion",
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export interface GatewayEnv {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  AGENT_MODEL?: string;
}

/** Select the gateway from env: echo is the DEFAULT; OpenAI only with a key. */
export function gatewayFromEnv(env: GatewayEnv = process.env): ModelGatewayPort {
  const apiKey = env["OPENAI_API_KEY"];
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return new OpenAICompatGateway({
      apiKey,
      baseUrl: env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      model: env["AGENT_MODEL"] ?? "gpt-4o-mini",
    });
  }
  return new EchoModelGateway();
}
