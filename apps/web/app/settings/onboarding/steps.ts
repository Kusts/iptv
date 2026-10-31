/**
 * Modelo puro do wizard de onboarding (S5a, #89) — sem React, sem fetch.
 *
 * As 10 etapas seguem `docs/13-product-design/onboarding.md` §"Tenant
 * onboarding sequence" + "Refined tenant onboarding v0.14" e a SPEC S1 §3
 * (onboarding de tenant). Estados derivam SOMENTE de endpoints existentes:
 *
 * - `GET /v1/integrations` (linhas sanitizadas por provider);
 * - `GET /v1/integrations/whatsapp/session` (estado verbatim da sessão);
 * - `GET /v1/catalog/plans` (planos do catálogo);
 * - `GET /v1/orders` (pedidos — sinal de teste sem efeito).
 *
 * Etapas sem endpoint (conta/equipe, preferências comerciais, autonomia):
 * modo "manual/guiado" com instrução explícita — NUNCA mock de API
 * inexistente. Follow-ups documentados como S5-follow-up no chamador.
 */

export type OnboardingStepState = "concluida" | "pendente" | "pulada" | "atencao";

export type OnboardingStepId =
  | "conta-equipe"
  | "catalogo"
  | "asaas"
  | "whatsapp"
  | "cinevision"
  | "testes"
  | "preferencias"
  | "autonomia"
  | "diagnostico"
  | "golive";

export interface SanitizedIntegration {
  provider: string;
  environment: string;
  connection_status: string;
  capability_status: string;
  last_checked_at: string | null;
  last_error_code: string | null;
  configured: boolean;
}

export interface DerivedStep {
  state: OnboardingStepState;
  /** Resumo pt-BR do porquê deste estado (sem segredo, sem dado cru). */
  summary: string;
}

const ATTENTION_CONNECTIONS = new Set(["TESTING", "DEGRADED", "REAUTH_REQUIRED"]);
const DONE_CONNECTIONS = new Set(["CONNECTED_READ_ONLY", "READY_FOR_PILOT", "ACTIVE"]);

export const STEP_TITLES: Record<OnboardingStepId, string> = {
  "conta-equipe": "Conta e equipe",
  "catalogo": "Catálogo",
  "asaas": "Asaas (Cobranças)",
  "whatsapp": "WhatsApp (Atendimento)",
  "cinevision": "CINEVISION (Servidor/Ativação)",
  "testes": "Testes sem efeito",
  "preferencias": "Preferências comerciais",
  "autonomia": "Níveis de autonomia",
  "diagnostico": "Saúde e diagnóstico",
  "golive": "Go-live explícito",
};

/**
 * Texto exigido ao pular uma integração: modo manual para X + indisponível Y.
 * Sem promessa de efeito automático — o hub (`/settings/integrations`)
 * continua sendo o caminho de configuração.
 */
export const SKIP_COPY: Record<string, { manual: string; unavailable: string }> = {
  "asaas": {
    manual: "Modo manual para cobrança: gerar cobranças avulsas no painel Asaas e conciliar por extrato.",
    unavailable: "Indisponível: cobrança PIX automática, webhook de liquidação e reconciliação automática.",
  },
  "whatsapp": {
    manual: "Modo manual para atendimento: responder pelo aparelho/WhatsApp Web fora da plataforma.",
    unavailable: "Indisponível: pareamento no hub, mensagem de teste, último inbound e notificações automáticas.",
  },
  "cinevision": {
    manual: "Modo manual para ativação: ativar e renovar diretamente no painel CINEVISION.",
    unavailable: "Indisponível: validação de acesso, importação assistida e ativação pelo hub.",
  },
};

/** Etapas de integração que aceitam pulo explícito (SPEC S1 §3). */
export const SKIPPABLE_STEPS: OnboardingStepId[] = ["asaas", "whatsapp", "cinevision"];

export function isSkippable(step: OnboardingStepId): boolean {
  return SKIPPABLE_STEPS.includes(step);
}

