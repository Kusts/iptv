# STREAMMAX-SIMPLIFY-01 — Registro da simplificação

Registro curto da entrega de simplificação (não é uma auditoria). Contrato
canônico continua em `docs/15-implementation-baseline/`.

## Estado

- PR #123 — `feat/simplify-01-secrets-postgres`.
- Correção de compatibilidade: commits `35eb6d6` (código/testes) e `dcd5833`
  (teste de tamper determinístico, sem mudança de produto).
- Engenharia encerrada: testes focados, `pnpm lint`, `pnpm typecheck`,
  `pnpm build`, gates Python e review independente concluídos; CI do PR verde
  em `dcd5833` (build, adversarial, security-scans, outbox-050-role-guards).
- Cutover de staging: `CUTOVER_PENDING_OPERATOR` (nenhum deploy, merge ou
  migração de produção executado).

## O que mudou

- **Segredos de integração**: saíram do Infisical para PostgreSQL cifrado com
  AES-256-GCM (`platform.secret_values`, migration 068). Uma linha por
  `(tenant_id, secret_ref)`; a chave de 256 bits fica só no ambiente da API
  (`SECRETS_ENCRYPTION_KEY`) e é guardada separadamente do dump do banco.
  As respostas/eventos/auditoria continuam sem valor de segredo e sem
  `secret_ref`; o isolamento por tenant/provider/ambiente é preservado.
- **CINEVISION/Browser Worker**: o worker não lê cofre nem banco. O painel é a
  `CINEVISION_ALLOWED_ORIGIN` (não é segredo) e `CINEVISION_EMAIL` +
  `CINEVISION_PASSWORD` chegam por invocação (a API os resolve do banco e os
  passa no spawn). Sessões, perfis, recuperação e leitura continuam iguais.
- **Workflows**: Hatchet não faz parte do runtime padrão do MVP. O port de
  workflow permanece em processo (não durável) e o processamento durável do MVP
  é o outbox worker dedicado.
- **Compose de staging**: serviços permanentes `postgres`, `api`, `web`,
  `tunnel` e `outbox-worker`; `migrate` continua one-shot; `browser-worker`
  continua disponível por perfil, sob demanda. PgBouncer permanece desativado.
- **Configuração**: `INFISICAL_*` e `BROWSER_INFISICAL_*` saíram; entrou
  `SECRETS_ENCRYPTION_KEY`. Flags de drenagem legada continuam apenas como
  rollback documentado.

## Correção de compatibilidade (referências legadas)

**Causa.** A migração preserva `provider.provider_accounts.secret_ref` e grava
cada credencial pelo ref EXATO — incluindo as secundárias
(`CINEVISION_PASS`, `ASAAS_WEBHOOK_TOKEN`) sob o mesmo esquema legado
`infisical://SANDBOX/integrations/<tenant>/<provider>/<KEY>`. O código derivava
essas secundárias sempre com `buildIntegrationSecretRef` (`pgsecret://`), então
a leitura por ref exato falhava em um binding legado: CINEVISION encontrava o
usuário e não a senha (`TESTING/INVALID_CREDENTIALS`); o `webhook_ensure` do
Asaas não encontrava o token migrado e gerava outro.

**Correção.** `deriveIntegrationSecretRef(bindingRef, key)`
(`packages/secrets/src/refs.ts`) deriva a chave secundária do ref PRINCIPAL,
preservando esquema, ambiente e prefixo exatos; o escopo vem sempre do binding
validado, nunca do chamador. A escrita usa o próprio ref derivado (parseado de
volta para o alvo), então leitura e escrita nunca divergem — inclusive quando o
ref legado grafa o ambiente de forma diferente da coluna. `putSecret` aceita
`refScheme` somente para `pgsecret://`/`infisical://`, mantendo allowlist de
provider, validação de tenant e AAD; `rotateSecret` repassa o esquema. O default
de configurações novas continua `pgsecret://`. Nenhum fallback entre tenants,
providers ou ambientes foi introduzido.

**Arquivos.**

- `packages/secrets/src/refs.ts`, `index.ts`, `postgres-adapter.ts`,
  `types.ts`, `writer.ts`.
- `apps/api/src/integrations/integrations.commands.ts`.
- Testes: `packages/secrets/test/refs.unit.test.ts`,
  `packages/secrets/test/postgres-adapter.unit.test.ts`,
  `apps/api/test/integrations-legacy-refs.integration.test.ts`,
  `packages/database/test/migrate-secrets-to-postgres.integration.test.ts`.

## Cutover de credenciais — procedimento único (staging Contabo)

Status: `CUTOVER_PENDING_OPERATOR`. Executar apenas com autorização explícita
para o ambiente e o SHA.

### Pré-requisitos

