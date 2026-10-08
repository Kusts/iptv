# P6 — Disaster Recovery (parte 2: backup agendado + criptografado + offsite + restore + bootstrap)

> TASK_ID: CODER-P6B · branch `closure/p6-hardening` · SPEC C7/C8 (fatia 2)
> Escopo desta slice: schedule/encrypt/offsite/restore/bootstrap executáveis +
> decisão PITR/WAL vs RPO registrada. **Nada de P6a foi tocado** (workflows,
> `.gitleaks.toml`, `scripts/ci-audit-gate.py`, `tests/security`,
> `P6-SECURITY.md` intocados); **nenhum offsite real, nenhuma produção,
> nenhum segredo em arquivo**.

## 1. Decisão PITR/WAL vs RPO — REGISTRADA

Fato medido no staging em 2026-10-08 (somente leitura):

- `SHOW archive_mode` → `off`; `SHOW wal_level` → `replica`;
  `SELECT pg_is_in_recovery()` → `f`. **Não há PITR nem WAL archiving** no
  staging (nem no compose — `deploy/staging/docker-compose.staging.yml` não
  configura `archive_command`, base backups ou réplica).

**DECISÃO: sem PITR, RPO = intervalo do schedule.** Dumps `*/15` dão RPO
nominal ≤ 15 min **somente para DBs piloto pequenos** (o archive de staging
tem 622.620 bytes — um `pg_dump` leva ~1 s). Isso **não** é um SLO
contratual: é o teto do que dumps periódicos provam. A postura de produção
exige PITR (`archive_mode=on` + WAL shipping + base backups + restore
testado de um ponto arbitrário) — registrado como follow-up de infra com
critério de aceite explícito (§5), nunca alegado como atendido aqui. O RTO
≤ 60 min segue como target de engenharia com evidência parcial: o ciclo
completo do drill levou **91 s** neste DB (§4); RTO real depende do tamanho
do archive + throughput do host e será recalibrado com dados de pilot.

## 2. Peças novas (esta slice)

| Peça | Arquivo | Papel |
|---|---|---|
| Orquestrador | `scripts/backup-dr.sh` | `backup` (dump+encrypt+shred+manifest+retenção), `offsite-put/get` (cópia verificada por sha), `drill` (end-to-end §3), `schedule` (bloco cron do operador), `keygen` |
| Cripto | `scripts/backup-crypto.mjs` | AES-256-GCM stdlib-only; formato `IPTV1\|\|iv12\|\|tag16\|\|ct`; chave só via arquivo `$BACKUP_CRYPTO_KEY_FILE` (64 hex), nunca impressa; tamper/truncamento falha no decrypt |
| Offsite | driver `local:` (dir 0700) + swap S3-compatível (`OFFSITE_S3_DEST` + `OFFSITE_S3_ENDPOINT` via `aws s3 cp`; mesma verificação sha) | simulado local nesta slice; S3 real é passo de operador documentado, não executado |
| Reuso deliberado | `scripts/db-backup.sh` (dump plain), `scripts/db-restore-drill.sh` (gate canônico quando a origem está no HEAD) | sem duplicar lógica de dump/restore |

Disciplina de segredos: chave e senhas drill-only (`drill-only-*`) vivem só
em arquivos do operador / containers descartáveis; manifests carregam só
hashes e tamanhos; `artifacts/` é gitignored (dumps nunca entram no repo).

## 3. Procedimento executável (drill end-to-end)

```bash
BACKUP_CRYPTO_KEY_FILE=<arquivo-0600-do-operador> \
  bash scripts/backup-dr.sh drill <container> <db-user> <db-name> [drill-root]
```

Fases: backup → encrypt (plain shred) → fingerprint da origem → offsite-put
→ second-site descartável → offsite-get + decrypt (tag+GCM + sha vs
manifest) → bootstrap de roles **antes** do restore → `pg_restore
--exit-on-error` → DROP DATABASE (perda simulada) → re-restore **da mesma
cópia offsite** → verificação de postura 050 → fingerprint pré == pós →
validação estrutural (ledger/spine/provider) → gate canônico quando
aplicável → `DRILL PASS` com duração total (evidência de RTO).

## 4. Evidência do drill (2026-10-08, staging descartável)

Origem: `iptv-staging-postgres/iptv` (51 migrations, outbox/inbox/audit
vazios — staging sem dados de pilot). Evidência local (gitignored):
`artifacts/dr-p6b/20261008T023909Z/`.

