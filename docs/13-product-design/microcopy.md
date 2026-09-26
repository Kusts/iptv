# Product Microcopy Baseline

> Status: Canonical baseline
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — terms aligned with Glossary and state machines.

## Canonical labels

- `Trial` → **Teste** in customer-facing pt-BR, **Trial** in admin/domain technical views when needed.
- `Retrial` → **Novo teste por exceção** customer-facing; **Retrial** admin/domain.
- `SETTLED` → **Pedido liquidado**.
- `PAID` → **Pagamento confirmado**.
- `SUCCEEDED` provider op → **Operação verificada**.
- `HUMAN_REQUIRED` → **Revisão humana necessária**.
- `DEGRADED` → **Operação degradada**.

## Confirmation pattern

Before destructive/high-risk action:

> Você está prestes a [action]. Isso afetará [scope]. O sistema registrará a alteração e tentará verificar o resultado no provider.

## Unknown external effect

> A operação pode ter sido aplicada externamente, mas ainda não foi possível confirmar. Não tente novamente até a verificação concluir.

## Empty states

Explain what the area is for and the next useful action. Do not use decorative empty-state copy only.

## Error messages

Include:

1. what failed;
2. whether data/action may already have changed;
3. what happens next;
4. correlation/reference ID for support when relevant.
