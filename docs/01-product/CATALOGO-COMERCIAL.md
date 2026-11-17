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

A renovação é efetivada após confirmação do pagamento. Há desconto aprovado de R$ 5,00 para pagamento antecipado, mas a base de cálculo está **PENDENTE de definição**:

- A: somente plano principal;
- B: plano + telas adicionais.

Este desconto não constitui regra executável até a definição da base de cálculo.

## Histórico de versões

| Versão | Data | Aprovador | Alteração |
|---|---|---|---|
| V1.0 | 17/11/2026 | Proprietário do StreamMax | Aprovação inicial dos planos, addon, teste e renovação; desconto antecipado pendente |

## Relação com a implementação

- [Plano unificado StreamMax V1](STREAMMAX-V1-PLANO-UNIFICADO.md)
- [Planejamento M0-M1](STREAMMAX-V1-M0-M1-PLANEJAMENTO.md)
- [README dos seeds](../../db/seeds/README.md) — seeds são sintéticos, não definem o catálogo aprovado.
- [Consultas do catálogo na API](../../apps/api/src/commerce/catalog-queries.ts) — fonte operacional.

A carga dos valores aprovados em `catalog.*` deve ser feita por script idempotente e auditável, sem cobrança ou ativação. Valores e condições não listados aqui são **não aprovados** ou **fora da V1**.
