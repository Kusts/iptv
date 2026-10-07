# P1.1 — Inventário automático RLS (ponto de partida do programa)

> Status: executado 2026-10-07 contra banco descartável `iptv_rls_inventory`
> (migrations 001–051 aplicadas via psql, sem runner — ver nota abaixo).
> Evidência: `evidence/rls-inventory/20261007/` (`inventory.md`, `inventory.json`,
> `suggested-class.csv`). Gerador: `scripts/rls-inventory.sh` (heurística `P1.1-v1`).
> UNKNOWN é permitido nesta fase — é o ponto de partida; deve ser zero no cutover.

## Como rodar

```bash
DATABASE_URL=postgresql://... bash scripts/rls-inventory.sh [out-dir]
# ou: bash scripts/rls-inventory.sh <database-url> [out-dir]
```

- Precisa de `bash` + `psql` (no Windows: Git Bash ou WSL). Aponta para um
  banco **descartável** com as migrations aplicadas.
- Somente leitura: todas as instruções são `SELECT` / `COPY (SELECT …) TO STDOUT`
  (sem DDL/DML, sem `count(*)` em tabelas de usuário — só agregados de catálogo),
  com `default_transaction_read_only=on` como defesa em profundidade.
- Falha fechada sem `DATABASE_URL`, sem `psql` ou sem conectividade; nunca imprime
  a URL e nunca seleciona segredos; stderr do `psql` é capturado em arquivo
  privado (removido ao sair), nunca repassado ao terminal. Prova hermética
  (sem banco): `bash scripts/rls-inventory.sh --self-test`.
- Idempotente: reexecutar sobrescreve o mesmo diretório datado
  (`evidence/rls-inventory/<AAAA MM DD UTC>/` por default).
- Convenções: por tabela — schema, tabela, owner, `tenant_id` (s/n + nullability),
  RLS (s/n), policies (nome + comando + `USING`/`WITH CHECK` truncados em 180 chars),
  grants `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` para
  `iptv_app`/`outbox_worker`/`outbox_executor` (`ROLE ABSENT` se o papel não existir),
  índices cujo `indexdef` menciona `tenant_id`; mais seção de referências na app.

## Contagem atual (2026-10-07, 001–051)

- **schemas: 26** (25 com tabelas; `public` existe mas está vazio).
- **tabelas: 149**; **RLS-enabled: 21**; **`UNKNOWN`: 5**.
- Breakdown: `TENANT_SCOPED 123` · `GLOBAL 11` · `UNKNOWN 5` · `PRE_CONTEXT 4` ·
  `CROSS_TENANT_SYSTEM 4` · `AUDIT_ONLY 2`.

### Os 5 UNKNOWN (todo o trabalho de classificação restante começa aqui)

| Tabela | Regra | Nota para P1.2+ |
|---|---|---|
| `agent.agent_releases` | NO-TENANT-ID | sem `tenant_id`; ver se é catálogo global ou se falta a coluna |
| `partners.learning_content` | NO-TENANT-ID | idem (conteúdo academy pode ser global) |
| `partners.learning_content_versions` | NO-TENANT-ID | idem |
| `provider.providers` | NO-TENANT-ID | catálogo de providers; provável GLOBAL, a confirmar |
| `trial.app_profiles` | NULLABLE-TENANT-ID | único `tenant_id` nullable fora `feature_flags`/`policy_documents` |

Curiosidade registrada (não bloqueia): `agent.agent_releases` não tem coluna
`tenant_id` mas possui índice cujo `indexdef` a menciona
(`agent_releases_tenant_id_id_unique`) — checar a definição na slice do domínio `agent`.
Nota de snapshot: `platform.migration_history` (bookkeeping do runner
`applyMigrations`) não aparece porque este snapshot aplicou as migrations via
psql direto, sem o runner; a heurística já a allow-lista como GLOBAL quando presente.

### Referências na app (aproximação documentada)

Dois scans full-tree em `*.ts`/`*.tsx` (190 arquivos) nas raízes
`apps/api/src`, `apps/browser-worker/src`, `apps/outbox-worker/src`,
`apps/web/{app,lib,components}`: menções `schema.tabela` (precisas) + menções
whole-word do nome nu **só** para tabelas sem menção qualificada (limite superior,
não prova de uso — nomes como `orders` colidem com palavras comuns).
**128/149 tabelas** têm ≥1 menção; o detalhe por tabela está em `inventory.md`
§ Application references e em `inventory.json` (`app_refs`).

