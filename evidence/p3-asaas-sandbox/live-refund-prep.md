# LOOP-BOLETO-1 — preparar refund-live (PARADO antes de qualquer chamada live)

- TASK_ID: LOOP-BOLETO-1
- Data (UTC): 2026-10-08
- Base: main@1eeaafb (merge #32; inclui #30 binding e #31 pilot; sem alterações de código-fonte; `git status` limpo exceto este arquivo; sem commit/push)
- Regras aplicadas: `ASAAS_*` lidos SOMENTE em-processo (script em `%TEMP%\opencode\iptv-loopblt`, fora do repo; só host/vereditos impressos);
  host `api-sandbox.asaas.com` afirmado ANTES de qualquer chamada (qualquer outro host abortaria com BLOCKED e zero chamadas);
  zero segredos em outputs/arquivos; lane piloto (`iptv-pilot`, :3200/:3201) NUNCA tocada — verificada apenas via leitura (`docker ps`: `iptv-pilot-api/web/postgres` UP);
  produção NUNCA tocada. **Nenhuma chamada ao provider foi feita** (nem sandbox): zero resíduo criado.

## Veredito: BLOCKED por gap de wiring (BOLETO não existe no adapter real)

- O critério de aceite exige charge com `billingType BOLETO` **via nossa API** (`ASAAS_ADAPTER=real`).
- O código em `main` só sabe criar cobrança **PIX** no provider:
  - `apps/api/src/billing/asaas-port.ts:587` — `RealAsaasAdapter.createPixCharge` monta o body com `billingType: "PIX"` **hardcoded**;
  - `apps/api/src/billing/asaas-port.ts` — único `grep billingType` em `apps/api/src` retorna só as linhas 11 (doc) e 587; não existe `createBoletoCharge` nem parâmetro de `billingType` em nenhum método do `AsaasPort`;
  - `apps/api/src/billing/billing.commands.ts:180-191` — `chargeCreateInput` aceita `paymentMethod` (string livre, default `"PIX"`), mas o handler (`:328-337`) chama **sempre** `port.createPixCharge(...)` e nunca encaminha `paymentMethod` ao provider — `paymentMethod: "BOLETO"` seria gravado só como rótulo na linha `billing.charges`, enquanto o provider receberia `billingType: "PIX"` (artefato errado para o refund-live de boleto).
- Conclusão: cumprir o aceite **exigiria mudança de código** (novo método no port + fiação no handler + inputs), fora do `WRITE_SCOPE` desta task (só este arquivo) e decisão de arquitetura do Planner. Executar o loop com PIX criaria o artefato errado + resíduo sandbox inútil — por isso PAREI antes do passo 1, sem subir lane scratch e sem chamadas live.

## Tabela passo:veredito

| Passo | Veredito | Evidência (resumida, sem segredos) |
|-------|----------|-------------------------------------|
| Gate 0 — afirmar `api-sandbox.asaas.com` antes de qualquer chamada | PASS | `%TEMP%\opencode\iptv-loopblt\env-gate0.cjs` (parse do `.env` em-processo) → `{adapter:"real", host:"api-sandbox.asaas.com", keyPresent:true, keyShape:"sandbox-shaped(redacted)", verdict:"SANDBOX_OFFICIAL"}` |
| Inspeção do contrato BOLETO no adapter real | BLOCKED | `grep billingType apps/api/src` → 2 hits (doc + hardcoded `"PIX"`); sem método/param BOLETO em `asaas-port.ts` nem `billing.commands.ts` |
| 1. register/tenant → person → provision → order → charge (scratch `-p iptv-loopblt`) | NÃO EXECUTADO (bloqueado acima) | Lane scratch **não criada** (portas 3300/3301 e 55434 continuam livres); nenhuma chamada live; zero resíduo |
| 2. Parar com charge AWAITING/confirmável + ids de retomada | NÃO APLICÁVEL | Nenhum `charge id` / `payment id` existe — nada a retomar ainda |
| 3. Não simular/reconciliar/refundar | CUMPRIDO | Zero chamadas de qualquer tipo ao provider |

## Comandos (literais sanitizados) + saídas resumidas

1. `node %TEMP%\opencode\iptv-loopblt\env-gate0.cjs` → `SANDBOX_OFFICIAL` (sem segredos; única execução).
2. `docker ps --format ...` (somente leitura) → `iptv-pilot-api/web/postgres` UP; staging/cutover intactos.
3. `grep -rn billingType apps/api/src` → `asaas-port.ts:11,587`; `grep -rn BOLETO apps/api/src` → zero hits.
4. `git log --oneline -3` → `1eeaafb / 8aef0b0 / 78dc78a`; `git status --short` → limpo (antes deste arquivo).

## Retomada (para o Planner / parte 2)

- **Opção A (recomendada se o refund-live precisa ser de BOLETO fiel):** slice de software adicionando `billingType: "BOLETO"` ao `RealAsaasAdapter` (novo método ou parâmetro opt-in, default PIX inalterado) + fiação `charge.create` → re-verificar units/integration → re-executar esta task (lane scratch `-p iptv-loopblt`, portas sugeridas 3300/3301 API e 55434 postgres, `ASAAS_ADAPTER=real`).
- **Opção B (sem código):** operador cria a cobrança BOLETO R$10 direto no dashboard sandbox (como o `pay_t2ljn53bcdnimyqn` citado no contexto) e confirma lá; nossa API entra só no webhook/reconcile/refund — esta task seria reescrita sem o passo "charge via nossa API".
- **Opção C (rebaixar o aceite):** repetir o loop com PIX via nossa API (caminho já provado em `live-loop-api.md`) — mas o artefato seria PIX, não BOLETO.

## Riscos residuais

- Nenhum resíduo sandbox ou lane local foi criado nesta task (verificado: zero chamadas).
- Comportamento sandbox ≠ produção (documentado pelo Asaas); certificação vale para sandbox.
- `paymentMethod` livre no input pode induzir leitura errada ("BOLETO" no request ≠ boleto no provider) — a Opção A deve amarrar o campo ao `billingType` real ou recusar valores não suportados.
