# Runbook — Backup, Restore e Disaster Recovery (baseline executável)

> Status: backup + restore drill IMPLEMENTED (`scripts/db-backup.sh`,
> `scripts/db-restore-drill.sh`); drill executado localmente contra
> PostgreSQL 17 em container = TESTED (ver log abaixo). Agendamento, cópia
> offsite, encryption at rest e retenção de longo prazo são
> OPERATOR/INFRA EVIDENCE REQUIRED — a existência do script não valida DR.
> Targets de referência (RPO ≤ 15 min, RTO ≤ 60 min):
> `docs/15-implementation-baseline/13-nfr-slo-dr.md` — NÃO os declare como
> atendidos até que o agendamento e o restore em infra real tenham evidência.

## Princípios

1. Backup não é DR. Só existe DR quando um restore foi executado e
   validado a partir de um archive real.
2. Todo archive carrega manifest (`sha256`, tamanho, versão do `pg_dump`,
   origem). O drill rejeita archive com hash divergente ANTES de restaurar.
3. O drill roda em container descartável isolado e NUNCA toca o banco fonte.
4. Migrations/version validation faz parte do restore: um archive cujo
   `platform.migration_history` não bate com `db/migrations/*.sql` do
   repositório é um restore parcial — falha, não aviso.
5. Status vocabulary: `IMPLEMENTED` (existe e roda), `TESTED` (executado com
   evidência), `OPERATOR/INFRA EVIDENCE REQUIRED` (depende de infraestrutura
   ou decisão humana externa a este repositório).

## Backup (execução)

```bash
# Container é a fonte (pg_dump roda dentro do container; host não precisa de
# psql/pg_dump). Owner role direto; NUNCA via iptv_app/pooler.
bash scripts/db-backup.sh <container> <db-user> <db-name> <output-dir> [keep=7]
```

Saídas: `<db>-<timestamp>.dump` (formato custom `-Fc`) +
`<db>-<timestamp>.dump.manifest.json`. Retenção local: mantém os N mais
recentes (`keep`).

## Restore drill (validação executável)

```bash
bash scripts/db-restore-drill.sh <backup.dump> <drill-db-name> [postgres:17-alpine] [repo-root]
```

Passos do script: sha256 vs manifest → container descartável →
`pg_restore --exit-on-error` → validações (contagem de migrations idêntica ao
repositório; ledger `finance` balanceado debit=credit quando presente;
espinha `audit_log`/`domain_events` presente; invariantes de provider:
operações terminais com `completed_at`, bindings `ACTIVE` com
`external_id`) → `DRILL PASS`/`DRILL FAIL` + cleanup automático.

`pg_restore` valida o TOC do archive antes de aplicar; archive truncado ou
corrompido falha no restore, não pela metade.

## Procedimento de restore real (incidente)

1. Congelar escritas no alvo (parar API/workers; `deploy/staging` compose:
   `docker compose stop api web worker`).
2. Escolher o archive mais recente **validado** (manifest + hash ok). Em
   dúvida entre archives, rodar o drill em cada candidato antes de decidir.
3. Provisionar o PostgreSQL alvo na MESMA major version do archive (17).
4. `pg_restore -U <owner> -d <db> --no-owner --exit-on-error <backup.dump>` a
   partir de conexão owner direta — as regras do runbook de RLS continuam
   valendo: restore roda como owner; o app só volta como `iptv_app` depois
   das checagens.
5. Reaplicar roles/papéis pós-restore se necessário (`iptv_app` LOGIN,
   grants vêm do dump; a senha do role NÃO — reposicionar via caminho de
   secrets aprovado, ver rls-role-split-cutover.md step 4a).
6. Apontar a aplicação de volta (compose up), confirmar `/v1/health/ready` e
   `LOG_LEVEL` ativo, observar outbox/reconciliação
   (outbox-workflow-backlog.md, reconciliation-drift.md).
7. Registrar evidência (comando, archive hash, duração, checagens) no log de
   operações. Sem esse registro, o incidente não conta como validação DR.

## Cluster roles pós-050 (restore drill + cluster novo)

Roles PostgreSQL são cluster-level: um backup normal da database NÃO os
carrega. Num cluster fresco (restore drill ou cluster novo), provisione ANTES
do `pg_restore`/migrate, como superuser owner:

