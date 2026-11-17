# Catálogo comercial aprovado — StreamMax V1

| Campo | Valor |
|---|---|
| Status | **approved** |
| Aprovador | Proprietário do StreamMax |
| Data da aprovação | 17/11/2026 |
| Versão | V1.0 |
| Escopo | StreamMax V1 (operação própria) |

## Decisão aprovada

Estes são os preços e condições oficiais vigentes, aprovados pelo proprietário. Seeds sintéticos não são catálogo comercial. A fonte operacional é `catalog.*` no banco por tenant.

## Planos

| Plano | Periodicidade | Preço | Moeda | Status | Observação |
|---|---:|---:|---|---|---|
| Mensal | 1 mês | R$ 30,00 | BRL | approved | — |
| Trimestral | 3 meses | R$ 75,00 | BRL | approved | — |
| Semestral | 6 meses | R$ 150,00 | BRL | approved | — |
| Anual | 12 meses | R$ 300,00 | BRL | approved | — |

## Telas adicionais (addon)

Existe um único produto addon de tela adicional, com preço definido pela periodicidade escolhida:

| Periodicidade | Preço por tela adicional | Preço em centavos |
|---:|---:|---:|
| 1 mês | R$ 20,00 | 2000 |
| 3 meses | R$ 60,00 | 6000 |
| 6 meses | R$ 100,00 | 10000 |
| 12 meses | R$ 150,00 | 15000 |

Regra de cálculo: `total = preço do plano + (quantidade de telas adicionais × preço da tela na periodicidade escolhida)`.

Exemplos:

- Mensal + 1 tela = R$ 50,00.
- Trimestral + 2 telas = R$ 75 + 2×60 = R$ 195,00.
- Anual + 1 tela = R$ 450,00.

Preços dos planos em centavos: mensal 3000; trimestral 7500; semestral 15000; anual 30000.

## Teste (trial)

O teste é gratuito, dura 6 horas e pode ser concedido **1 vez por usuário**. Nova tentativa somente é permitida como exceção quando houver problema técnico comprovado que impossibilitou o teste; o registro da exceção deve ser auditável.

## Renovação

A renovação é efetivada após confirmação do pagamento. Em 17/11/2026, o proprietário aprovou a opção B: desconto fixo de R$ 5,00 (500 centavos) por pedido de renovação antecipada, aplicado ao total (plano + telas adicionais). Exemplos: mensal R$ 30 + 1 tela R$ 20 − R$ 5 = R$ 45 (4500 centavos); trimestral R$ 75 + 2 telas R$ 60 − R$ 5 = R$ 190 (19000); mensal sem tela − R$ 5 = R$ 25 (2500).

A elegibilidade é decidida pelo backend via `decideRenewalQuote(...).early` (`renewal-policy.ts:72-90`), com `now()` do servidor e `cycleEnd` do ciclo persistido sob transação/lock. `early:true` exige `early_allowed=true` na política `subscription.renewal` e mais de `window_days` (7 por padrão) até o vencimento, mantendo margem verificável até a confirmação. `early:false` (dentro da janela) não recebe desconto. Com `early_allowed=false` (padrão), nenhum desconto é concedido automaticamente. Flags do cliente/bot não comprovam elegibilidade.

Não se aplica à primeira contratação (`NEW_SUBSCRIPTION`) e não é cumulativo por reprocessamento: a ordem reutilizada via `renewal_order_id` retorna `already:true`. Implementado em `approved-catalog.ts` (`earlyRenewalDiscountMinor`, constante 500, `applyEarlyRenewalDiscount`), `renewal.commands.ts:228` e `renewal-store.ts`, que persiste `discount_amount_minor`, `net_amount_minor`, `discount_minor`/`net_minor` no item e `early_discount_minor`/`eligibility` em `context_json`.

## Histórico de versões

| Versão | Data | Aprovador | Alteração |
|---|---|---|---|
| V1.0 | 17/11/2026 | Proprietário do StreamMax | Aprovação dos planos, addon, teste, renovação e desconto antecipado opção B; aprovado e implementado |

## Relação com a implementação

- [Plano unificado StreamMax V1](STREAMMAX-V1-PLANO-UNIFICADO.md)
- [Planejamento M0-M1](STREAMMAX-V1-M0-M1-PLANEJAMENTO.md)
- [README dos seeds](../../db/seeds/README.md) — seeds são sintéticos, não definem o catálogo aprovado.
- [Consultas do catálogo na API](../../apps/api/src/commerce/catalog-queries.ts) — fonte operacional.

A carga dos valores aprovados em `catalog.*` deve ser feita por script idempotente e auditável, sem cobrança ou ativação. Valores e condições não listados aqui são **não aprovados** ou **fora da V1**.

A gravação no catálogo operacional real, deploy e M5 permanecem fora do escopo. A exposição dos preços dos adicionais na API/bot é uma pendência funcional.
