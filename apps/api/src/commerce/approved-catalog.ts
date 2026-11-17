export type ApprovedPlanPeriod = "P1M" | "P3M" | "P6M" | "P12M";

type Price = { amountMinor: number; currency: "BRL" };

const planPrices: Record<ApprovedPlanPeriod, Price> = {
  P1M: { amountMinor: 3000, currency: "BRL" },
  P3M: { amountMinor: 7500, currency: "BRL" },
  P6M: { amountMinor: 15000, currency: "BRL" },
  P12M: { amountMinor: 30000, currency: "BRL" },
};

const additionalScreenPrices: Record<ApprovedPlanPeriod, Price> = {
  P1M: { amountMinor: 2000, currency: "BRL" },
  P3M: { amountMinor: 6000, currency: "BRL" },
  P6M: { amountMinor: 10000, currency: "BRL" },
  P12M: { amountMinor: 15000, currency: "BRL" },
};

const durations: Record<ApprovedPlanPeriod, number> = {
  P1M: 1,
  P3M: 3,
  P6M: 6,
  P12M: 12,
};

export const APPROVED_CATALOG = {
  metadata: {
    status: "approved",
    approver: "Proprietário do StreamMax",
    approvedAt: "2026-11-17",
    version: "V1.0",
    currency: "BRL",
  },
  plans: planPrices,
  additionalScreen: additionalScreenPrices,
  trial: { durationHours: 6, usesPerUser: 1, retryRequiresProvenTechnicalIssue: true },
  renewal: { effectiveAfterPayment: true },
} as const;

export function planPriceFor(period: ApprovedPlanPeriod): number {
  return planPrices[period].amountMinor;
}

export function additionalScreenPriceFor(period: ApprovedPlanPeriod): number {
  return additionalScreenPrices[period].amountMinor;
}

export function calculateTotal(period: ApprovedPlanPeriod, additionalScreens: number): number {
  if (!Number.isInteger(additionalScreens) || additionalScreens < 0) {
    throw new RangeError("additionalScreens must be a non-negative integer");
  }
  return planPriceFor(period) + additionalScreens * additionalScreenPriceFor(period);
}

export function formatBRL(amountMinor: number): string {
  if (!Number.isFinite(amountMinor)) throw new RangeError("amountMinor must be finite");
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(amountMinor / 100)
    .replace(/\u00a0/g, " ");
}

export function planDurationMonths(period: ApprovedPlanPeriod): number {
  return durations[period];
}

export function describeApprovedCatalog(): string {
  const plans = (Object.keys(planPrices) as ApprovedPlanPeriod[])
    .map((period) => `${period}: ${formatBRL(planPriceFor(period))} + tela ${formatBRL(additionalScreenPriceFor(period))}`)
    .join("; ");
  return `Catálogo ${APPROVED_CATALOG.metadata.version} aprovado por ${APPROVED_CATALOG.metadata.approver} em ${APPROVED_CATALOG.metadata.approvedAt}. ${plans}. Teste grátis de 6 horas, 1 vez por usuário; renovação após pagamento.`;
}