```sql
-- Exatamente a postura que a migration 050 aceita (qualquer divergência
-- recusa a migration em vez de normalizar):
CREATE ROLE outbox_worker LOGIN NOBYPASSRLS;
CREATE ROLE outbox_executor NOLOGIN NOINHERIT NOBYPASSRLS;
-- Zero memberships, zero grants, zero objetos possuídos (a migration valida
-- tudo fail-closed, incl. pg_parameter_acl). Senhas NÃO vivem no dump:
ALTER ROLE outbox_worker PASSWORD '...';  -- caminho de secrets do operador
```

Cenários a rehearsar (issue #10): **A — cluster limpo** (sem roles outbox →
migrate 001–050 cria + API + worker + testes); **B — roles compatíveis
preexistentes** (criadas exatamente como acima → migrate PASS). Um cenário
incompatível (ex. `BYPASSRLS`) deve recusar fail-closed. O drill existente
(`db-restore-drill.sh`) ainda não cobre esses roles — estender o script é
trabalho futuro; o procedimento acima é o contrato até lá.

## Encryption e offsite (OPERATOR/INFRA EVIDENCE REQUIRED)

- Encryption at rest do archive: aplicar na camada de storage (ex. `age`/
  `gpg -c` sobre o `.dump` ANTES da cópia offsite, chave em cofre separado —
  Infisical/vault do operador, nunca junto do archive).
- Offsite: copiar `.dump` + `.manifest.json` para storage externo ao host
  (objeto/outra região) com retenção própria. 3-2-1 como alvo declarado.
- Agendamento: cron/tarefa agendada no host chamando `db-backup.sh`; frequência
  definida pelo RPO alvo (15 min ⇒ WAL archiving/PITR é o caminho correto, não
  dumps periódicos — decisão de infra, registrar ADR quando escolhido).
- Testes de restore periódicos: rodar o drill contra um archive recente
  mensalmente (ou pós-qualquer upgrade de major version do PostgreSQL) e
  registrar evidência.

## Backup do Infisical self-host → R2 (`scripts/infisical-backup.sh`)

> Status: `IMPLEMENTED` + `LIVE TESTED` em 2026-11-03. `bash
> scripts/infisical-backup.sh selftest` → 40/40 com stubs. Três conjuntos
> reais no R2 foram verificados por conteúdo; um foi restaurado em stack
> Docker local, isolado e descartável (evidência abaixo). Isso prova backup e
> restore testado; não equivale a PITR nem a SLO de RPO/RTO.

Modelo de segurança (decisão de review): o host de backup detém SOMENTE a
chave PÚBLICA do destinatário — criptografa, nunca descriptografa. Nenhuma
chave simétrica (`BACKUP_CRYPTO_KEY_FILE`) e nenhuma chave privada é
provisionada na VPS; o formato simétrico `backup-crypto.mjs`/`backup-dr.sh`
NÃO é usado neste fluxo. Criptografia em envelope híbrido
(RSA-OAEP-SHA256 embrulha uma AES-256-GCM nova por archive, formato `IPUB1`).

O wrapper faz dump isolado + cópia offsite:

1. `pg_dump -Fc` via `docker exec` contra `iptv-infisical-postgres`
   (banco/usuário `infisical`) para temp `0600` com cleanup por trap
   (`EXIT`/`INT`/`TERM`), depois envelope-encrypt com a chave pública
   (`<db>-<ts>-<rand>.dump.penc` + manifest não-secreto com
   `plain_sha256`/`enc_sha256` + `recipient_pub_sha256`) e unlink do
   plaintext (`rm -f` só desvincula — NÃO é shred seguro; ver risco
   residual abaixo). Nomes únicos por run (timestamp + 4 bytes aleatórios;
   saída preexistente falha fechado em vez de sobrescrever). Staging do
   crypto usa temps imprevisíveis (pid + 16 bytes aleatórios) criados com
   exclusividade (`O_CREAT|O_EXCL`, `0600` — symlink pré-plantado falha
   fechado em vez de ser seguido) e publish atômico sem overwrite via
   hard-link (`EEXIST` quando o destino já existe, mesma semântica em
   POSIX e Windows; só parciais recém-criados são removidos em erro).
2. Cópia de recuperação do `/home/deploy/infisical/.env.infisical`
   criptografada **in place** com a mesma chave pública
   (`infisical-env-<ts>.penc` + manifest). A fonte nunca é alterada/removida.
