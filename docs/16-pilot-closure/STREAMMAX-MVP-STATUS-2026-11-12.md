# StreamMax — estado atual do MVP (12/11/2026)

> **Snapshot de engenharia e evidências, não um certificado de release.**
> Código consultado: `main@7e273314d97da7fa415121eda8aacbba9f506132`.
> A consulta foi feita pelo GitHub, sem acesso direto ao runtime Contabo nesta revisão.
> Verificações de staging descritas abaixo são as últimas reportadas pelo operador/OpenCode; não foram repetidas aqui.
> Este arquivo atualiza a leitura do projeto sem apagar os relatórios históricos.

## Qual MVP estamos medindo?

- **`MVP_STREAMMAX_OPERATIONAL`:** operação interna single-tenant (cliente, pedido, PIX, assinatura, ativação manual supervisionada, renovação, suporte e recuperação). Requisitos e quatro gates em [01-product-and-mvp.md](../15-implementation-baseline/01-product-and-mvp.md).
- **`MVP-PILOT`:** escopo canônico mais amplo, com integrações certificadas, jornadas e demais capacidades obrigatórias. **Não declarado pronto.**
- **`MVP-SAAS`:** adiciona onboarding e cobrança de tenants externos, operação assistida e requisitos comerciais. **Não declarado pronto.**
- **`STREAMMAX_GOLDEN_LOOP_STAGING_READY` e `STREAMMAX_OPERATOR_UX_PASS`** são marcos **parciais**, não substituem nenhum desses gates. [DoD canônico](../15-implementation-baseline/15-definition-of-done.md).

## Evidências recentes