- Backup atual do PostgreSQL e verificação de integridade.
- `SECRETS_ENCRYPTION_KEY` (32 bytes, base64) gerada e guardada fora do banco.
- Cópia de recuperação da chave em custódia separada.
- Identidade Infisical antiga temporariamente disponível para leitura.
- Plano de rollback e inventário do estado atual das integrações.

### Ordem operacional

1. Confirmar o SHA autorizado.
2. Executar o backup e verificar a integridade.
3. Aplicar a migration 068 (one-shot `migrate`).
4. Rodar o inventário/dry-run:
   `node packages/database/scripts/migrate-secrets-to-postgres.mjs`.
5. Se existirem bindings legados, executar o `--apply` autorizado.
6. Confirmar todos os read-backs do script (ele falha com exit 1 e não promove o
   cutover se qualquer leitura/decrypt falhar).
7. Implantar API e componentes atualizados com a chave no ambiente.
8. Validar Asaas Sandbox sem criar cobrança (teste read-only no Control Center).
9. Validar CINEVISION via Browser Worker somente leitura autorizada.
10. Confirmar persistência após reinício do processo.
11. Confirmar outbox worker único e saudável.
12. Executar restore isolado do backup e validar a descriptografia das
    credenciais com a chave.
13. Registrar o resultado (sem valores de segredo).

Se não houver bindings legados, não forçar `--apply`: testar uma configuração
nova pelo Control Center. Não reiniciar nem recriar o volume PostgreSQL; não
executar cobrança real nem operação CINEVISION de escrita. O `--overwrite` não
faz parte da operação padrão.

### Rollback

- Não excluir o banco e não sobrescrever segredos já migrados.
- Não usar `--overwrite` automaticamente.
- Preservar o Infisical e seus backups.
- Restaurar a versão anterior pelo procedimento validado.
- Preservar a chave de criptografia nova e os dados já cifrados para
  recuperação; não fazer downgrade de schema presumindo migrations reversíveis.

## Antes → depois

| Item | Antes | Depois |
| --- | --- | --- |
| Serviços no compose de staging | 8 (postgres, migrate, api, web, tunnel, browser-worker, outbox-worker, pgbouncer — os 3 últimos por profile) | 7 (postgres, api, web, tunnel e outbox-worker permanentes; migrate one-shot; browser-worker sob demanda) |
| Cofre de segredos | Infisical externo + identidades de máquina | PostgreSQL ciphertext (`platform.secret_values`) + `SECRETS_ENCRYPTION_KEY` |
| Workflow durável | Hatchet opcional (SDK/config) | Outbox worker dedicado; port de workflow só não-durável |
| Env removidas | `INFISICAL_SITE_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_ENVIRONMENT`, `BROWSER_INFISICAL_SITE_URL`, `BROWSER_INFISICAL_PROJECT_ID`, `BROWSER_INFISICAL_CLIENT_ID`, `BROWSER_INFISICAL_CLIENT_SECRET`, `HATCHET_API_TOKEN`, `HATCHET_SERVER_URL` | — |
| Env adicionada | — | `SECRETS_ENCRYPTION_KEY` |

## Testes que sustentam a entrega

- `packages/secrets`: 27/27 (criptografia, adapter, refs/derivação, esquema
  legado de escrita/rotação).
- `apps/api` — suítes de integração afetadas 55/55:
  `integrations-legacy-refs` (A: CINEVISION legado com usuário+senha; B: token
  de webhook Asaas migrado reutilizado; B2: binding legado com ambiente em
  caixa diferente gera um token e o reutiliza; C: configuração nova em
  `pgsecret://` cifrada e legível; D: isolamento tenant/ambiente sem vazamento),
  `integrations-webhook-ensure`, `integrations-cinevision-validate`,
  `integrations-write`, `secrets-postgres`.
- `packages/database` — script de migração 4/4 contra PostgreSQL real e
  Infisical fake: dry-run sem escrita; refs legados exatos (primárias e
  secundárias); nenhum overwrite por padrão; read-back de descriptografia;
  falha de leitura → exit 1 (cutover bloqueado); nenhum valor no stdout/stderr;
  nenhuma escrita/exclusão enviada ao cofre.
- `pnpm lint`, `pnpm typecheck` e `pnpm build` verdes; `gitleaks protect
  --staged` sem leaks; gates Python (`validate_docs`, contratos e seed) verdes.
- CI do PR #123 verde em `dcd5833` (lint/typecheck/test/build no job `build`,
  mais `adversarial`, `security-scans` e `outbox-050-role-guards`).

## Fora de escopo / pendências externas

- Validação live em staging (deploy, cutover real, Asaas/CINEVISION) exige
  autorização do ambiente e não é feita por este registro:
  `CUTOVER_PENDING_OPERATOR`.
- A identidade Infisical antiga pode ser removida do runtime somente depois do
  cutover validado; o cofre e seus backups não são apagados por esta entrega.
- Funcionalidades SaaS (onboarding comercial, white-label, copilot completo)
  permanecem no roadmap; nada foi removido do banco/RLS.
