# Auto-Review Report — Documentation v0.5

> Data: 2026-09-20  
> Resultado: PASS

## Escopo revisado

Arquivos novos/alterados da v0.5:

- Technology Decision Matrix;
- Threat Model;
- Data Classification;
- Privacy & Data Lifecycle;
- Logical Data Model;
- OpenAPI MVP;
- AsyncAPI MVP;
- ADR-0010 a ADR-0014;
- Technology Research Snapshot;
- Glossary/State Machine corrections;
- README/indices.

## Checks automáticos

| Check | Resultado |
|---|---:|
| Links Markdown internos | PASS |
| OpenAPI YAML parse | PASS |
| OpenAPI `$ref` locais | 90/90 válidos |
| AsyncAPI YAML parse | PASS |
| AsyncAPI channels no Event Model | 18/18 |
| Canonical domain events detectados | 222 |
| Event refs em docs | 226 |
| Analytics-only allowlist | 4 intencionais |
| Order states API × Domain | PASS |
| Payment states API × Domain | PASS |
| Subscription states API × Domain | PASS |
| ProviderOperation states API × Domain | PASS |
| README version | 0.5 |

## Correções realizadas durante a auto-revisão

1. OpenAPI usava nomes de state simplificados diferentes das state machines. Corrigido para vocabulário canônico.
2. `ProviderOperation SUCCESS` residual foi corrigido para `SUCCEEDED`.
3. Glossary ainda citava `trial.passed`; corrigido para `trial.technical_passed.v1`.
4. ER conceptual dizia `Order paid_by Payment`; alterado para relação neutra `has`, pois uma Order pode ser settled sem Payment externo.
5. Webhooks no OpenAPI receberam explicação explícita de que `security: []` remove somente Bearer da plataforma; autenticação específica do provider continua obrigatória.
6. Novos termos de segurança/reliability foram integrados alfabeticamente ao Glossary.

## Revisão semântica

Confirmado:

- conexão/tela adicional continua modelada como add-on **recorrente**;
- custo do provider da conexão adicional é **recorrente por ciclo aplicável**;
- um Trial válido por Person continua regra padrão;
- Retrial continua exceção rastreada;
- Order utiliza `SETTLED`, não `PAID`;
- Payment e Order permanecem conceitos separados;
- Browser Worker não é fonte da verdade;
- external webhook não altera estado canônico diretamente;
- financial ledger permanece append-only/reversal-based;
- tenant scope existe em data-plane e operações assíncronas;
- external knowledge permanece untrusted até validação.

## Itens ainda Proposed — não tratados como decisão final

- Modular Monolith first;
- TypeScript/NestJS/Fastify baseline;
- Kysely;
- Inngest;
- Playwright;
- Infisical;
- Neon managed vs PostgreSQL self-hosted;
- Auth provider.

Esses itens devem passar pelos spikes definidos nos ADRs/SPECs antes de promoção a `Accepted` quando necessário.
