# Staging rehearsal pós-merge — rerun 2026-10-13 (lane `iptv-rehearsal2`, descartável)

> TASK_ID: P8-REHEARSAL-RERUN · branch `closure/browser-worker-real-chrome` @ `3e2dbf6`
> (código do merge pós-#63) · operador: Planner (autônomo, sem créditos, sem clientes ativos).
> Cobre a entrada P8 `docs/16-pilot-closure/P8-PILOT.md:10`
> (staging rehearsal pós-merge P1-exit p2 + P7, API como `iptv_app`).
> Roteiro: `docs/16-pilot-closure/P7-REHEARSAL.md` + ordem de 9 itens em
> `docs/10-operations/runbooks/rls-role-split-cutover.md:198-209`.
> Nenhum tráfego real, nenhum segredo real, nenhum crédito gasto.

## Lane (isolamento)

- Projeto docker `iptv-rehearsal2`, rede `iptv-rehearsal2_internal`,
  volume `iptv-rehearsal2_pgdata`, containers `iptv-rehearsal2-*`.
- Portas loopback dedicadas: PG `127.0.0.1:5439`, API `127.0.0.1:3211`,
  web `127.0.0.1:3210`, pgbouncer `127.0.0.1:6432`.
- Compose = cópia de `deploy/staging/docker-compose.staging.yml` com renames,
  fora do repo (TEMP); `CONFIG_OK` antes de subir. Dev (`iptv-postgres-1`),
  piloto e `synkroo-db` nunca tocados.
- Env só local e gerado (senhas aleatórias via stdin, nunca em repo/logs);
  `NODE_ENV=production`, `PROVIDER_DISPATCH_MODE=durable`,
  `ASAAS_ADAPTER=echo`, `PROVIDER_OPS_ADAPTER=manual`, sem `WAHA_*`,
  sem `OPENAI_API_KEY`, scheduler off, perfil `outbox` nunca subido.
- Imagens `iptv-rehearsal2-migrate/api/web:local` buildadas do zero (3/3 Built).

## Vereditos

| Passo | Veredito | Evidência |
|---|---|---|
| Migrate | PASS 60/60 | `applied=60 skipped=0` (schema cresceu: P7 citava 59) |
| API como `iptv_app` + guards production | PASS | boot ok, `ready {"status":"ok","checks":{"database":"ok"}}`, web `/` 200 |
| Postura PG | PASS | pool só `iptv_owner`(probe); `BYPASSRLS` só owner; `outbox_runtime_control` LEGACY gen 1; unfenced 0 |
| Seeds 001 | PASS | aplicadas via owner, sem erro |
| A/B direto (P1-exit p2) | PASS 16/16 | `cutover-ab-matrix.integration.test.ts` 40.75s |
| A/B via pooler | PASS 1/1/0 + deny | transação `pool_mode`, `DISCARD ALL`; x-insert nega por RLS |
| drain-state LEGACY | PASS | `enabled=True inFlight=0` (sessão platform-admin via SQL owner, destruída após: 0 admins + logout 200) |
| Fluxo P7 live | PASS | register→canal→inbound 202 `deduped:false`→replay `deduped:true`→1 OPEN→person→resolve `RESOLVED`+conversa→inbound2 202→`send-manual` SENT echo→copilot `OBSERVED` (1 conversa aberta); messages 2 (INBOUND+OUTBOUND) |
| Pernas profundas (11 suites) | PASS 113/113 | `suites-summary.log` (P7 original: 105; suites cresceram +8) |
| WAHA down → recovery | PASS | com URL+KEY mortos: `send-manual` FAILED 70ms; revertido: SENT 50ms |
| DB restart → recovery | PASS com observação | contagens iguais (persons 114, orders 70); **API seguiu `running`** (não reproduziu o exit 1 do P7 — ver achados) |
| Secret rotation | PASS | nova senha `iptv_app` → boot ok → register 201 |
| Backup restore | PASS (mecânica) | `pg_dump -Fc` 1.29MB → restore em DB scratch → fingerprints iguais `114/70/29/51/41` → scratch dropado, dump triturado |
| Gates Python | PASS | `validate_docs` OK; `test_contracts` 21 OK; `test_seed_contract` 5 OK |

## Achados (não bloqueiam)

1. **Suites de integração fazem higiene cluster-global de roles.** `cutover-ab-matrix`
   (`:506` seta senha, `:574` `PASSWORD NULL` no afterAll) e `billing-rls-rehearsal`
   (zera senha) assumem cluster descartável. Rodá-las contra a lane derrubou a
   senha do `iptv_app` (API 28P01) — recuperado com re-senha + restart, mas o
   padrão é armadilha para qualquer lane compartilhada: **rodar suites antes
   do fluxo live, ou re-senhar + reiniciar a API depois**.
2. **API sobreviveu ao restart do PG** (permaneceu `running`, recovery sem
   intervenção), ao contrário do exit 1 registrado no P7. Possível mitigação
   parcial desde 08/10 ou diferença de timing; o follow-up de handler+backoff
   do P7 segue válido como robustez, mas o modo de falha não foi observado aqui.
3. **Gateway WAHA exige URL+KEY.** Só `WAHA_BASE_URL` mantém echo (SENT) —
   comportamento correto por `messaging-gateway.ts:117-124`, registrado para
   não confundir com "WAHA imune".
4. **Variável `$R` vs `$r` no PowerShell.** Scripts da sessão colidiram
   (`$R` do workdir sobrescrito pelo `$r` de readiness) e quebraram um revert;
   recuperado sem efeito residual. Convenção: `$Lane` para paths.
5. Tokens de sessão das sondas aparecem nos logs de terminal desta sessão;
   a lane inteira (DB + logs de container) é destruída no cleanup.

## Gaps declarados (mesmos do P7, sem mudança)

- Worker kill: N/A — perfil `outbox` nunca sobe em rehearsal LEGACY (ativação é
  procedimento separado); sem worker, sem kill.
- Provider-down / model-outage / stale-approval live: só via suite
  (sem variante HTTP com endpoint morto / chave real).
- PIX sandbox: SKIP motivado (echo; `commerce-billing` cobre o caminho).
- Backup: só mecânica dump/restore; perna encrypt/offsite do `backup-dr.sh`
  não exercitada (sem gpg/openssl/bash no host; destroy-sim usa site separado,
  fonte nunca tocada — replicado manualmente com scratch DB).
- Sessão antiga sobrevivendo a rotation: não re-verificado (P7 cobriu).

## Artefatos

- `report.md` (este arquivo), `drills.log` (transcrição dos outputs de terminal
  da sessão — sem tokens/segredos) e `suites-summary.log` (log integral das
  11 suites). Vereditos live/drill são atestados pelo operador com a trilha
  em `drills.log`; nada aqui afirma certificação externa ou produção pronta.

## Cleanup e retenção (honesto)

- Removidos: `docker compose -p iptv-rehearsal2 down -v` (só volumes
  `iptv-rehearsal2_*`), workdir TEMP com env/senhas/userlist, imagens
  `iptv-rehearsal2-*:local`, DB scratch do restore, dumps.
- Destruir a lane INVALIDA suas sessões (o DB que as guardava sumiu), mas NÃO
  apaga os logs de terminal desta sessão, que ainda contêm 2 tokens de sessão
  descartáveis e IDs sintéticos da lane. Tokens de lane morta não autenticam
  mais nada, porém seguem visíveis no histórico do terminal até rotação —
  registrado aqui em vez de alegar remoção.
- Claim limitado: nenhum resíduo em repo, em outros bancos/containers ou em
  serviços externos; resíduos assumidos: histórico de terminal da sessão.