export function deriveIntegrationStep(
  integration: SanitizedIntegration | undefined,
  skipped: boolean,
): DerivedStep {
  if (skipped) {
    const copy = SKIP_COPY[integration?.provider ?? ""];
    return {
      state: "pulada",
      summary:
        copy !== undefined
          ? `${copy.manual} ${copy.unavailable}`
          : "Etapa pulada pelo operador — o modo manual segue valendo.",
    };
  }
  if (integration === undefined || !integration.configured || integration.connection_status === "NOT_CONFIGURED") {
    return { state: "pendente", summary: "Não configurado neste tenant. Configure em /settings/integrations ou pule esta etapa." };
  }
  if (integration.connection_status === "DISABLED") {
    return { state: "pendente", summary: "Integração desativada — novos efeitos estão pausados. Reconfigure em /settings/integrations ou pule esta etapa." };
  }
  if (integration.last_error_code !== null || ATTENTION_CONNECTIONS.has(integration.connection_status)) {
    const code = integration.last_error_code !== null ? ` (último erro: ${integration.last_error_code})` : "";
    return {
      state: "atencao",
      summary: `Precisa de atenção: estado ${integration.connection_status}${code}. Corrija em /settings/integrations.`,
    };
  }
  if (DONE_CONNECTIONS.has(integration.connection_status)) {
    return { state: "concluida", summary: `Conectado (${integration.connection_status}) no ambiente ${integration.environment}.` };
  }
  return {
    state: "pendente",
    summary: `Rascunho (${integration.connection_status}). Use Testar em /settings/integrations para validar.`,
  };
}

const WHATSAPP_ATTENTION = new Set(["FAILED", "REAUTH_REQUIRED", "CAPPED"]);

/**
 * WhatsApp combina a linha de integração com a sessão verbatim do provedor
 * (`GET .../whatsapp/session`): WORKING conclui; FAILED/REAUTH/CAPPED pedem
 * atenção; sem sessão, vale a linha de integração (ou pendente).
 */
export function deriveWhatsappStep(
  integration: SanitizedIntegration | undefined,
  sessionStatus: string | null,
  skipped: boolean,
): DerivedStep {
  if (skipped) {
    return {
      state: "pulada",
      summary: `${SKIP_COPY["whatsapp"]?.manual ?? ""} ${SKIP_COPY["whatsapp"]?.unavailable ?? ""}`.trim(),
    };
  }
  if (sessionStatus !== null) {
    const upper = sessionStatus.toUpperCase();
    if (upper === "WORKING") {
      return { state: "concluida", summary: "Sessão WhatsApp conectada (WORKING). Pareamento confirmado." };
    }
    if (WHATSAPP_ATTENTION.has(upper)) {
      return {
        state: "atencao",
        summary: `Sessão precisa de atenção: ${sessionStatus}. Corrija em /settings/integrations (Reconectar).`,
      };
    }
    if (upper === "STOPPED" || upper === "STARTING" || upper === "SCAN_QR_CODE") {
      return { state: "pendente", summary: `Sessão em ${sessionStatus} — conclua o pareamento via QR em /settings/integrations.` };
    }
  }
  return deriveIntegrationStep(integration, false);
}

export function deriveCatalogStep(planCount: number): DerivedStep {
  if (planCount > 0) {
    return { state: "concluida", summary: `Catálogo com ${planCount} plano(s) publicado(s).` };
  }
  return {
    state: "pendente",
    summary: "Nenhum plano no catálogo. Cadastre planos antes de cotar pedidos (ver /orders).",
  };
}

/**
 * "Testes sem efeito": concluída quando ao menos uma validação read-only já
 * foi executada (`last_checked_at` de alguma integração) — conectar/testar é
 * read-only por construção (SPEC S1 §2, fail closed nos efeitos).
 */
export function deriveTestsStep(integrations: SanitizedIntegration[]): DerivedStep {
  const probed = integrations.filter((i) => i.last_checked_at !== null);
  if (probed.length > 0) {
    return {
      state: "concluida",
      summary: `Validação sem efeito executada em ${probed.length} integraç${probed.length === 1 ? "ão" : "ões"} (somente leitura — nada foi cobrado, enviado ou ativado).`,
    };
  }
  return {
    state: "pendente",
    summary: "Nenhuma validação executada ainda. Use Testar/Validar acesso em /settings/integrations (somente leitura, sem criar cobrança).",
  };
}

/** Diagnóstico agrega saúde real: atenção se qualquer vínculo sinalizar erro. */
export function deriveDiagnosticsStep(integrations: SanitizedIntegration[]): DerivedStep {
  if (integrations.length === 0) {
    return { state: "pendente", summary: "Sem vínculos para diagnosticar. Configure ao menos uma integração ou pule as opcionais." };
  }
  const troubled = integrations.filter(
    (i) => i.last_error_code !== null || ATTENTION_CONNECTIONS.has(i.connection_status),
  );
  if (troubled.length > 0) {
    return {
      state: "atencao",
      summary: `${troubled.length} vínculo(s) com problema (${troubled.map((t) => t.provider).join(", ")}). Veja a tabela de saúde abaixo.`,
    };
  }
  return { state: "concluida", summary: "Nenhum problema sinalizado pelos vínculos configurados." };
}