## Ordem de ataque (execução dinheiro-primeiro; P1.x é agrupamento)

Cutover global segue **BLOCKED** (runbook `rls-role-split-cutover.md`):
só `crm` + `communication` + `identity` + `control` têm grants/policies.

> A numeração P1.2–P1.6 abaixo é **agrupamento**, não sequência de execução.
> A ordem de execução é **dinheiro-primeiro**: **P1.3 (billing+finance Tier 0)
> antes de P1.2 (platform spine)**, depois P1.4 → P1.5 → P1.6
> (SPEC-PLAN-REVIEW R4: billing+finance primeiro).

| Slice | Grupo (schemas, tabelas) | Estado atual |
|---|---|---|
| P1.3 | **billing/finance Tier 0** (billing 8 + finance 4) | Zero grants/policies. `billing.tenant_channels` é PRE_CONTEXT (precisa do resolver 043-shaped no rollout) e `AsaasWebhookService.resolveChannel` ainda usa `SELECT` direto |
| P1.2 | **platform** (11: 4 CTS + 3 GLOBAL + 2 AUDIT_ONLY + 2 candidates) | Outbox publisher DB DONE (050/051). Pendente: decisão `inbox_messages`, loops do scheduler, provider dispatcher, enrollment de `idempotency_keys`/`inbox_messages`/`audit_log`/`domain_events` |
| P1.4 | **transacional** (subscription 5, commerce 3, catalog 8, inventory 12, trial 8, entitlement 2, provider 7, renewal 1 = 46) | 44 candidates `TENANT_SCOPED` unenrolled; 2 UNKNOWN (`provider.providers`, `trial.app_profiles`) |
| P1.5 | **operacional** (support 7, knowledge 9, agent 6, referral 4, loyalty 4, growth 7, partners 11 = 48, mais crm 3 + communication 10 + identity 3 + control 10 já enrolados = 74) | Enrolados: crm/communication/identity + memberships PRE_CONTEXT com resolvers 049. Restante: 3 UNKNOWN (`agent.agent_releases`, `partners.learning_content{,_versions}`) + candidates |
| P1.6 | **analítico** (analytics 2, experiments 3, security 1 = 6) | 6 candidates unenrolled, sem UNKNOWN |

Por slice, o contrato continua: inventário do domínio → grants + policies
(migration append-only) → prova SQL (`db/tests/0NN`) → rehearsal via caminho real
da app (isolamento A/B, fail-closed, escrita cross-tenant bloqueada, owner bypass).
Re-rodar este inventário a cada slice mantém o `UNKNOWN → 0` auditável até o cutover.

## Follow-ups P1-exit/cutover (registrados, não-bloqueantes P1.3)

- **Webhook completo sob `iptv_app`** (gate P1-exit): bus escreve `domain_events`/`outbox_messages`/`audit_log`, e a 050 proíbe `iptv_app`→outbox. Direção (ARCH-P13 Q2): funções produtoras estreitas `SECURITY DEFINER` (só `PENDING`, tenant/contexto validados, `search_path` fixo, `PUBLIC` revogado) com executor não-login dedicado, via nova migration append-only — sem tocar 050/051.
- **TOCTOU resolve→uso (Asaas)** (ARCH-P13 Q3): revalidar canal/`ACTIVE`/hash na mesma transação do insert inbox, com lock que conflite com disable/rotate; definir linearização (revogação confirmada antes do aceite impede ingresso). Slice de ingresso/inbox do platform spine.
- **Leitores sem contexto (sweep P1.3):** `analytics.controller.ts:308-313,424-430`, `finance.controller.ts:131-140,252-274,521-536` (wrap por-tenant), `scheduler.service.ts:302-311` (cross-tenant intencional: loop por tenant com contexto ou função definer).
- **Residuais P1.4 (sweep REVIEWER-P14, todos P1-exit):** `provider.controller.ts:200-228` e `human-review.controller.ts:304-329` leem `provider_operations` sem contexto (filas vazias sob `iptv_app`); scheduler/admin cobertos via funções; pairing explícito de parceiros (follow-up aceito em P1.2).
