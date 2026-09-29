# Machine identities e migracao de secrets (Infisical — IPTV)

Contexto: ADR-0014 — Infisical centraliza secrets em producao; o banco de
dominio guarda apenas `secret_ref`. Uma machine identity por worker, com
RBAC minimo. Este guia cobre o fluxo apos o deploy do runbook.

## 1. Estrutura recomendada na instancia

- Projeto: `iptv` (um so; evita dispersao de RBAC).
- Ambientes: `production` (VPS) e opcionalmente `staging`.
- Pastas por worker/escopo: `/api`, `/browser-worker`, `/billing`, `/messaging`.
- Cada secret vive na pasta do dono (ex.: `/browser-worker/CINEVISION_USER`).

## 2. Criar uma identidade por worker

No painel (login admin), para cada worker (`api`, `browser-worker`):

1. **Identities → Create identity** (ex.: `iptv-api-prod`, `iptv-browser-worker-prod`).
2. Metodo de auth: **Universal Auth** (client-id + client-secret) — simples e
   adequado a workloads na mesma VPS. O client-secret nasce uma unica vez:
   entregue ao worker pelo canal seguro do operador (nunca Git/log).
3. **Access → Project role**: crie uma role por worker com permissao minima:
   - `iptv-api-prod`: leitura em `/api/*`, `/billing/*` (se a API reconcilia
     cobranca), `/messaging/*` (se envia); sem escrita, sem `/browser-worker/*`.
   - `iptv-browser-worker-prod`: leitura **apenas** em `/browser-worker/*`.
4. Vincule identity → role com escopo `environment: production` + pastas acima.

Validacao por worker (na VPS, sem exibir valores em log):

```sh
# Troca client-id/secret por token efemero e le UM secret como smoke test:
curl -s -X POST https://infisical.synkroo.com.br/api/v1/auth/universal-auth/login \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"...","clientSecret":"..."}' | head -c 20
# Depois: fetch via SDK/CLI do worker e confirme que NEGADO retorna 403
# em pasta fora do escopo (prova de least-privilege).
```

Criterio: leitura ok no proprio escopo + 403 fora dele + nada impresso em logs.

## 3. Migrar os primeiros secrets (padrao `secret_ref`)

Hoje CINEVISION/MK ficam no cofre do operador (AGENTS.md) — migre nesta ordem:

1. Cadastre os valores **direto no painel/CLI do Infisical** (nunca via `.env`
   do repo): `/browser-worker/CINEVISION_*`, `/browser-worker/MK_*`,
   `/billing/ASAAS_*` (quando sair do sandbox), `/messaging/WAHA_*`.
2. No banco de dominio, grave apenas a referencia, nunca o valor. Padrao:
   `secret_ref = "infisical://iptv/production/browser-worker/CINEVISION_USER"`.
3. O worker resolve a ref no boot via SDK usando sua identity e mantem o valor
   so em memoria; **nenhum log, erro ou dump pode conter o valor**
   (validacao do ADR: fetch sem exposicao em logs — teste provocando um erro
   de fetch e inspecionando a saida).
4. Remova o valor antigo do cofre transitório somente apos o worker operar
   1 ciclo completo lendo do Infisical (leitura + operacao real ou reconciliacao).

## 4. Rotation e disaster path (aceite do ADR-0014)

- **Rotation test**: rotacione 1 secret de baixo risco (ex.: webhook secret de
  staging), reinicie o worker consumidor e confirme releitura sem restart
  manual extra alem do previsto. Registre data/resultado.
- **Tenant/provider scope**: quando houver multi-tenant real, prefira pastas
  por tenant (`/tenants/<id>/...`) a projetos por tenant, salvo isolamento
  forte exigido — reavalie com o operador.
- **Restore**: banco restaurado (runbook etapa 7) + mesma `ENCRYPTION_KEY` =
  instancia funcional; valide login + 1 fetch por worker apos cada restore.
- **Revogacao**: ao desativar um worker, delete/disable sua identity primeiro;
  tokens de Universal Auth sao revogaveis sem tocar nas demais identities.