3. Upload para o R2 **somente** dos 4 objetos (2 ciphertexts + 2 manifests)
   via `rclone` — sem AWS CLI em nenhum passo. O remote S3 é configurado
   **só por ambiente** (variáveis `RCLONE_CONFIG_INFISICALR2_*` exportadas
   pelo próprio script); nenhum arquivo de config do rclone é criado, e
   nenhum knob `*_ACL` é exportado (o R2 não suporta operações ACL; objetos
   já são privados por padrão). O remote exporta ainda
   `RCLONE_CONFIG_INFISICALR2_NO_CHECK_BUCKET=true`: exigência da doc
   oficial do rclone para o R2 com tokens de permissão por objeto — sem o
   flag, o rclone tenta checar/criar o bucket (chamada de nível de bucket
   que o token objeto-leitura/escrita não tem) e o `PutObject` falha com
   403 mesmo quando `lsd` funciona. Pular o check restringe o rclone às
   operações de objeto que o token realmente concede. Chaves com timestamp+aleatório únicos por
   run — sem overwrite entre runs; retenção local `keep` + lifecycle do R2.
4. Verificação remota por integridade de conteúdo (diretório de stage
   `0700` com exatamente os 4 recém-enviados → `rclone check <verify_dir>
   <remote:prefix> --download --one-way`; bytes reais comparados, não
   apenas listagem; `--one-way` para objetos mais antigos no prefixo não
   falharem a comparação; staging sempre removido, só ciphertext/manifests); qualquer falha de dump/encrypt/
   upload/verificação fecha falhado (fail-closed) e **mantém o ciphertext
   local** para recuperação.

### Ciclo de vida das chaves (operador — valores nunca no repo)

1. Gerar o par LOCALMENTE (nunca na VPS, nunca no R2). ANTES do `keygen`, preparar o diretório de recuperação:
       `mkdir -p artifacts/infisical-recovery` (restringir ao operador; confirmar cobertura pelo `.gitignore` antes de gerar saídas), depois:
    `node scripts/infisical-public-crypto.mjs keygen
   artifacts/infisical-recovery/infisical-backup.priv.pem
   artifacts/infisical-recovery/infisical-backup.pub.pem`
   (`artifacts/` é ignorado pelo Git; privada `0600` + dir restrito). Guardar a privada
   também em backup externo do operador (cópia offline) — sem ela os
   archives são irrecuperáveis.
2. Instalar SÓ a pública na VPS (ex. `/etc/infisical-recovery/*.pub.pem`,
   `0644` ou `600`). NUNCA copiar a privada nem qualquer
   `BACKUP_CRYPTO_KEY_FILE` para o host. O arquivo AES simétrico criado no
   ensaio inicial foi removido antes de produzir archives; nenhum backup
   depende dele nem é recuperável por ele.
3. Conferir a pública instalada contra o fingerprint `PUBLIC SHA256`
   impresso no `keygen` antes do primeiro backup. Cada manifest carrega
   `recipient_pub_sha256` — no restore, escolher a privada local cujo
   fingerprint bata com o do manifest (a `fingerprint <pub.pem>` do helper
   recalcula sob demanda).

### Rotação e retenção das chaves privadas (operador)

- Rotação = `keygen` novo + instalar a nova pública na VPS. Backups novos
  usam a nova; archives antigos continuam legíveis SÓ pela privada antiga.
- **Reter cada privada antiga pelo menos enquanto existir qualquer archive
  criptografado para ela**: lifecycle do R2 (expiração após 90d) + retenção
  local `keep`. Apagar a privada antiga antes disso torna esses archives
  irrecuperáveis. `keygen`/`decrypt` recusam sobrescrever saídas
  preexistentes (fail-closed).
- Criptografia em streaming (sem ler o dump inteiro em RAM): `encrypt`
  publica por hard-link atômico sem overwrite após o tag GCM; `decrypt` só publica o
  plaintext após a autenticação GCM — archive adulterado nunca vira
  plaintext, e temps (`0600`) são desvinculados em falha/sinal.
- Risco residual do plaintext no host: o dump existe brevemente como temp
  `0600` desvinculado (`rm -f`) logo após o encrypt — desvincular NÃO é
  apagar com segurança. Page cache, snapshots/CoW do filesystem, blocos de
  journal ou wear-leveling do SSD podem reter cópias recuperáveis; `0600`
  limita o acesso ao dono local, não promete apagamento forense. Para
  garantia maior, rodar o backup dir em volume criptografado.

### Config no host (nomes — valores vivem só no host, nunca no repo)

