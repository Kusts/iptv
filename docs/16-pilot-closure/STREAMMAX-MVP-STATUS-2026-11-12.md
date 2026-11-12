# StreamMax — estado do MVP (12/11/2026)

> **Snapshot de engenharia e evidências; não é certificado de release.** Código
> consultado: `main@7d27472`. A inspeção do staging foi somente leitura;
> o checkout observado permanece detached e sujo. Esta atualização não fez
> deploy nem alterou dados, credenciais ou serviços.

## Escopo

- **`MVP_STREAMMAX_OPERATIONAL`:** operação interna single-tenant de cliente,
  pedido, cobrança, assinatura, ativação manual supervisionada, renovação,
  suporte e recuperação. Os critérios e quatro gates estão no
  [baseline](../15-implementation-baseline/01-product-and-mvp.md).
- **`MVP-PILOT`** e **`MVP-SAAS`** permanecem escopos distintos e não são declarados
  prontos. `STREAMMAX_GOLDEN_LOOP_STAGING_READY` e
  `STREAMMAX_OPERATOR_UX_PASS` são marcos parciais; não substituem gates.

## Evidências atuais e limites

| Área | Evidência observada | Limite |
| --- | --- | --- |
| Main, CI e issue #131 | `main@7d27472`; CI [run 43233580447](https://github.com/Kusts/iptv/actions/runs/43233580447) verde nos quatro checks: `build`, `adversarial`, `security-scans` e `outbox-050-role-guards`. Issue [#131](https://github.com/Kusts/iptv/issues/131) fechada após alinhar a expectativa do teste a `validation_failed`, mantendo a validação estrita de `externalRef`. | CI verde valida esse HEAD e seus checks, não certifica o MVP ou os gates operacionais. A execução local focada de integração expirou por timeout; isso é inconclusivo, não falha de código. |
| Staging Contabo | Leitura somente em `/home/deploy/iptv-staging`: checkout detached em `b46cec7`, com alterações locais em Compose, marcador, backups e um arquivo de teste. API health/ready `200`, web `200`, histórico de migrations `69/69` até `069`; uma operação de provedor `HUMAN_REQUIRED`; outbox `WORKER`, geração `3`. `SIGMA_MODE` não está live. O delta `b46cec7..7d27472` não contém migrations. | O estado local sujo foi preservado e não recebeu deploy. Health, readiness e migrations não comprovam jornada autenticada de renovação, ativação/readback do provedor nem certificação live. |
| Venda, assinatura e fulfillment | PR [#128](https://github.com/Kusts/iptv/pull/128) adicionou o ciclo sintético automatizado, idempotência, reconciliação e isolamento; o registro de staging mantém a operação manual em `HUMAN_REQUIRED`. | Não comprova serviço ativado no provedor real. |
| UX do operador | PR [#129](https://github.com/Kusts/iptv/pull/129) e relato de staging em `b46cec7` registram navegação autenticada de pedido, assinatura, fulfillment e operação manual. | É evidência reportada de UX; não comprova renewal E2E autenticado no navegador. |
| Renovação e suporte | A entrega de `b6a06a8` registrou web `277/277`, integração de renovação `16/16` na execução completa e tickets `RESOLVED` com tentativa `SUCCEEDED`. | A execução focada expirou por timeout local. Não há evidência de uma nova renovação autenticada e liquidada ponta a ponta no navegador. |
| Asaas | [E2E Sandbox de 04/11](../../evidence/pilot-asaas-e2e-20261104/report.md) registrou PIX sintético, webhook e estados `SETTLED/PAID/CONFIRMED` sem duplicata; Control Center informou `CONNECTED_READ_ONLY` em 07/11. | Evidência Sandbox histórica; não comprova cobrança real, refund de produção nem certificação do ciclo completo. |
| WhatsApp/WAHA | A `main` inclui sessões por tenant e os recursos de mídia, transcrição e readback software-verified registrados em `7e273314`. | Implementação/teste de software não equivalem à certificação live M1/M2 ou operação atual do canal. |
| Sigma / CINEVISION | PR [#127](https://github.com/Kusts/iptv/pull/127) adicionou adapter Sigma com chamadas simuladas; PR [#124](https://github.com/Kusts/iptv/pull/124) incluiu CLI/Chromium no runtime da API. | `SIGMA_MODE` não está live. Não foram comprovadas ativação de serviço no provedor nem leitura independente posterior. |
| Segredos e recuperação | PR [#123](https://github.com/Kusts/iptv/pull/123) e migration `068` implementaram segredos em PostgreSQL cifrados com AES-256-GCM; veja [SIMPLIFY-01](SIMPLIFY-01.md). | O baseline mantém backup externo PostgreSQL cifrado/verificável, chave de backup independente, restore isolado, leitura sintética e custódia separada de `SECRETS_ENCRYPTION_KEY` e `BETTER_AUTH_SECRET`. A mudança de cofre não remove os critérios de segurança e recuperação nem, por si só, prova o gate operacional atual. |

## Status dos quatro gates

Os estados abaixo são preservados conforme o registro de fechamento de 03/11;
esta atualização não promove nem reclassifica gates. Evidências de CI e smoke
não substituem os critérios completos do [baseline](../15-implementation-baseline/01-product-and-mvp.md).

| Gate | Status preservado | Leitura desta atualização |
| --- | --- | --- |
| `MVP_CODE_INTEGRATED` | `BLOCKED_EXTERNAL` | CI da main está verde, mas o staging continua em checkout detached/sujo de `b46cec7`; não foi alinhado nem recebeu o HEAD atual. |
| `MVP_OPERATIONAL_SECURITY` | `BLOCKED_EXTERNAL` | PR #123 corrige o armazenamento de segredos; a evidência desta revisão não reatesta o processo completo de segurança e recuperação exigido. |
| `MVP_SERVICE_DELIVERY` | `BLOCKED_EXTERNAL` | A única operação observada no staging continua `HUMAN_REQUIRED`; sem ativação real e readback independente. |
| `MVP_RENEWAL_AND_OPERATIONS` | `PASS` | Status do fechamento controlado de 03/11 mantido. Isso não afirma renewal E2E autenticado no navegador nesta revisão. |

## Pendências de evidência

1. Comprovar renewal E2E autenticado com dados descartáveis: assinatura ativa,
   pedido de renovação liquidado por simulador, novo ciclo/validade sem
   duplicata e suporte associado ao mesmo cliente.
2. Manter ativação manual supervisionada até haver autorização e recurso de
   teste legítimo para ativação Sigma/CINEVISION e readback independente.
3. Preservar o checkout staging sujo; qualquer atualização futura deve partir
   de revisão explícita do estado e respeitar o procedimento de deploy autorizado.
4. Triar backlog e artefatos temporários com evidência atual, sem inferir
   resolução ou remover arquivos a partir deste snapshot.

**Veredito:** o núcleo técnico evoluiu e o CI da `main@7d27472` está verde, mas
`MVP_STREAMMAX_OPERATIONAL` não está encerrado; `MVP-PILOT` e `MVP-SAAS` não foram
promovidos. Não há aqui claim de renewal E2E autenticado, ativação/readback de
provedor ou certificação live.

## Fontes e autoridade

- Critérios: [MVP canônico](../15-implementation-baseline/01-product-and-mvp.md), [Definition of Done](../15-implementation-baseline/15-definition-of-done.md) e [capabilities por integração](../10-operations/integrations-capability-status.md).
- Histórico: [fechamento de 03/11](MVP-OPERATIONAL-CLOSURE.md), [simplificação](SIMPLIFY-01.md), [CHANGELOG](../../CHANGELOG.md), PRs/commits e run vinculados acima.
- Este é um snapshot datado de evidência, não ADR, alteração automática de capability/runtime ou autorização para deploy, pagamento ou ativação.
