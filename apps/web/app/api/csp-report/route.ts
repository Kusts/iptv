// Endpoint local do CSP Report-Only (passo 1 do SCOPE-CSP-TTL).
//
// Recebe os JSONs de violação que o browser envia para o `report-uri`
// da política Report-Only. Não bloqueia nada: só registra (warn) e
// responde 204. Sem persistência — inventário de ruído fica como
// follow-up se o volume justificar.
//
// Endurecimento (FIX-CSP-REPORT-20261020, sem tocar a política):
// - Leitura limitada do stream (cap 8KB, aborta o excedente, sem confiar
//   em Content-Length) — corpo gigante é descartado sem carregar tudo.
// - Orçamento de logs (rate-limit em memória, N/min, drop silencioso).
// - Validação mínima de formato (JSON com `violated-directive` conhecido,
//   resto descartado) + log estruturado só de campos permitidos (sem
//   URLs/query integrais). Sem CSRF (reports nativos não enviam token),
//   sem persistência, sem mudar diretivas.

const MAX_BODY_BYTES = 8 * 1024;
const LOG_BUDGET_MAX = 10;
const LOG_BUDGET_WINDOW_MS = 60_000;
const MAX_DIRECTIVE_LEN = 64;

const DIRECTIVE_RE = /^[a-z][a-z-]*$/;

let logTimestamps: number[] = [];

/** Reset apenas para testes — não usar em runtime. */
export function __resetCspReportBudgetForTests(): void {
  logTimestamps = [];
}

function isAllowedToLog(now: number): boolean {
  logTimestamps = logTimestamps.filter((t) => now - t < LOG_BUDGET_WINDOW_MS);
  if (logTimestamps.length >= LOG_BUDGET_MAX) {
    return false;
  }
  logTimestamps.push(now);
  return true;
}

async function readCappedText(
  request: Request,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!request.body) {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > cap) {
      return { text: "", truncated: true };
    }
    return { text, truncated: false };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > cap) {
        await reader.cancel().catch(() => undefined);
        return { text: "", truncated: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, truncated: false };
  } catch {
    try {
      await reader.cancel().catch(() => undefined);
    } catch {
      // ignora — report nunca quebra navegação.
    }
    return { text: "", truncated: true };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function validDirective(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_DIRECTIVE_LEN) {
    return null;
  }
  if (!DIRECTIVE_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Extrai só os campos permitidos para log. Aceita o formato clássico
 * `{"csp-report": {...}}` e o corpo nu `{...}`; o resto é descartado.
 * Nunca retorna URLs — só nomes de diretiva.
 */
function extractLogFields(
  parsed: unknown,
): { violatedDirective: string; effectiveDirective?: string } | null {
  const root = asRecord(parsed);
  if (!root) {
    return null;
  }
  const nested = asRecord(root["csp-report"]);
  const report = nested ?? root;
  const violatedDirective = validDirective(report["violated-directive"]);
  if (!violatedDirective) {
    return null;
  }
  const effective = validDirective(report["effective-directive"]);
  return effective
    ? { violatedDirective, effectiveDirective: effective }
    : { violatedDirective };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { text, truncated } = await readCappedText(request, MAX_BODY_BYTES);
    if (truncated || text.length === 0) {
      return new Response(null, { status: 204 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(null, { status: 204 });
    }
    const fields = extractLogFields(parsed);
    if (!fields) {
      return new Response(null, { status: 204 });
    }
    if (!isAllowedToLog(Date.now())) {
      return new Response(null, { status: 204 });
    }
    console.warn("[csp-report]", JSON.stringify(fields));
  } catch {
    // Corpo ilegível: continua 204 — report nunca quebra navegação.
  }
  return new Response(null, { status: 204 });
}
