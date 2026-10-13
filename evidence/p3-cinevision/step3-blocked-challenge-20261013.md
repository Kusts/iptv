# Fase 6 Step 3 — tentativa 2026-10-13: BLOQUEADA por challenge Cloudflare (sem bypass)

> Conta designada: main com fence (`BROWSER_WORKER_TENANT_ID=synkroo-iptv`,
> `BROWSER_WORKER_PROVIDER_ACCOUNT_ID=main`, salvos no `.env` local a pedido
> do operador). Credenciais `dev/browser-worker/*` presentes no Infisical
> (smoke 2026-10-13: login OK, 3/3 PRESENT em `dev`, 0/3 em `prod`).
> Nenhum valor de segredo lido para este arquivo.

## O que aconteceu

1. Script de sonda (`step3.mjs`, headless Chromium automatizado, sem plugins
   de stealth, sem tentativa de bypass): ao abrir `https://cinevision.panelbr.site/#/`,
   a página devolveu título **`Attention Required! | Cloudflare`**, sem
   formulário de login renderizado (0 inputs email/senha, 0 iframes de
   captcha visíveis — bloqueio na borda, antes do app).
2. Conclusão: challenge de bot-management ativo contra automação headless.
   **Nenhuma credencial foi enviada, nenhum login tentado, nenhuma leitura
   e nenhuma escrita executadas.** Contagem de clientes intocada.
3. O challenge inicial do script (regex sobre o HTML, que captura bundles)
   disparou primeiro como falso-positivo; a checagem diagnóstica com título +
   DOM confirmou o bloqueio real.

## Decisão

- STOP conforme a regra de segurança (sem bypass de anti-bot; challenges
  geram HITL) e conforme o procedimento Fase 6 (Step 3 = sessão manual
  operada por humano).
- Caminhos possíveis (dono: operador):
  a. Sessão com browser real do operador (como a sessão REA que gerou o
     dossier customers/edit) para o probe criar→deletar com fence;
  b. Janela supervisionada: operador completa o challenge num run headed
     enquanto a sonda executa os passos contratados;
  c. Nova tentativa headless em outro momento/rede (desafio pode ser
     reputacional e transiente) — sem garantia.
- O script da sonda está guardado fora do repo (sem segredos nele) para reuso
  em qualquer um dos caminhos. Nada foi commitado além deste relato.
