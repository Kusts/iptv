# Admin Guide — Billing & Renewals

> Status: Draft baseline
> Versão: 0.14
> Data: 2026-09-20
> Review: Auto-reviewed v0.14 — reconcile against implemented UI before launch.

Treat Order, Charge, Payment, Subscription and Provider Fulfillment as distinct. A payment can be confirmed while fulfillment is still pending. An Order can be SETTLED with zero external payment when valid credits/rewards cover it. Recurring additional connections generate recurring customer charge/cost treatment every active cycle.

## Escalation rule

If the interface presents a state/action not explained by canonical Domain/SPEC/Policy, stop and report documentation drift rather than improvising.

## Refinamentos v0.14

PIX é default, cartão alternativa e boleto exceção. Não aceitar pagamento parcial externo arbitrário no MVP. Credits/rewards reduzem o valor antes de gerar cobrança. Renovação antecipada pode receber desconto configurável. Sempre confirmar plano/conexões atuais antes de Renewal Order. Refund exige Human Review.
