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

const TOKEN_KEY = "iptv.session_token";

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
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const token = opts.token !== undefined ? opts.token : getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Não foi possível alcançar a API. Verifique sua conexão.");
  }
  if (res.status === 401) {
    clearToken();
    (opts.onUnauthorized ?? defaultUnauthorized)();
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
    throw new ApiError(res.status, code, messageForStatus(res.status, code));
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
  user: { id: string; email: string; displayName: string | null };
}

export interface SessionResponse {
  user: { id: string; email: string; displayName: string | null };
  activeTenantId: string | null;
  memberships: { tenantId: string; tenantSlug: string; tenantName: string; roleKey: string; status: string }[];
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

export interface CenterItem {
  source: string;
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