| Área | O que foi comprovado | Limite da evidência |
| --- | --- | --- |
| Venda → assinatura → fulfillment | PR [#128](https://github.com/Kusts/iptv/pull/128): scheduler automático e E2E sintético para pedido `SETTLED` → assinatura `PENDING_ACTIVATION` → operação do fornecedor, idempotência, reconciliação e isolamento. Staging reportado saudável em `main@c79160c`. | No staging, adapter `manual` manteve operação `HUMAN_REQUIRED`. Não comprova serviço ativado no fornecedor real. |
| Navegação do operador | PR [#129](https://github.com/Kusts/iptv/pull/129) mesclado; deploy de API/web no staging reportado em `main@b46cec7`. OpenCode reportou jornada autenticada desktop (1280×800) e mobile (390×844), com pedido, assinatura, fulfillment e operação `HUMAN_REQUIRED`; `STREAMMAX_OPERATOR_UX_PASS` registrado. | Evidência operacional reportada pela ponte; esta revisão não inspecionou screenshots nem repetiu sessão. |
| Renovação e suporte | Commit [`b6a06a8`](https://github.com/Kusts/iptv/commit/b6a06a8e688c6757b019e1e09d393bc866031696): correções em `/renewals`, suporte e shell responsivo. Registro da entrega informa web 277/277, integração de renovação 16/16 e tickets `RESOLVED` com tentativa `SUCCEEDED`; CI 4/4. | A prova de UI de renovação validou estado/diálogo; **não** comprovou no navegador uma nova renovação liquidada concluída ponta a ponta. A execução focada de integração expirou em 60 s; a execução completa levou ~1290 s. |
| Asaas | [E2E Sandbox de 04/11](../../evidence/pilot-asaas-e2e-20261104/report.md): PIX sintético, webhook, `SETTLED`/`PAID`/`CONFIRMED` sem duplicata. Control Center retornou `CONNECTED_READ_ONLY` em 07/11. | Não significa cobrança real, refund de produção ou certificação de todo o ciclo. |
| WhatsApp/WAHA | Código de sessões por tenant, QR e painel está na `main`. Commit [`7e273314`](https://github.com/Kusts/iptv/commit/7e273314d97da7fa415121eda8aacbba9f506132) registra mídia/transcrição/readback **software-verified** e teste isolado de read-model de conversas 9/9. | Certificação completa M1/M2 e operação do canal devem ser conferidas por capacidade; implementação não equivale a certificação live. |
| Sigma / CINEVISION | PR [#127](https://github.com/Kusts/iptv/pull/127) adicionou adapter M2M Sigma com chamadas simuladas, readback e tratamento de efeito desconhecido; PR #128 conectou o fluxo automático. Browser Worker na imagem da API pelo PR [#124](https://github.com/Kusts/iptv/pull/124). | `SIGMA_MODE=live`/token e contratação não habilitados nos últimos relatos; **ativação real e readback externo não comprovados**. Fallback manual continua esperado. |
| Segredos e recuperação | PR [#123](https://github.com/Kusts/iptv/pull/123): segredos em PostgreSQL com AES-256-GCM (migration 068); [SIMPLIFY-01](SIMPLIFY-01.md) registra descriptografia 4/4 e restore isolado em 07/11. | Não classificar o runtime atual como dependente de Infisical. Não inferir segurança operacional completa de um teste de restore. |
| Versão e implantação | A `main` avançou de `b46cec7` para `b6a06a8` e `7e273314` em 12/11. | A última **implantação staging comprovada nos relatos** era `b46cec7`; não há prova nesta revisão de deploy dos commits de 12/11. |

## Pendências objetivas para fechamento

1. **Renovação operacional E2E:** comprovar com dados **descartáveis** uma assinatura ativa → cotação → pedido de renovação liquidado por simulador → renovação → novo ciclo e validade preservada, mais ticket associado ao mesmo cliente. Reutilizar testes e Playwright existentes; não repetir suíte inteira sem motivo. A validação visual de suporte já reportada deve ser reaproveitada.
2. **Entrega do serviço:** o adapter Sigma existe, mas a ativação no fornecedor e readback independente seguem sem certificação. Manter `HUMAN_REQUIRED`/modo manual até autorização e recursos legítimos de teste. Não contratar ou executar operação externa automaticamente.
3. **Readiness do HEAD:** revalidar checks da `main@7e273314`; no instante desta auditoria, `build` estava em execução e os outros três jobs (`security-scans`, `adversarial`, `outbox-050-role-guards`) estavam verdes. Verificar qual revisão está realmente implantada antes de qualquer promoção.
4. **Backlog versus código:** issues [#86](https://github.com/Kusts/iptv/issues/86), [#87](https://github.com/Kusts/iptv/issues/87), [#88](https://github.com/Kusts/iptv/issues/88), [#89](https://github.com/Kusts/iptv/issues/89) continuam abertas apesar de implementações do hub e onboarding. Conferir cada critério com evidência antes de fechar ou reescrever; não criar tickets duplicados.
5. **Higiene documental/repo:** `RELEASE-CLOSURE-STATUS.md`/`RELEASE-CLOSURE-GAPS.md` são snapshots datados de outubro; o fechamento operacional de 03/11 e `SIMPLIFY-01` de 07/11 são históricos. Os arquivos `staging-compose-current.yml` e `staging-compose-target-6134a64.yml` foram adicionados à raiz em 12/11 (o segundo está vazio); avaliar se são artefatos temporários antes de qualquer limpeza. As issues [#44](https://github.com/Kusts/iptv/issues/44), [#51](https://github.com/Kusts/iptv/issues/51) e [#74](https://github.com/Kusts/iptv/issues/74) exigem triagem pelo código/evidência atual, sem assumir resolução nem bloqueio automático.

## Leitura dos gates (não é reclassificação formal)

- **`MVP_CODE_INTEGRATED`:** código evoluiu, mas o gate da **revisão mais nova** não pode ser promovido com base no smoke de um commit anterior.
- **`MVP_OPERATIONAL_SECURITY`:** há prova de migração de segredos, restore e reversão da autenticação temporária; a conformidade integral do gate atual não foi reatestada nesta auditoria.
- **`MVP_SERVICE_DELIVERY`:** sem ativação real de recurso de teste nem readback independente; **bloqueio externo permanece**.
- **`MVP_RENEWAL_AND_OPERATIONS`:** `PASS` controlado no fechamento de 03/11; testes adicionais e suporte visual em 12/11 ampliam evidência, mas a jornada completa de renovação no browser permanece sem prova.

**Veredito:** núcleo técnico operacional avançado; **`MVP_STREAMMAX_OPERATIONAL` ainda não encerrado**, `MVP-PILOT` e `MVP-SAAS` não promovidos. A próxima fatia menor é a prova operacional de renovação/suporte em PostgreSQL isolado, usando Docker remoto **somente com autorização** e removendo o recurso descartável ao final.

## Fontes e autoridade

- Contratos: [MVP canônico](../15-implementation-baseline/01-product-and-mvp.md), [Definition of Done](../15-implementation-baseline/15-definition-of-done.md), [capabilities por integração](../10-operations/integrations-capability-status.md).
- Histórico: [fechamento de 03/11](MVP-OPERATIONAL-CLOSURE.md), [simplificação](SIMPLIFY-01.md), [CHANGELOG](../../CHANGELOG.md), PRs/commits ligados acima.
- Este documento é **estado de evidência datado**, não ADR, não alteração automática de capability/runtime, nem autorização para deploy, pagamento ou ativação.
