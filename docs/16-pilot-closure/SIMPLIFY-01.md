# STREAMMAX-SIMPLIFY-01 — Registro da simplificação

Registro curto da entrega de simplificação (não é uma auditoria). Contrato
canônico continua em `docs/15-implementation-baseline/`.

## Estado

- PR #123 — `feat/simplify-01-secrets-postgres`, **merged** em `main` pelo merge
  commit `e5ad924` (base `f634126`).
- HEAD aprovado nos testes: `ece76e38201f6e21e00abaa68ca38a1b4225fb0b`.
- CI do PR (`run 42399295814`) e CI de `main` (`run 42403430079`) **verdes** nos
  quatro checks obrigatórios: `build`, `outbox-050-role-guards`,
  `security-scans`, `adversarial`.
- Staging Contabo (`/home/deploy/iptv-staging`): **`main@e5ad924`** implantado,
  cinco serviços saudáveis (postgres, api, web, tunnel, outbox-worker), Browser
  Worker disponível por profile, **sem Infisical no runtime**.
- Cutover executado em 2026-11-07 com autorização explícita do operador; backup
  pré/pós-cutover e restore isolado verificados.
- Pendência externa: leitura live **CINEVISION**. As credenciais foram
  configuradas pelo Control Center e estão cifradas/decifráveis (4/4), mas a
  leitura no provedor retorna `PROVIDER_UNAVAILABLE` porque a imagem da API não
  inclui o CLI do browser-worker e não há binário de navegador. É limitação de
  runtime, não falha de criptografia.

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

Status: `CUTOVER_EXECUTED` em 2026-11-07 (staging Contabo, `main@e5ad924`).
A ordem abaixo foi cumprida; resultados em "Cutover executado".

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

- A leitura live **CINEVISION** segue pendente: o binding existe (`TESTING`,
  `PRODUCTION`) e as 2 credenciais estão cifradas/decifráveis, mas a API não
  acha o CLI `browser-worker/dist/cli.js` na própria imagem e não há navegador,
  resultando em `PROVIDER_UNAVAILABLE`. Nenhuma escrita foi feita no fornecedor;
  a leitura live pertence ao caminho certificado de desktop.
- A identidade Infisical antiga saiu do runtime do StreamMax; a instância e os
  backups seguem preservados para rollback e **não** foram apagados.
- Funcionalidades SaaS (onboarding comercial, white-label, copilot completo)
  permanecem no roadmap; nada foi removido do banco/RLS.

## Cutover executado (2026-11-07, staging Contabo)

Alvo `vmi3630510`, diretório `/home/deploy/iptv-staging`, projeto Compose
`iptv-staging`, Docker context local (`default`). Nenhum projeto vizinho foi
tocado e o volume `iptv-staging_pgdata` não foi recriado.

### Dados

- Migration `068`: `applied=1 skipped=67 total=68`; `platform.secret_values`
  criada com RLS habilitada, 1 policy e 4 grants para `iptv_app`.
- Dry-run: 1 binding live (`StreamMax / asaas / SANDBOX / CONNECTED_READ_ONLY`);
  2 credenciais planejadas, 0 ausentes, 0 falhas.
- `--apply` (sem `--overwrite`): `migrated=2 existing=0 missing=0 failed=0`;
  linhas gravadas para `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`, formato
  `v1.<iv>.<tag>.<ciphertext>`, 1 tenant, 2 refs exatos.
- CINEVISION configurada depois, pelo Control Center, no esquema novo:
  `pgsecret://PRODUCTION/integrations/<tenant>/cinevision/CINEVISION_USER`
  (principal) + `CINEVISION_PASS` derivada; total final **4 linhas**
  (2 Asaas + 2 CINEVISION), todas no formato `v1.*`.
- Read-back de descriptografia: **4/4**; com chave incorreta, 0/4 (falha
  esperada). Nenhum valor foi impresso.
- RLS: `iptv_app` no tenant correto vê 2 linhas; com outro tenant, 0.

### Backups e recuperação

- Pré-cutover `20261107-184156`: dump + globals + SHA256 + manifesto; restore
  isolado em cluster descartável (67 migrations, 1 tenant, 9 outbox).
