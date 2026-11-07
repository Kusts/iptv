# STREAMMAX-SIMPLIFY-01 — Registro da simplificação

Registro curto da entrega de simplificação (não é uma auditoria). Contrato
canônico continua em `docs/15-implementation-baseline/`.

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

## Cutover de credenciais (operador)

1. Gere a chave uma vez: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Guarde `SECRETS_ENCRYPTION_KEY` fora do banco/Git e faça backup recuperável
   do PostgreSQL **e** da chave (custódia separada).
3. Com a identidade antiga ainda válida, rode o inventário e depois a cópia:
   `node packages/database/scripts/migrate-secrets-to-postgres.mjs` (dry run)
   e `... --apply`. O script só lê valores existentes e faz upsert pelo
   `secret_ref` exato; não apaga o cofre.
4. Valide no Control Center: salvar/ler credencial, reiniciar a API, testar
   Asaas Sandbox sem cobrança, leitura CINEVISION e bloqueio cross-tenant.
5. Restaure um backup isolado e confirme a descriptografia com a chave.
6. Só então remova a identidade antiga do deploy. O cofre e seus backups não
   são apagados por esta entrega.

## Antes → depois

| Item | Antes | Depois |
| --- | --- | --- |
| Serviços no compose de staging | 8 (postgres, migrate, api, web, tunnel, browser-worker, outbox-worker, pgbouncer — os 3 últimos por profile) | 7 (postgres, api, web, tunnel e outbox-worker permanentes; migrate one-shot; browser-worker sob demanda) |
| Cofre de segredos | Infisical externo + identidades de máquina | PostgreSQL ciphertext (`platform.secret_values`) + `SECRETS_ENCRYPTION_KEY` |
| Workflow durável | Hatchet opcional (SDK/config) | Outbox worker dedicado; port de workflow só não-durável |
| Env removidas | `INFISICAL_SITE_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_ENVIRONMENT`, `BROWSER_INFISICAL_SITE_URL`, `BROWSER_INFISICAL_PROJECT_ID`, `BROWSER_INFISICAL_CLIENT_ID`, `BROWSER_INFISICAL_CLIENT_SECRET`, `HATCHET_API_TOKEN`, `HATCHET_SERVER_URL` | — |
| Env adicionada | — | `SECRETS_ENCRYPTION_KEY` |

## Testes que sustentam a entrega

- `packages/secrets`: criptografia (round-trip, AAD, tamper, versão, chave
  inválida), adapter (isolamento cross-tenant, refs legados, rotação) — 20/20.
- `apps/api`: `typecheck` + suíte completa (unitários) 909 pass / 488
  DB-gated skipped; integração do segredo contra PostgreSQL em
  `test/secrets-postgres.integration.test.ts` (cifra em repouso, persistência
  após "restart", cross-tenant, chave errada, RLS).
- `apps/browser-worker`: typecheck, lint, 263 testes e build sem Infisical.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` verdes; `pnpm test
  --concurrency=1` 20/20 tasks; gates Python (docs/contracts/seed) verdes;
  `gitleaks detect` (histórico) e `protect --staged` sem leaks.

## Fora de escopo / pendências externas

- Validação live em staging (deploy, cutover real, Asaas/CINEVISION) exige
  autorização do ambiente e não é feita por este registro.
- Funcionalidades SaaS (onboarding comercial, white-label, copilot completo)
  permanecem no roadmap; nada foi removido do banco/RLS.
