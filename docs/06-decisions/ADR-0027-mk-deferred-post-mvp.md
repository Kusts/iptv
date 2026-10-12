# ADR-0027 — MK Ativador diferido para pós-MVP

- **Status:** Accepted
- **Data:** 2026-10-12

## Context

A integração MK Ativador teve descoberta de integração nova ainda sem validação
live (fluxo de compra autenticado, canais web/Telegram, semântica de saldos e
efeito econômico real não observados). O MVP-PILOT precisa fechar sem ela:
o gate G07 segue BLOCKED (compra real em fornecedor MK nunca executada;
adapter echo/manual apenas) e o PR #55 mistura MK + CINEVISION no mesmo escopo,
o que impede fechar o piloto com fronteira limpa.

## Decision

- MK Ativador automático sai do MVP-PILOT e vai para pós-MVP.
- G07 é reclassificado como DEFERRED_POST_MVP (decisão do operador);
  no `tests/release/pilot-evidence.yaml` o status é `DEFERRED_POST_MVP`
  (enum estendido formalmente em `test_pilot_evidence.py`: exige
  `owner: operator` + `adr` + `unblock` com condição de reativação) —
  o diferimento é registrado via chaves `adr` + `deferral` na entrada G07.
- Fallback manual seguro continua permitido no piloto, somente com confirmação
  explícita do operador + auditoria (sem compra automática, sem efeito
  econômico silencioso).
- Abstrações de fornecedor são preservadas sem dependência direta de MK no
  domínio (MK segue atrás de port/adapter; nenhuma regra de domínio importa
  semântica MK).
- Pesquisa e validação live da integração MK são obrigatórias no pós-MVP
  antes de qualquer automação de compra.

## Consequences

- O piloto fecha sem compra automática MK; G07 não bloqueia o
  `READY FOR PRODUCTION — INTERNAL TENANT` (vira backlog pós-MVP rastreado).
- Nenhum adapter real MK é implementado nesta decisão; nenhuma chamada externa
  é executada.
- O SPEC `docs/04-specs/integrations/mk-ativador.md` fica com status
  `Deferred post-MVP`; seu conteúdo técnico é preservado como base da
  pesquisa pós-MVP.
- Risco residual: divergência entre snapshot de catálogo e comportamento live
  do fornecedor na reativação (preço, flags de ativação, canais de compra).

## Condição de reativação (pós-MVP)

1. Conta/termos do fornecedor regularizados (acesso autorizado + termos de uso).
2. Compra controlada de teste (valor mínimo, com aprovação/HITL e evidência).
3. Reconciliação de efeito desconhecido (unknown-effect reconciliado, sem
   segundo efeito).
4. Limites de gasto explícitos (teto por compra/período + ledger de saldo
   de fornecedor reconciliado).