- Pós-cutover `20261107-190856` (2 linhas) e `20261107-195411` (4 linhas, já
  com CINEVISION): 68 migrations; restore isolado repetiu 68/4 e a
  descriptografia com a chave real (4/4); chave incorreta falhou (0/4)
  → `CUTOVER_RECOVERY_PASS`.
- Chave AES-256-GCM: 32 bytes em base64 canônica, custódia dupla em
  `/home/deploy/.streammax-secrets` e `/home/deploy/.streammax-custody` (0600),
  nunca impressa e fora do repositório e do dump.

### Runtime

- API recriada com `SECRETS_ENCRYPTION_KEY`; `INFISICAL_*` = 0, `HATCHET*` = 0,
  `DATABASE_URL` e `POSTGRES_PASSWORD` vazios no processo.
- Web e outbox-worker recriados com as imagens novas; outbox único, runtime
  `WORKER` gen=3, 0 pendentes e 0 linhas `PUBLISHING` sem lease.
- Asaas Sandbox: `POST /v1/integrations/asaas/test` pelo Control Center
  retornou `CONNECTED_READ_ONLY`; chamada direta read-only
  (`GET /v3/customers?limit=1`) → HTTP 200, sem cobrança. Token de webhook
  preservado (SHA-256 confere com `billing.tenant_channels.webhook_secret_hash`)
  e a chave confere com o valor legado.
- CINEVISION: `POST /v1/integrations/cinevision/configure` gravou
  `CINEVISION_USER`/`CINEVISION_PASS` cifrados; `POST .../cinevision/test`
  retornou `TESTING` + `PROVIDER_UNAVAILABLE` porque a API não encontra o CLI
  do browser-worker na imagem e o navegador não existe (nenhum write
  enviado). A separação exigida é clara: armazenamento/descriptografia OK,
  leitura no provedor indisponível pelo runtime.
- Persistência: restart da API → healthy, chave presente, sem Infisical,
  descriptografia 2/2 novamente.
- Público: `staging-api` ready 200, `staging-web` 200, cadastro público 403
  (local e via túnel). Infisical, Postgres, Redis e containers vizinhos
  preservados; Hatchet/PgBouncer ausentes.

### Artefatos de rollback no host

- `/home/deploy/backup/staging-pre-cutover-20261107-185258` (patch 19 MB,
  status, HEAD e tar de 2,9 MB da árvore antiga).
- `/home/deploy/backup/staging-env-20261107-185354` (`.env.staging` anterior e
  `.env.staging.outbox-worker` anterior).
- Imagens `:pre-mvp-oc-01-76515c3` mantidas para retorno.

## Entrega final

| Item | Resultado |
|---|---|
| PR #123 | MERGED (`e5ad924`) |
| Main SHA | `e5ad924ae6045a42015c8884dd75f2175afec01c` |
| Staging | `main@e5ad924` (5 serviços saudáveis) |
| Migration 068 | PASS (`applied=1 skipped=67 total=68`) |
| Credenciais migradas | 2 legadas (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`) + 2 CINEVISION via Control Center = 4 cifradas |
| Asaas Sandbox | PASS (Control Center `CONNECTED_READ_ONLY`; read-only 200; token preservado) |
| CINEVISION read-only | BLOCKED na leitura live (`PROVIDER_UNAVAILABLE`: runtime sem CLI/browser); credenciais cifradas e decifráveis 4/4 |
| Browser Worker | PASS (imagem + CLI; profile `worker`) |
| Outbox | PASS (único, `WORKER` gen=3, 0 pendentes) |
| Backup/restore | PASS (pré e pós-cutover; chave real 4/4, incorreta 0/4) |
| Infisical fora do runtime | SIM |

Veredito: `SIMPLIFICATION_CUTOVER_BLOCKED` — dependência objetiva: leitura live
CINEVISION exige runtime com o CLI do browser-worker e navegador (a imagem de
staging é packaging sem binário), além do caminho certificado de desktop.
Armazenamento, criptografia, migração, Asaas, outbox, backups e recuperação
estão aprovados; não é falha de descriptografia.
