export type BotContact = {
  tenantId: string;
  waId: string;
  name?: string;
};

export type BotLeadView = {
  tenantId: string;
  personId: string;
  leadId: string;
  contactName?: string;
};

export type BotPlanView = {
  planId: string;
  name: string;
  amountMinor: bigint;
  currency: string;
};

export type BotPlanRecord = {
  planId: string;
  name: string;
  active: boolean;
  price: { amountMinor: bigint; currency: string; active: boolean } | null;
};

export type BotOrderView = { orderId: string; status: string; netAmountMinor: bigint; currency: string };
export type BotChargeView = { chargeId: string; status: string; qrCode?: string | null; effectUncertain: boolean };
export type BotOrderState = { order: BotOrderView; charge: BotChargeView | null; settled: boolean };
export type BotSupportKind = "PAYMENT_QUESTION" | "ACTIVATION_DELAY" | "RENEWAL_REQUEST" | "GENERAL";
export type BotDeliveryStatus = "AWAITING_PAYMENT" | "PAID_AWAITING_OPERATOR" | "ACTIVE" | "ACTION_NEEDED";
export type BotDeliveryState = { status: BotDeliveryStatus };
export type BotRenewalInfo = { currentPeriodEnd: string | null; status: string } | null;

export type BotContractDependencies = {
  /**
   * Adapter serializes same-process calls and uses command-bus idempotency
   * plus the identity uniqueness constraint across processes.
   */
  findPersonByWaId(tenantId: string, waId: string): Promise<{ personId: string; leadId: string | null } | null>;
  /** Uses the command bus's command-scoped idempotency key. */
  registerPerson(contact: BotContact): Promise<string>;
  /** Used only while the caller holds serializedForContact's contact lock. */
  registerPersonUnlocked?(contact: BotContact): Promise<string>;
  captureLead(tenantId: string, personId: string): Promise<string>;
  /** Used only while the caller holds serializedForContact's contact lock. */
  captureLeadUnlocked?(tenantId: string, personId: string): Promise<string>;
  ensureConversation?(tenantId: string, personId: string, options?: { release?: boolean }): Promise<void>;
  listActivePlans(tenantId: string): Promise<readonly BotPlanRecord[]>;
  startPurchase?(contact: BotContact & { personId: string }, planId: string, intentRef?: string): Promise<{ orderId: string; chargeId: string; qrCode: string | null; effectUncertain: boolean }>;
  getOrderState?(tenantId: string, personId: string, orderId: string): Promise<BotOrderState>;
  openSupportRequest?(contact: BotContact & { personId: string }, kind: BotSupportKind, summary: string, refId?: string, intentRef?: string): Promise<void>;
  getDeliveryState?(tenantId: string, personId: string, ref: { orderId?: string; subscriptionId?: string }): Promise<BotDeliveryState>;
  getRenewalInfo?(tenantId: string, personId: string): Promise<BotRenewalInfo>;
};

export async function openSupportRequest(contact: BotContact & { personId: string }, kind: BotSupportKind, summary: string, deps: BotContractDependencies, refId?: string, intentRef?: string): Promise<void> {
  if (!deps.openSupportRequest) throw new Error("support is unavailable");
  return deps.openSupportRequest(contact, kind, summary, refId, intentRef);
}
export async function getDeliveryState(tenantId: string, personId: string, ref: { orderId?: string; subscriptionId?: string }, deps: BotContractDependencies): Promise<BotDeliveryState> {
  if (!deps.getDeliveryState) throw new Error("delivery state is unavailable");
  return deps.getDeliveryState(tenantId, personId, ref);
}
export async function getRenewalInfo(tenantId: string, personId: string, deps: BotContractDependencies): Promise<BotRenewalInfo> {
  if (!deps.getRenewalInfo) throw new Error("renewal info is unavailable");
  return deps.getRenewalInfo(tenantId, personId);
}
export function composeDeliveryResponse(state: BotDeliveryState): string {
  if (state.status === "ACTIVE") return "Seu serviço está ativo.";
  if (state.status === "PAID_AWAITING_OPERATOR") return "Pagamento confirmado. Nossa equipe está preparando seu acesso.";
  if (state.status === "AWAITING_PAYMENT") return "Seu pedido está aguardando confirmação do pagamento.";
  return "Estamos verificando o status do seu pedido.";
}
export const SUPPORT_ACKNOWLEDGEMENT = "Registramos sua solicitação, nossa equipe retornará.";

