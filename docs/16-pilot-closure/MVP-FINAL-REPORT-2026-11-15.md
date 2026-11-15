# Relatório final do MVP — 15/11/2026

## MVP operacional

Os quatro gates obrigatórios passaram: `MVP_CODE_INTEGRATED`,
`MVP_OPERATIONAL_SECURITY`, `MVP_SERVICE_DELIVERY` e
`MVP_RENEWAL_AND_OPERATIONS` (4/4 PASS). Staging está em `main@89b3f3a`.
Smoke de hoje: API health e readiness 200, `database=ok`; web 200 com
`frame-ancestors 'none'` e `X-Frame-Options: DENY`; registro público 403.

A ativação de serviço atestada foi manual e supervisionada. Não houve escrita
automatizada no fornecedor; a pós-condição na plataforma é declarada pelo
operador e o readback independente ocorreu no painel CINEVISION. Não há
certificação live das integrações. A jornada sintética usa evento Asaas Sandbox
simulado, sem pagamento externo real.

Testes de 15/11: 22 arquivos, 331 passed, 0 failed, sem PostgreSQL local
(API unit, browser-worker, outbox-worker e web). CI da main ficou verde para
PRs #142-#144 nos jobs build, adversarial, security-scans e
outbox-050-role-guards (ver [evidência de testes](INTEGRATIONS-HOMOLOGATION-2026-11-15.md#evidência-de-testes-1511)).

## MVP-PILOT

Software e evidências internas estão concluídos para o escopo documentado;
homologação live está parcialmente pronta, não concluída. Bloqueios externos:
Asaas exige acesso autorizado a contas A/B Sandbox e webhook; WAHA exige número
autorizado pareado; CINEVISION está `CHALLENGE_DETECTED`. Painel ainda requer
caminhada autenticada. Lacunas reais incluem evidência operacional de borda
(#44), E2E autenticado no navegador para a jornada e itens residuais de RLS
global/cutover (#7). Nenhuma lacuna é mascarada como homologação.

## MVP-SAAS

Reutilizáveis: tenancy/RLS/RBAC/audit, hub de integrações, billing core, ledger,
analytics e settings limitado a integrações/onboarding (sem Control Center/Platform Admin dedicado).
Não implementados: Platform Admin UI de ciclo de vida de tenant,
SaaS Plan/PlanVersion/PlatformSubscription,
billing/uso SaaS, onboarding/import/Go-Live, pricing comercial e
export/retention. Antes de clientes externos, esses componentes e suas
dependências de operação/comercial precisam ser definidos e entregues.

**Software pronto** significa implementação e testes observáveis. **Homologação
concluída** requer evidência do ambiente/provedor pertinente e permanece
pendente para integrações live. **Disponibilidade comercial** não é declarada:
o MVP operacional interno não equivale a SaaS pronto para clientes externos.

## Índice de evidências

- [Snapshot operacional 15/11](STREAMMAX-MVP-STATUS-2026-11-15.md)
- [Homologação das integrações](INTEGRATIONS-HOMOLOGATION-2026-11-15.md)
- [Ensaio sintético](PILOT-REHEARSAL-2026-11-15.md)
- [Triagem de backlog](BACKLOG-TRIAGE-2026-11-15.md)
- Runbooks: [primeira venda](../10-operations/runbooks/pilot-first-sale.md),
  [staging deploy](../10-operations/runbooks/staging-deploy.md),
  [integrações](../10-operations/runbooks/integrations-hub-operator.md).