| Variável | Significado |
|---|---|
| `INFISICAL_BACKUP_PUBLIC_KEY_FILE` | chave PÚBLICA do destinatário na VPS — REQUIRED; live path `/home/deploy/infisical/infisical-backup.pub.pem`; ÚNICO material de chave no host (nunca privada, nunca simétrica) |
| `INFISICAL_ENV_FILE` | fonte (default `/home/deploy/infisical/.env.infisical`) |
| `INFISICAL_PG_CONTAINER` / `INFISICAL_PG_USER` / `INFISICAL_PG_DB` | defaults `iptv-infisical-postgres` / `infisical` / `infisical` |
| `INFISICAL_BACKUP_DIR` / `INFISICAL_BACKUP_KEEP` | work dir local (live `/home/deploy/infisical/backups`; default do script `/var/backups/infisical`) + retenção de ciphertext (7) |
| `INFISICAL_R2_ENDPOINT` | endpoint S3 do R2 (conta do operador) — REQUIRED |
| `INFISICAL_R2_BUCKET` | bucket (ex. `iptv-infisical-backups`) — REQUIRED |
| `INFISICAL_R2_PREFIX` | prefixo (default `infisical/`, protegido por retenção 30d + expiração do ciclo de vida após 90d — lifecycle configurado no R2 pelo operador, não pelo script) |
| `INFISICAL_R2_ACCESS_KEY_ID` / `INFISICAL_R2_SECRET_ACCESS_KEY` | credencial R2 com escopo só ao bucket — REQUIRED, nunca logada |
| `INFISICAL_R2_REGION` | default `auto` |

### Cron diário (instalado em 2026-11-03; host-only — sem caminho de chave de decrypt)

```cron
0 3 * * * (umask 077; set -a; . /home/deploy/infisical/backup.env; set +a; bash /home/deploy/iptv-staging/scripts/infisical-backup.sh backup) >>/home/deploy/infisical/backup.log 2>&1
```

O job roda como `deploy`, diariamente às 03:00 no fuso local do host (CET),
e foi verificado no crontab. `/home/deploy/infisical/backup.env` está em modo
`600` e contém a configuração do uploader R2 + o caminho da chave PÚBLICA.
A chave privada não está na VPS.

Se a VPS ficar indisponível durante um incidente, o token uploader dentro de
`backup.env` também ficará indisponível. O operador deve autenticar-se no
Cloudflare e emitir um novo token **Object Read**, escopado somente a
`iptv-infisical-backups`, para o `rclone` da máquina isolada; fornecer a
credencial ao processo local sem gravá-la no repositório nem enviá-la por
chat. A recuperação depende também do acesso independente à conta Cloudflare
e da cópia privada local/offline indicada acima.

### Restore isolado (procedimento executado; ver evidência live abaixo)

1. Baixar os 4 objetos do prefixo (copiar o prefixo com `rclone copy` — `copyto` serve só para arquivo único):
   exemplo: `rclone copy <configuredRemote>:<bucket>/<prefix>/ <restore-dir>/` na máquina ISOLADA do operador (nunca na VPS de backup; sem remote configurado, prover a credencial do remote nela pelo caminho aprovado do operador — nunca na VPS nem por chat), a partir do par dump+env do mesmo
   `<ts>-<rand>`. Anotar o `recipient_pub_sha256` dos manifests para
   selecionar a privada correta (ver rotação acima).
2. Conferir `sha256` de cada `.penc` contra o `enc_sha256` do seu `.manifest.json`;
   divergência = rejeitar antes de qualquer decrypt/restore.
3. Decrypt em máquina ISOLADA do operador (nunca na VPS de backup) com a
   privada local:
   `INFISICAL_RECOVERY_PRIVATE_KEY_FILE=<privada> node
   scripts/infisical-public-crypto.mjs decrypt <archive>.penc
   <archive>.plain` (envelope/tag GCM inválido = arquivo rejeitado; chave
   errada = rejeitado). Em seguida, comparar o SHA256 do dump descriptografado com o `plain_sha256` do manifest do dump ANTES de qualquer `pg_restore` (divergência = rejeitar; ex. `sha256sum <archive>.plain`). O manifest do env NÃO tem hash de plaintext — a integridade dele é verificada pela autenticação GCM do `decrypt`.
4. Subir PostgreSQL 17 + Infisical **frescos e isolados**: novos
   volumes/containers (nunca reutilizar `infisical_pgdata`/
   `infisical_redisdata` — Redis limpo), loopback, sem porta pública,
   `pg_restore --list <dump>.plain` (inspecionar o TOC) e `pg_restore --exit-on-error` do dump no alvo isolado fresco, `.env.infisical` restaurado com
   `600`, checar `/api/status == 200` + login admin antes de qualquer
   cutover.
5. Registrar evidência (comando, hashes, duração, checagens) no log de
   operações — sem esse registro o restore não conta como validação DR.

### Evidência live (2026-11-03 — staging)

