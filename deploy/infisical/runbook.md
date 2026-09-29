# Runbook — deploy do Infisical self-host na VPS (IPTV)

Escopo: preparar e publicar `https://infisical.synkroo.com.br` na VPS do
projeto a partir dos arquivos deste diretorio. **Nenhum passo toca a VPS
sem autorizacao explicita para o deploy**; este runbook e executado por SSH
com chave de menor privilegio (nunca senha de root em linha de comando).

Imagem pinada: `infisical/infisical:v0.165.16@sha256:6b911e3938ac2ff385a782df59ce9272799be7976d26dc5667266a2aecac4116`
(release GitHub `v0.165.16`, publicada em 2026-09-23, nao-prerelease;
digest do manifest verificado no Docker Hub em 2026-09-29).

Pre-requisitos no servidor: Docker Engine 20.10+, Compose v2+, ~4 GB RAM
livre, acesso a internet para pull das imagens.

## 0. Pre-flight (estacao local)

1. Validar sintaxe do compose:
   `docker compose -f deploy/infisical/docker-compose.infisical.yml config`
   Criterio: sai com codigo 0 (valores de segredo aparecem como
   `REQUIRED`/`PLACEHOLDER` — esperado, o arquivo real so existe no servidor).
2. Confirmar que nenhum arquivo com segredo sera copiado:
   `git status --porcelain deploy/infisical` deve listar apenas os 4
   arquivos versionaveis; `.env.infisical` (real) nunca e commitado.

## 1. Enviar arquivos para a VPS

Via SSH com chave de menor privilegio (ex.: usuario `deploy`):

```sh
ssh deploy@<VPS_HOST> 'mkdir -p ~/infisical'
scp deploy/infisical/docker-compose.infisical.yml \
    deploy/infisical/.env.infisical.example \
    deploy/infisical/runbook.md \
    deploy/infisical/machine-identities.md \
    deploy@<VPS_HOST>:~/infisical/
```

Validacao: `ssh deploy@<VPS_HOST> 'ls -l ~/infisical'` lista os 4 arquivos.

## 2. Criar o `.env.infisical` NO SERVIDOR (segredos nascem la)

```sh
ssh deploy@<VPS_HOST>
cd ~/infisical
cp .env.infisical.example .env.infisical
chmod 600 .env.infisical
# Gerar e injetar cada segredo (substitui os REPLACE_ME):
ENCRYPTION_KEY=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -base64 32)
PG_PASS=$(openssl rand -hex 32)
# Edite .env.infisical com esses 3 valores (editor, sem echo no historico
# compartilhado; confira com `grep -c REPLACE_ME .env.infisical` == 0
# para as 3 chaves obrigatorias).
```

Validacao: `grep -c REPLACE_ME .env.infisical` retorna 0 nas chaves
obrigatorias; `stat -c %a .env.infisical` retorna `600`.

## 3. Rechecar imagem antes do pull (latest move; tag+digest nao)

No servidor, antes do primeiro deploy e de cada upgrade:

```sh
docker pull infisical/infisical:v0.165.16
docker inspect --format='{{.RepoDigests}}' infisical/infisical:v0.165.16
# Esperado: conter sha256:6b911e3938ac2ff385a782df59ce9272799be7976d26dc5667266a2aecac4116
```

Criterio: se o digest divergir, **parar** — reavaliar release/tag antes de
subir (possivel re-push legitimo ou imagem inesperada; nao prosseguir no escuro).

## 4. Subir a stack

```sh
cd ~/infisical
docker compose --env-file .env.infisical -f docker-compose.infisical.yml up -d
docker compose --env-file .env.infisical -f docker-compose.infisical.yml ps
```

Validacao: 3 servicos `Up`; `infisical` fica `healthy` em ate ~2 min
(primeiro boot roda migrations — `start_period: 90s` cobre isso).

