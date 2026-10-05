/**
 * Camada HTTP do Control Center — único ponto de acesso à API.
 *
 * HARD BOUNDARY: o web NUNCA importa packages/database nem nenhum módulo
 * servidor; tudo passa por HTTP contra /v1. Nenhuma política de negócio
 * vive aqui — apenas transporte, tipos espelhados das respostas e
 * mensagens de erro em pt-BR.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export const TOKEN_KEY = "iptv.session_token";

/**
 * Marcador não-secreto de mudança de sessão entre abas (mesmo token com
 * tenant trocado não altera o token). O payload NUNCA é confiável como
 * identidade — serve apenas como sinal para recarregar a sessão no
 * servidor, que permanece autoritativa. Nunca contém bearer/segredo.
 */
export const SESSION_SIGNAL_KEY = "iptv.session_signal";

/** Emite o sinal cross-tab (somente outras abas recebem o `storage` event). */
export function broadcastSessionSignal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SESSION_SIGNAL_KEY,
      `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    );
  } catch {
    // armazenamento indisponível: a aba atual segue consistente
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

import { advanceApiGeneration, clearApiCache } from "./api-cache";

/**
 * Precondicionante monotônica de frescor do contexto de tenant (string
 * decimal canônica — nunca número): o cliente envia a revisão que observou
 * e o servidor rejeita com 409 `TENANT_CONTEXT_CONFLICT` quando ela não
 * coincide com a revisão autoritativa da sessão. O header nunca seleciona
 * tenant nem concede permissão.
 */
export const TENANT_CONTEXT_REVISION_HEADER = "x-tenant-context-revision";

/**
 * Revisão corrente observada pela UI (fonte: `SessionResponse` autoritativa).
 * Espelho em módulo para que o `apiFetch` capture o valor de forma síncrona
 * na invocação sem importar o `AuthProvider` (sem ciclo). Dono da escrita:
 * `AuthProvider` (restore/login/troca/reconciliação/logout/401/fail-closed).
 */
let currentTenantContextRevision: string | null = null;

/** Revisão esperada corrente, ou `null` quando nenhuma foi comitada ainda. */
export function getTenantContextRevision(): string | null {
  return currentTenantContextRevision;
}

/** Comita (`string`) ou limpa (`null`) a revisão corrente. Sem conversão. */
export function setTenantContextRevision(revision: string | null): void {
  currentTenantContextRevision = revision;
}

/** 409 de contexto stale: a requisição partiu de revisão defasada. */
export function isTenantContextConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === "TENANT_CONTEXT_CONFLICT";
}

type TenantContextConflictHandler = () => void;

let tenantContextConflictHandler: TenantContextConflictHandler | null = null;

/**
 * Registra o reconciliador do `AuthProvider`: invocado (best-effort, sem
 * await) quando uma chamada protegida não-switch do token ainda corrente
 * recebe 409 `TENANT_CONTEXT_CONFLICT`. Fora do provider: sem handler.
 */
export function setTenantContextConflictHandler(fn: TenantContextConflictHandler | null): void {
  tenantContextConflictHandler = fn;
}

/** Bootstrap/descoberta de sessão: não exigem o precondicionante. */
function isTenantContextExempt(path: string, method: string): boolean {
  const clean = path.split("?", 1)[0];
  if (method === "GET" && clean === "/v1/auth/session") return true;
  if (method === "POST" && clean === "/v1/auth/logout") return true;
  return false;
}

/** A troca de tenant tem fluxo próprio de reconciliação (sem notify global). */
function isTenantSwitchRequest(path: string, method: string): boolean {
  if (method !== "POST") return false;
  const clean = path.split("?", 1)[0] ?? "";
  return clean.startsWith("/v1/tenants/") && clean.endsWith("/switch");
}

/** Erro central da camada API, com mensagem amigável em pt-BR. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function defaultUnauthorized(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

/** Mensagem pt-BR por status/código — nunca vazar detalhe interno cru. */
export function messageForStatus(status: number, code?: string): string {
  if (status === 401) return "Sua sessão expirou. Entre novamente.";
  if (status === 403) {
    if (code === "FORBIDDEN" || code === "PERMISSION_DENIED") {
      return "Você não tem permissão para esta ação. Fale com um administrador.";
    }
    return "Acesso negado para o seu perfil.";
  }
  if (status === 404) return "Registro não encontrado neste tenant.";
  if (status === 409) return "Conflito de concorrência — recarregue e tente de novo.";
  if (status === 422 || status === 400) return "Dados inválidos. Confira os campos e tente de novo.";
  if (status === 503) return "Serviço temporariamente indisponível. Tente novamente em instantes.";
  if (status >= 500) return "Erro interno. Tente novamente; se persistir, abra um ticket.";
  return "Algo deu errado. Tente novamente.";
}

export interface ApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string | null;
  onUnauthorized?: () => void;
  /**
   * Revisão de contexto esperada (`x-tenant-context-revision`).
   * `undefined` (default) = usa a revisão corrente da sessão; `null` = omite
   * o precondicionante (bootstrap `/v1/auth/session`, `/v1/auth/logout`);
   * `string` = vincula a chamada exatamente a essa revisão (ex.: `/v1/me`
   * vinculado ao snapshot da sessão que o originou). Chamadas de ação da API
   * usam o default (revisão corrente capturada na invocação).
   */
  tenantContextRevision?: string | null;
  /**
   * Interno: `false` nas leituras internas do `refreshSession` (o próprio
   * retry limitado é dono do 409). Default `true` (leituras/ações disparam a
   * reconciliação do provider via handler global).
   */
  notifyContextConflict?: boolean;
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const token = opts.token !== undefined ? opts.token : getToken();
  const method = opts.method ?? "GET";
  // Captura síncrona na invocação: fixa token e revisão esperada antes de
  // qualquer await. Nunca reler o valor mutável após a resposta para
  // rotular/cachear a requisição.
  const requestRevision =
    opts.tenantContextRevision !== undefined ? opts.tenantContextRevision : getTenantContextRevision();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  // Toda chamada autenticada protegida leva o precondicionante, exceto o
  // bootstrap de sessão e o logout (que existem para descobrir/encerrar).
  if (token !== null && token !== undefined && requestRevision != null && !isTenantContextExempt(path, method)) {
    headers[TENANT_CONTEXT_REVISION_HEADER] = requestRevision;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Não foi possível alcançar a API. Verifique sua conexão.");
  }
  if (res.status === 401) {
    // Guarda anti-race: uma resposta 401 tardia de um token antigo (A) não
    // pode revogar uma sessão mais nova (B). Só transiciona o escopo e
    // navega quando o token capturado da requisição ainda é o token atual.
    const requestToken = token ? token : null;
    const currentTokenRaw = getToken();
    const currentToken = currentTokenRaw ? currentTokenRaw : null;
    const isCurrent = requestToken === currentToken;
    if (isCurrent) {
      (opts.onUnauthorized ?? defaultUnauthorized)();
      // Só transiciona o escopo quando a requisição levava credencial: sem
      // esse guarda, o refetch anônimo pós-401 geraria 401 de novo e o
      // avanço de geração entraria em loop, prendendo `loading=true`.
      if (requestToken !== null) {
        clearToken();
        setTenantContextRevision(null);
        // Invalida o escopo do cache: respostas do escopo antigo não podem
        // vazar para o próximo login/tenant. Sem ciclo: api-cache é folha.
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
      }
    }
    throw new ApiError(401, "UNAUTHENTICATED", messageForStatus(401));
  }
  if (!res.ok) {
    let code = "REQUEST_FAILED";
    try {
      const payload = (await res.json()) as { code?: unknown };
      if (typeof payload.code === "string" && payload.code.length > 0) code = payload.code;
    } catch {
      // corpo não-JSON: mantém o código genérico
    }
    const err = new ApiError(res.status, code, messageForStatus(res.status, code));
    // Conflito de contexto do token ainda corrente em chamada não-switch:
    // o token segue válido (nada é limpo aqui) — apenas sinaliza o
    // `AuthProvider` para reconciliação autoritativa (com dedupe no
    // provider). A troca tem fluxo próprio e nunca dispara este sinal.
    if (
      err.status === 409 &&
      code === "TENANT_CONTEXT_CONFLICT" &&
      token !== null &&
      token !== undefined &&
      token === getToken() &&
      !isTenantContextExempt(path, method) &&
      !isTenantSwitchRequest(path, method) &&
      opts.notifyContextConflict !== false
    ) {
      try {
        tenantContextConflictHandler?.();
      } catch {
        // reconciliação é best-effort: o erro original é propagado abaixo
      }
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts?: ApiOptions): Promise<T> => apiFetch<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: ApiOptions): Promise<T> =>
    apiFetch<T>(path, { ...opts, method: "POST", body }),
};

/** Extrai mensagem exibível de qualquer erro lançado pela camada. */
export function userMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Algo deu errado. Tente novamente.";
}

// ---------------------------------------------------------------------------
// Tipos espelhados das respostas /v1 (hand-written, sem import servidor).
// Valores monetários chegam como string (minor units) — nunca float.
// ---------------------------------------------------------------------------

export interface LoginResponse {
  token: string;
  activeTenantId: string | null;
  /** Revisão monotônica do contexto (string decimal — nunca número). */
  tenantContextRevision: string;
  user: { id: string; email: string; displayName: string | null };
}

export interface SessionResponse {
  user: { id: string; email: string; displayName: string | null };
  activeTenantId: string | null;
  /** Revisão autoritativa corrente da sessão (string decimal). */
  tenantContextRevision: string;
  memberships: { tenantId: string; tenantSlug: string; tenantName: string; roleKey: string; status: string }[];
}

/** Resposta da troca de tenant (nunca comitada direto: só via refresh). */
export interface SwitchTenantResponse {
  activeTenantId: string;
  tenantContextRevision: string;
}

export interface TenantsResponse {
  memberships: { tenantId: string; tenantSlug: string; tenantName: string; roleKey: string; status: string }[];
  activeTenantId: string | null;
}

export interface MeResponse {
  user: { id: string; email: string };
  activeTenant: { id: string };
  roleKeys: string[];
  permissions: string[];
}

export interface Conversation {
  id: string;
  personId: string;
  channel: string;
  status: string;
  controlMode: string;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  direction: string;
  senderType: string;
  contentType?: string;
  bodyText: string;
  externalMessageId?: string | null;
  deliveryStatus?: string | null;
  occurredAt: string;
}

export interface SubscriptionRow {
  id: string;
  customerId: string;
  planId: string;
  status: string;
  projectedState: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionDetail extends SubscriptionRow {
  originatingOrderId: string | null;
  startedAt: string | null;
  cancelledAt: string | null;
  cycles: { id: string; cycleNo: number; startsAt: string; endsAt: string; status: string }[];
  entitlements: { id: string; featureKey: string; status: string; startsAt: string; endsAt: string | null }[];
}

// ---------------------------------------------------------------------------
// Operações de provider — tipos espelhados de GET /v1/provider/operations.
// Espelham EXATAMENTE o allowlist sanitizado da API: nada de payload,
// resultSummary, segredo, correlação, evidência ou trace chega ao cliente.
// ---------------------------------------------------------------------------

/** Estados do domínio de operação de provider (mesmo CHECK do banco). */
export const PROVIDER_OPERATION_STATUSES = [
  "REQUESTED",
  "QUEUED",
  "RUNNING",
  "VERIFYING",
  "RETRY_WAIT",
  "HUMAN_REQUIRED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

/**
 * Proveniência que indica um adapter REAL (secret-gated): só o dispatcher com
 * readback conclusivo pode terminalizar essas linhas. `null`/desconhecido é
 * tratado como não-sintético (fail-closed: a UI não oferece SUCCEEDED).
 */
export const SECRET_REQUIRED_ADAPTER_VERSION = "secret-required-v1";

/** Synthetic (echo/manual) é a ÚNICA origem autorizada de SUCCEEDED manual. */
export function isSyntheticProviderOperation(op: {
  adapterVersion?: string | null;
  executionChannel?: string | null;
}): boolean {
  const version = op.adapterVersion;
  if (typeof version !== "string") return false;
  const v = version.trim().toLowerCase();
  if (v === SECRET_REQUIRED_ADAPTER_VERSION) return false;
  return v.endsWith("-v1") && ["echo", "manual"].includes(v.slice(0, -3));
}

export interface ProviderOperationRow {
  id: string;
  providerAccountId: string;
  action: string;
  entityType: string;
  entityId: string;
  status: string;
  effectCertainty: string;
  executionChannel: string | null;
  adapterVersion: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Contagem de tentativas (lista) — o detalhe traz as linhas. */
  attempts: number;
}

export interface ProviderOperationAttempt {
  attemptNo: number;
  status: string;
  errorCode: string | null;
  startedAt: string;
}

export interface ProviderOperationDetail extends Omit<ProviderOperationRow, "attempts"> {
  attempts: ProviderOperationAttempt[];
}

export interface ListProviderOperationsResponse {
  operations: ProviderOperationRow[];
  limit: number;
  offset: number;
}

export type ProviderResolveOutcome = "SUCCEEDED" | "FAILED" | "UNKNOWN";

/** Query da fila: status opcional + paginação (a API limita `limit` a 50). */
export function providerOperationsQuery(filter: { status?: string; limit?: number; offset?: number }): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined && filter.status.length > 0) params.set("status", filter.status);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter.offset !== undefined && filter.offset > 0) params.set("offset", String(filter.offset));
  const qs = params.toString();
  return `/v1/provider/operations${qs.length > 0 ? `?${qs}` : ""}`;
}

export interface OrderRow {
  id: string;
  person_id?: string;
  personId?: string;
  status: string;
  currency: string;
  net_amount_minor?: string | number;
  netAmountMinor?: string | number;
  settled_amount_minor?: string | number;
  settledAmountMinor?: string | number;
  created_at?: string;
  createdAt?: string;
}

export interface OrderDetail {
  order: {
    id: string;
    status: string;
    currency: string;
    gross_amount_minor: string | number;
    discount_amount_minor: string | number;
    reward_amount_minor: string | number;
    net_amount_minor: string | number;
    settled_amount_minor: string | number;
    created_at: string;
    awaiting_payment_at: string | null;
    settled_at: string | null;
    cancelled_at: string | null;
    expires_at: string | null;
  };
  items: {
    id: string;
    item_type: string;
    sellable_type: string;
    sellable_id: string | null;
    quantity: number;
    unit_price_minor: string | number;
    gross_minor: string | number;
    net_minor: string | number;
  }[];
}

export interface TicketRow {
  id: string;
  status: string;
  priority: string;
  summary: string;
  personId: string;
  assigneeUserId?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TicketDetail {
  ticket: {
    id: string;
    personId: string;
    customerId: string | null;
    conversationId: string | null;
    status: string;
    priority: string;
    category: string;
    summary: string;
    assigneeUserId: string | null;
    firstResponseAt: string | null;
    resolvedAt: string | null;
    closedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  incidents: { id: string; status: string; severity: string; title: string }[];
  problems: { id: string; status: string; title: string }[];
  attempts: {
    id: string;
    solutionId: string | null;
    procedureKey: string | null;
    attemptNo: number;
    actorType: string;
    outcome: string;
    completedAt: string | null;
  }[];
  solutionOutcomes: { id: string; solutionId: string; trialId: string | null; outcome: string; observedAt: string }[];
  conversation: { id: string; status: string; channel: string; controlMode: string } | null;
}

/**
 * Fontes do centro HITL. `provider_operation` (operações de provedor
 * paradas em `HUMAN_REQUIRED`) só chega a um caller com
 * `provider.operation.read`; a UI esconde a opção e as linhas sem essa
 * permissão, inclusive quando a resposta vem de cache velho.
 */
export const PROVIDER_OPERATION_SOURCE = "provider_operation" as const;
export const PROVIDER_OPERATION_READ_PERMISSION = "provider.operation.read";
export const PROVIDER_OPERATION_WRITE_PERMISSION = "provider.operation.write";
export const CENTER_SOURCES = [
  "human_review",
  "comm_exception",
  "billing_exception",
  "recovery_task",
  PROVIDER_OPERATION_SOURCE,
] as const;
export type CenterSource = (typeof CENTER_SOURCES)[number];

export interface CenterItem {
  source: CenterSource;
  id: string;
  kind: string;
  summary: string;
  priority: string | null;
  ageMinutes: number;
  sla: string;
  deepLink: string;
  createdAt: string;
}
export interface CenterResponse {
  items: CenterItem[];
  slaPolicy: { warnAfterHours: number; breachAfterHours: number; ref: string };
}

export interface HealthResponse {
  status: string;
  version: string;
  requestId: string;
  scheduler: string;
  tickSeconds: number;
}

// ---------------------------------------------------------------------------
// Knowledge maturation (Wave 15) — tipos espelhados das respostas /v1.
// ---------------------------------------------------------------------------

export interface KnowledgeQueueItem {
  id: string;
  status: string;
  knowledgeType?: string;
  contentText?: string;
  freshnessScore?: number | null;
}

export interface KnowledgeCorrectionRow {
  id: string;
  itemId: string;
  proposedText: string;
  status: string;
}

export interface KnowledgeGapRow {
  id: string;
  question: string;
  supportTicketId: string | null;
  status: string;
}

export interface KnowledgeItemsResponse {
  items: KnowledgeQueueItem[];
}

export interface KnowledgeCorrectionsResponse {
  corrections: KnowledgeCorrectionRow[];
}

export interface KnowledgeGapsResponse {
  gaps: KnowledgeGapRow[];
}

// ---------------------------------------------------------------------------
// Tenant Copilot (Wave 14-COPILOT, G18) — tipos espelhados das respostas /v1.
// ---------------------------------------------------------------------------

export interface CopilotSection {
  key: string;
  title: string;
  summary: string;
  deepLink: string;
  entity: Record<string, unknown> | null;
}

export interface CopilotContextResponse {
  route: string;
  sections: CopilotSection[];
  generatedAt: string;
}

export interface CopilotSuggestion {
  kind: "navigate" | "draft" | "info";
  label: string;
  deepLink?: string;
  draftCommand?: string;
  draftInput?: Record<string, unknown>;
  needsInput?: string[];
  reason?: string;
}

export interface CopilotAskResponse {
  summary: string;
  confidence: "OBSERVED" | "INFERRED";
  sectionsUsed: string[];
  data: Record<string, unknown>;
  suggestions: CopilotSuggestion[];
  deepLinks: Array<{ label: string; href: string }>;
}

export type CopilotExecuteStatus =
  | "executed"
  | "pending_review"
  | "denied"
  | "stale"
  | "unknown_command"
  | "not_found"
  | "invalid";

export interface CopilotExecuteResponse {
  status: CopilotExecuteStatus;
  message: string;
  command: string;
  data?: Record<string, unknown>;
  reviewId?: string;
}

export interface CopilotScreenInput {
  route: string;
  entityKind?: string;
  entityId?: string;
  selection?: Array<{ kind: string; id: string }>;
  filters?: Record<string, string>;
}

export function copilotContextQuery(screen: CopilotScreenInput): string {
  const params = new URLSearchParams({ route: screen.route });
  if (screen.entityKind !== undefined) params.set("entityKind", screen.entityKind);
  if (screen.entityId !== undefined) params.set("entityId", screen.entityId);
  if (screen.selection !== undefined) params.set("selection", JSON.stringify(screen.selection));
  if (screen.filters !== undefined) params.set("filters", JSON.stringify(screen.filters));
  return `/v1/agent/copilot/context?${params.toString()}`;
}