export async function startPurchase(contact: BotContact & { personId: string }, planId: string, deps: BotContractDependencies, intentRef?: string) {
  if (!deps.startPurchase) throw new Error("purchase is unavailable");
  const plans = await listSellablePlans(contact.tenantId, deps);
  if (!plans.some((plan) => plan.planId === planId)) throw new Error("plan is not available");
  return deps.startPurchase(contact, planId, intentRef);
}

export async function getOrderState(tenantId: string, personId: string, orderId: string, deps: BotContractDependencies): Promise<BotOrderState> {
  if (!deps.getOrderState) throw new Error("order state is unavailable");
  return deps.getOrderState(tenantId, personId, orderId);
}

export function composePaymentResponse(state: BotOrderState): string {
  if (state.settled) return "Pagamento confirmado.";
  if (state.charge?.effectUncertain) return "Estamos confirmando a geração da cobrança.";
  if (state.charge?.qrCode) return `PIX para pagamento:\n${state.charge.qrCode}`;
  return "O pedido está aguardando confirmação do pagamento.";
}

/**
 * Resolves identity and completes a missing lead. Idempotency under concurrency
 * depends on adapter-level serialization and command-bus idempotency.
 */
export async function resolveOrCreateLead(
  contact: BotContact,
  dependencies: BotContractDependencies,
): Promise<{ personId: string; leadId: string; isNew: boolean }> {
  const existing = await dependencies.findPersonByWaId(contact.tenantId, contact.waId);
  if (existing) {
    const leadId = existing.leadId || await dependencies.captureLead(contact.tenantId, existing.personId);
    await dependencies.ensureConversation?.(contact.tenantId, existing.personId, { release: false });
    return { personId: existing.personId, leadId, isNew: false };
  }
  // processRow owns the per-contact serialization; do not reacquire its mutex.
  const personId = await (dependencies.registerPersonUnlocked ?? dependencies.registerPerson)(contact);
  const leadId = await (dependencies.captureLeadUnlocked ?? dependencies.captureLead)(contact.tenantId, personId);
  await dependencies.ensureConversation?.(contact.tenantId, personId);
  return { personId, leadId, isNew: true };
}

/** Catalog approval is a product decision and is not inferred here. */
export async function listSellablePlans(
  tenantId: string,
  dependencies: BotContractDependencies,
): Promise<BotPlanView[]> {
  const records = await dependencies.listActivePlans(tenantId);
  return records.flatMap((plan) =>
    plan.active && plan.price?.active
      ? [{ planId: plan.planId, name: plan.name, amountMinor: plan.price.amountMinor, currency: plan.price.currency }]
      : [],
  );
}

function formatPrice(amountMinor: bigint, currency: string): string {
  const exponent = ({ JPY: 0, KRW: 0, BHD: 3, KWD: 3 } as Record<string, number>)[currency] ?? 2;
  const divisor = 10n ** BigInt(exponent);
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const whole = absolute / divisor;
  const fraction = exponent ? (absolute % divisor).toString().padStart(exponent, "0") : "";
  try {
    const formattedWhole = new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 0 }).format(whole);
    const localized = exponent
      ? formattedWhole.replace(/(\d[\d.]*)$/, `$1${new Intl.NumberFormat("pt-BR").formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ","}${fraction}`)
      : formattedWhole;
    return negative ? `-${localized}` : localized;
  } catch {
    const value = exponent ? `${whole.toString()},${fraction}` : whole.toString();
    return `${currency} ${negative ? "-" : ""}${value}`;
  }
}

/**
 * Customer-facing price presentation is provisional until the M1-B product decision;
 * displayed values derive only from official supplied data.
 */
export function composeResponse(lead: BotLeadView, plans: readonly BotPlanView[]): string {
  const contactName = lead.contactName?.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
  const greeting = contactName ? `Olá, ${contactName}.` : "Olá.";
  if (plans.length === 0) return `${greeting} Estamos aguardando as condições comerciais oficiais para informar os planos.`;
  const lines = plans.map((plan) => `${plan.name}: ${formatPrice(plan.amountMinor, plan.currency)}.`);
  return `${greeting} Estas são as condições oficiais disponíveis:\n${lines.join("\n")}`;
}