- Backup: `iptv-20261008T023910Z.dump` **622.620 bytes**,
  `plain_sha256`
  `ccc0a81aac12d8884b30abfd53bc02fdeffe1b56c95475c2ee27b5cd9bbac21a`
  (`pg_dump 17.11`); encrypt → **622.653 bytes** (+33: magic+iv+tag),
  `enc_sha256`
  `1497d833569c1ff2801542a1781a4dc7a20a0adbbd8da5e7cb4f3c147a1772c1`.
- Offsite (driver local simulado): put + get com sha verificado nas duas
  pontas; receipt `.offsite.json` com `stored_at 2026-10-08T02:39:12Z`.
- Decrypt: tag GCM verificada + sha descriptografado == `plain_sha256` do
  manifest. Controle negativo à parte: byte flipado no `.enc` → `decrypt`
  falha com exit 1 (`authentication failed`); roundtrip sha-identico no
  arquivo íntegro.
- Destroy simulado: `DROP DATABASE` confirmado ausente em `pg_database`;
  re-restore da **mesma** cópia offsite OK (`--exit-on-error` duas vezes).
- Bootstrap: `iptv`/`iptv_app` LOGIN + `outbox_worker` LOGIN NOBYPASSRLS +
  `outbox_executor` NOLOGIN NOINHERIT NOBYPASSRLS, todas verificadas em
  `pg_roles`; `worker_member_rows:0`, `worker_table_privs:0`, EXECUTE nas 4
  funções (`claim/renew/complete/fail`) = `true` — **a postura 050
  sobrevive ao backup/restore** (grants viajam no dump; memberships
  inexistentes continuam inexistentes).
- Fidelidade: fingerprint pré-destroy == pós-restore (migrations 51,
  spine `audit_log`/`domain_events` presente, `provider_terminal_unfinished:0`,
  `provider_active_noext:0`, ledger 0=0).
- **DRILL PASS em 91 s** (backup→…→smoke).

## 5. Achados (viram follow-up, não falha escondida)

1. **Restore ingênuo com 2 roles FALHA em archives pós-050** (provado neste
   drill): o dump carrega `POLICY ... TO outbox_executor` + funções do
   executor; `pg_restore` aborta sem os 4 roles
   (`role "outbox_executor" does not exist`). O drill estende via
   `DRILL_ROLES` (só existência para o TOC; a postura exata já foi
   verificada na fase 6). Contrato do runbook
   (`docs/10-operations/runbooks/backup-restore.md`, cluster roles pós-050)
   confirmado por execução, não só por leitura.
2. **Gate canônico vs origem atrasada**: `db-restore-drill.sh` compara com
   `db/migrations/*.sql` do HEAD (59); staging está em **051 (51
   aplicadas)** — o gate não pode passar por construção. O drill prova
   fidelidade **contra a origem** (51==51) e registra o drift em vez de
   escondê-lo. **Follow-up: re-migrar o staging (052–059, P1.3–P1.6) e
   re-rodar o drill**; quando origem == HEAD o gate canônico roda dentro do
   drill.
3. **Staging atrás do HEAD** (mesma causa do item 2): última aplicação
   2026-10-07 19:46; faltam 052–059. Também explica o `500` do webhook medido
   na carga (ver `P6-PERFORMANCE.md`): sem os grants 052, `iptv_app` nega
   `tenant_channels` — fail-closed, sem leak, mas artefato de drift.
4. **Sem PITR** (§1): RPO ≤ 15 min é nominal de schedule, não SLO; RTO ≤ 60
   min tem evidência parcial (91 s neste DB). Follow-up de infra (critério
   de aceite): `archive_mode=on` + `archive_command` para storage separado +
   base backup + restore point-in-time ensaiado em staging descartável com
   perda medida ≤ 15 min; só então RPO/RTO viram SLO.

## 6. Validação desta slice

- `backup-dr.sh drill` → **DRILL PASS 91 s** (acima, §4).
- `backup-crypto.mjs`: roundtrip sha-idêntico + tamper → exit 1.
- `schedule` imprime o bloco cron `*/15` (keep=96 ≈ 24 h) + sweep offsite.
- Nenhum segredo em arquivo: manifests só com hashes; chave fora do repo
  (scan P6a continua válido — nenhum arquivo novo contém segredo).
- `python scripts/validate_docs.py` verde (este doc só referencia arquivos
  existentes; sem registry de eventos tocado).
