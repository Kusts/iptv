# Homologação das integrações — 2026-11-15

**Escopo:** evidências de software e staging para issues #86–#89; não certifica operação live. **Revisão implantada:** `main@89b3f3a`.

- **software-verified:** implementação e testes automatizados verdes; não equivale a homologação externa.
- **sandbox/live:** estados efetivamente observados no tenant de staging; nenhum teste de cobrança/live foi realizado nesta sessão.
- **fallback manual:** caminho operacional supervisionado quando a integração externa não permite automação.

## Matriz

| Issue | Implementação (arquivos-chave) | Testes executados hoje (suítes / contagem) | Staging real | Homologado em software | Falta para homologação live / pré-requisito externo |
|---|---|---|---|---|---|
| #86 Asaas | `apps/api/src/billing/asaas-port.ts`, `apps/api/src/integrations/integrations.commands.ts` | `asaas-hosts-parity`, `webhook-urls`, `tenant-runtime` (13); `integrations-hub` (parte dos 52 testes web de hubs) | `SANDBOX`, `CONNECTED_READ_ONLY/UNKNOWN`, conferido 2026-11-07 | isolamento/runtime, allowlist, leitura e UI derivada | conta A/B Sandbox acessível via painel, webhook autorizado, observar dedupe/replay, rotação/reconexão e evidência visual. Tenant atual segue `CONNECTED_READ_ONLY/UNKNOWN`. Pré-requisito: acesso autorizado ao painel e canal webhook do tenant. |
| #87 WhatsApp/WAHA | `apps/api/src/integrations/whatsapp-sessions.commands.ts`, `apps/api/src/integrations/waha-admin.port.ts` | `waha-media`, `waha-accept-collapse`, `waha-f05-f06` (60); `browser.test.ts` + `cinevisionCommand.test.ts` (49 browser-worker) | `SANDBOX`, `NOT_CONFIGURED/UNKNOWN` | sessão, mensagens/mídia e controles exercitados por testes com doubles | número autorizado pareado, estado `WORKING`, restart/reconnect e A/B de sessões. Pré-requisito: número e pareamento autorizados, acesso ao WAHA. Hoje `NOT_CONFIGURED`. |
| #88 CINEVISION | `apps/api/src/integrations/cinevision-worker-probe.ts`, `apps/api/src/provider/provider-cinevision-simulated.ts` | `cinevision-probe`, `provider-cinevision-simulated`, `provider-sigma` (62); browser-worker (49) | `PRODUCTION`, `TESTING/UNAVAILABLE`, `CHALLENGE_DETECTED`, última leitura 2026-11-08 | probe/simulação e fail-closed; entrega manual supervisionada já comprovada no MVP operacional (linha `214790811`) | leitura real bloqueada por `CHALLENGE_DETECTED`. Fallback manual supervisionado é vigente; nenhuma escrita automatizada. Pré-requisito live: operador autorizado e acesso legítimo sem challenge para leitura; qualquer ativação depende de procedimento supervisionado/autorizado. |
| #89 Painel | `apps/web/app/settings/integrations/page.tsx`, cards Asaas/WhatsApp/CINEVISION em `apps/web/app/settings/integrations/` | `integrations-hub`, `whatsapp-hub`, `cinevision-hub` (52) | backend `GET /v1/integrations` é fonte de status; sem estado `ACTIVE` otimista | testes de componente dos três cards verdes; UI deriva estado do backend | caminhada autenticada em navegador não executada nesta sessão; não há Playwright no repositório e framework não será adicionado. Operador: entrar como owner autorizado, abrir integrações, conferir os três estados com `GET /v1/integrations` e detalhes, registrar evidência e confirmar ausência de status otimista. Pré-requisito: credencial de owner do tenant. |

## Evidência de testes 15/11

22 arquivos, **331 testes passed, 0 failed**, sem PostgreSQL local.

| Suíte | Contagem |
|---|---:|
| API `security-headers.test.ts` | 2 |
| API `auth-ratelimit.unit.test.ts` + `admin-ratelimit.unit.test.ts` | 47 |
| API `asaas-hosts-parity` + `webhook-urls` + `tenant-runtime`.unit | 13 |
| API `cinevision-probe` + `provider-cinevision-simulated` + `provider-sigma`.unit | 62 |
| API `waha-media` + `waha-accept-collapse` + `waha-f05-f06`.unit | 60 |
| browser-worker `browser.test.ts` + `cinevisionCommand.test.ts` | 49 |
| outbox-worker `worker.test.ts` | 16 |
| web `frame-policy` + `csp-nonce` | 16 |
| web `integrations-hub` + `whatsapp-hub` + `cinevision-hub` | 52 |
| web `orders` + `billing` | 14 |
| **Total** | **331** |

## Limites

Nada aqui certifica live nem autoriza cobranças, webhooks, pareamento ou ativação externa. Não promover `MVP-PILOT`: software-verified e evidência sandbox/live permanecem distintos; cumprir pré-requisitos e obter evidências externas antes de qualquer promoção.