- R2 bucket `iptv-infisical-backups`, prefixo `infisical/`: três pares dump +
  `.env` (12 objetos, 4 por execução) foram verificados de ponta a ponta com
  `rclone check --download --one-way`; conjuntos `20261103T174448Z-2f70e05d`,
  `20261103T181251Z-fa2903f6` e `20261103T181805Z-14b3e486`. O último conjunto
  (dump plaintext 4.358.324 bytes; ciphertext 4.358.615 bytes; env plaintext
  1.688 bytes; ciphertext 1.979 bytes) foi a fonte do drill abaixo. Bucket
  permanece privado; lock de 30 dias e lifecycle de expiração em 90 dias no
  prefixo `infisical/`.
- Recuperação da chave: somente a chave pública (`0644`) foi instalada em
  `/home/deploy/infisical/infisical-backup.pub.pem`; ausência da privada na
  VPS verificada. A privada ficou no operador local em
  `artifacts/infisical-recovery/infisical-backup.priv.pem` (ignorada pelo Git,
  ACL restrita ao usuário local). Esta execução não criou uma segunda cópia
  offline independente; perder essa estação/cópia ainda tornaria os archives
  irrecuperáveis — manter outra cópia offline é necessário para alta
  disponibilidade da própria chave.
- Restore isolado: ciphertexts obtidos do R2, hashes dos manifests e
  fingerprint da chave conferidos; decrypt local passou com GCM e o SHA256 do
  dump bateu com `plain_sha256`. O archive restaurou em PostgreSQL 17 fresco
  (764 tabelas) + Redis limpo + Infisical `v0.165.16`, em projeto Docker
  descartável com rede `internal` e sem porta de host publicada; containers e
  volumes `infisical-restore-20261103` eram novos, nenhum volume/serviço
  Infisical ativo da VPS foi tocado. `/api/status` local `healthy`; smoke
  Universal Auth leu `TEST_SECRET` do ambiente `staging` (`len=27`) sem
  imprimir o valor. O par de ciphertexts foi também baixado diretamente do R2
  para a estação do operador; hashes comparados com o material usado no drill
  foram idênticos.
- Agendamento: cron diário acima instalado; o backup manual foi executado e
  verificado com sucesso. O schedule diário dá RPO nominal de até 24h para
  este cofre; não há WAL/PITR configurado, portanto isto não é um SLO.
- Custódia residual: a privada de recuperação está no diretório local do
  operador, ignorado pelo Git e ACL restrita; nesta execução não foi criada
  uma segunda cópia offline. Uma falha/perda dessa estação ainda pode tornar
  os archives irrecuperáveis até que exista outra cópia independente.
- Limpeza do drill: o projeto Docker/volumes descartáveis e os arquivos
  plaintext locais foram removidos após a validação; a chave privada local e
  os archives remotos não foram removidos.

## Log de execução (2026-10-05 — hardening closure round)

- Base migrada via o próprio job de deploy: `iptv-migrate` aplicou as 47
  migrations em container descartável (`applied=47` na primeira execução,
  `skipped=47 idempotente` na re-execução).
- Backup: `scripts/db-backup.sh iptv-verify2 iptv iptv_test artifacts/drill 3`
  → `iptv_test-20261005T182132Z.dump` + manifest (sha256 `b050631d2d6b…`).
- Drill: `scripts/db-restore-drill.sh` em container descartável isolado —
  **DRILL PASS**: hash OK; roles `iptv`/`iptv_app` provisionados antes do
  restore; `pg_restore --exit-on-error` OK; migrations `restored=47
  expected=47`; ledger debit=credit; espinha `audit_log`/`domain_events`
  presente; invariantes de provider OK (0 operações terminais sem
  `completed_at`, 0 bindings `ACTIVE` sem `external_id`).
- Achados do drill (corrigidos no script, são parte do procedimento real):
  1. restore em cluster fresco exige provisionar os roles ANTES do
     `pg_restore` (os dumps carregam `GRANT … TO iptv_app` de
     041/042/043/047) — o passo já constava do runbook como step 5; agora é
     executado e verificado pelo drill;
  2. o entrypoint da imagem sobe um servidor TEMPORÁRIO durante o initdb e o
     reinicia — probes/writes contra ele desaparecem; o drill converge
     re-executando statements reais até os efeitos persistirem;
  3. armadilha bash: `${VAR:-"a b"}` dentro de `for` não sofre word-splitting
     (criaria um role literalmente chamado `iptv iptv_app`).
- NÃO validado nesta rodada (permanece aberto): restore em infra real
  (VPS/storage externo), encryption, agendamento, PITR/WAL.