## 5. Checagem pos-deploy (obrigatoria)

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/status
# Esperado: 200
docker compose --env-file .env.infisical -f docker-compose.infisical.yml logs --tail=50 infisical | grep -iE 'migration|listening|error'
# Esperado: migrations aplicadas, sem erro fatal
```

Depois abrir `https://infisical.synkroo.com.br` e criar a conta admin:
**o primeiro usuario cadastrado vira administrador da instancia** —
conclua esse passo antes de expor a URL a terceiros.

Criterio de aceite: `/api/status` local retorna 200, UI acessivel via
SITE_URL publica, login admin criado, `AUTH_SECRET`/`ENCRYPTION_KEY`
presentes so no `.env.infisical` do servidor (permissao 600).

## 6. Publicacao — duas opcoes (sem abrir portas diretas)

Regra: **nunca exponha 5432/6379/8080 para a internet**. O compose so
publica `127.0.0.1:8080`, entao nada do Infisical escuta na interface publica.

### Opcao A — tunnel `cloudflared` na VPS (preferida)

```sh
# cloudflared instalado na VPS, tunel ja autenticado (credenciais do tunel
# fora deste repo — ver fontes de deploy em AGENTS.md)
cloudflared tunnel --url http://127.0.0.1:8080
# ou entrada fixa no config do tunel:
# ingress: [{hostname: infisical.synkroo.com.br, service: http://127.0.0.1:8080}]
```

Validacao: `curl -s -o /dev/null -w '%{http_code}\n' https://infisical.synkroo.com.br/api/status` == 200.

### Opcao B — reversa do proxy existente

Apontar o reverse proxy ja em uso na VPS para `http://127.0.0.1:8080`
com `Host` preservado e TLS terminado no proxy; `SITE_URL` deve ser
exatamente `https://infisical.synkroo.com.br`.

Validacao: mesma checagem HTTPS da opcao A + certificado valido no browser.

## 7. Backup do volume do postgres (rotina)

```sh
cd ~/infisical
docker compose --env-file .env.infisical -f docker-compose.infisical.yml exec -T infisical-postgres \
  pg_dump -U "$INFISICAL_POSTGRES_USER" "$INFISICAL_POSTGRES_DB" \
  > "/backups/infisical_$(date +%Y%m%d).sql"
```

Fonte das variaveis: carregue do `.env.infisical` (`set -a; . ./.env.infisical; set +a`)
em vez de redigita-las. Agende em cron diario e retenha 7+ copias.
**Sem a `ENCRYPTION_KEY` o backup e indecifravel**: guarde copia da chave
no cofre do operador, separada dos dumps. Restore:

```sh
docker compose --env-file .env.infisical -f docker-compose.infisical.yml exec -T infisical-postgres \
  psql -U "$INFISICAL_POSTGRES_USER" "$INFISICAL_POSTGRES_DB" < backup.sql
```

Validacao do restore (em staging ou janela de manutencao): subir, checar
`/api/status` == 200 e login admin funcional.

## 8. Rollback

- Falha no primeiro deploy (`/api/status` != 200 apos 5 min, erro fatal de
  migration, digest divergente): `docker compose --env-file .env.infisical -f docker-compose.infisical.yml down`
  (volumes preservados por padrao), corrigir causa, repetir da etapa 3.
  **Nunca** `down -v` em incidente — isso apaga `infisical_pgdata`.
- Regressao apos upgrade: voltar a tag anterior no compose, `pull` + `up -d`,
  validar etapa 5; se o banco ja migrou para frente, restaurar o dump
  pre-upgrade (etapa 7) em vez de forcar downgrade sobre schema novo.
- Criterio de abortar e escalar ao operador: 2 tentativas sem `/api/status`
  200, qualquer divergencia de digest/imagem, ou indicios de exposicao de
  segredo (nesse caso, rotacionar as 3 credenciais antes de republicar).

## 9. Upgrades futuros

1. Backup (etapa 7). 2. Fixar nova tag+digest no compose. 3. Rechecar digest
(etapa 3). 4. `pull` + `up -d`. 5. Validar etapa 5 observando mensagens de
migration nos logs. Ver guia oficial de upgrade em caso de breaking changes.
