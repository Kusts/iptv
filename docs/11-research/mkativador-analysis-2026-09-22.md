# Research Evidence — MK Ativador / AtiveAPP — 2026-09-22

> Classification: external/public supplier evidence snapshot; not canonical business policy.  
> Review: Auto-reviewed v0.14 — provenance retained; commercial/product rules must be taken from Domain/SPEC, not this snapshot.

---

# Análise completa — https://mkativador.com/#apps

> Documento gerado em 2026-09-22 para dar contexto total a outro agente.
> Fonte primária: renderização real do site + bundle JS + API pública + busca web.
> URL pedida: `https://mkativador.com/#apps` (âncora `#apps` = seção "Aplicativos Disponíveis").

## 1. Visão geral

- **Título da aba:** `Ative App Mídias`
- **O que é:** loja de **ativação/licença de aplicativos players de mídia (IPTV)** para Smart TV / TV Box. Não vende conteúdo (canais/filmes/séries/playlists), só a licença do app.
- **Domínios/espelhos do mesmo produto (mesmo front, mesmo título):**
  - `https://mkativador.com/` (alvo pedido)
  - `https://ativeapps.com/` (renderizou 100% nos testes — usar como referência)
  - `https://magoativador.com/`
  - `https://www.ativeapp.com/index/mkativador` / `/index/ativeapps` / `/index/marioativa`
  - `https://ativarapp.com.br/`
  - Loja irmã citada na busca: `https://www.ativeapp.store/` ("Mais de 150 apps: IBO Player, IBO Pro, VU Player Pro, Ninja Player")
- **Idioma:** `pt-BR` (`<html lang="pt-BR">`, `localStorage: ative.lang=pt-BR`)
- **Roteamento por `parametro`:** a landing usa rota `/index/:parametro`. Para este site, `parametro = mkativador`.
- **Aviso legal recorrente (modal + seção):** "NÃO VENDEMOS O CONTEÚDO DOS APLICATIVOS", "período de teste gratuito de 7 dias", "funcionamento depende de playlist", "aceite Termos de Uso + Privacidade + Cookies".

## 2. Stack técnica detectada

- **SPA React + Vite.** `index.html` quase vazio: só `<div id="root"></div>` + bundle.
  - CSS: `/assets/index-KeGw74YG.css` (~158 KB)
  - JS entry: `/assets/index-qk_3eNwJ.js` (mapa Vite com ~140 lazy chunks)
  - Fonte: Inter (Google Fonts, pesos 300–800)
  - Libs no bundle: `react-vendor`, `radix-ui`, `react-query`, `charts`, `forms`, `axios` (wrapper `Ze.create`), `sonner` (toasts), `input-otp`, `dayjs`, `supabase storage` (imagens), `bubble.io CDN` (imagens legadas)
- **Tema claro/escuro:** script inline lê `localStorage.theme`, classes `light/dark`, `colorScheme`.
- **Redirect legado:** se `hostname === "new.ativeapp.com"` → `https://www.ativeapp.com + path + query + hash`.
- **API base (achada no bundle):** `https://api.ativeapp.com/` via `Ze.create({baseURL})` + interceptor que injeta auth (`fD()`, `localStorage`).
- **Imagens:** `//d690eca1cc598e984c14889e63f8a117.cdn.bubble.io/...` (legado) e `https://eelbsrenwvjazertgdok.supabase.co/storage/v1/object/public/ativeapp/...` (novo).
- **Observação de automação:** em browser headless o entry JS às vezes aparece com 0B no log de rede e a seção `#apps` fica em skeleton `animate-pulse` ("Carregando seus aplicativos e dados de acesso…") porque a lista vem da API. Chamada direta server-side (sem CORS) funciona.

## 3. Estrutura da landing (ordem real do DOM)

IDs de seção encontrados: `#root, #hero, #apps, #sobre, #faq` (+ modais Radix `radix-_r_*`).

1. **Header/nav:** `Início | Aplicativos | FAQ | Sugerir App | Minhas Ativações | Login` + selo `Ativações instantâneas 24/7`
2. **#hero:**
   - `Ative seus Aplicativos de Mídia`
   - `Ativação rápida e segura para os principais players de IPTV. Suporte para LG, Samsung, Roku, Apple TV e muito mais.`
   - CTAs: `Ativar Agora` (→ `#apps`), `Minhas Ativações`
3. **Faixa de confiança (5 cards):**
   - `Top 10 Mais Vendidos`
   - `Ativação Instantânea — Seu aplicativo é ativado imediatamente após a confirmação do pagamento. Sem espera.`
   - `100% Seguro — Pagamentos processados de forma segura.`
   - `Suporte 24/7`
   - `Multi-Plataforma — Compatível com LG, Samsung, Roku, Apple TV e Android TV.`
   - `Garantia Total — Satisfação garantida ou seu dinheiro de volta.`
4. **#apps (o alvo do pedido):**
   - Badge `A - Z Apps`, H2 `Aplicativos Disponíveis`, subtítulo `Selecione o aplicativo que deseja ativar`
   - Busca: `Buscar aplicativo por nome...`
   - Grid responsivo: `1 col (mobile) / 2 (sm) / 3 (md) / 4 (lg) / 5 (xl)` com cards (logo 112px, nome, tipo licença, preço, botões)
   - Card abre **modal de detalhes** (logo, `banner_1_link`, `banner_2_link`, preço, FAQ pós-compra) → **modal de ativação** → **modal de pagamento**
   - ⚠️ Sem JS/API a grade mostra só skeletons `animate-pulse` (10 placeholders vistos no teste)
5. **Aviso:** `⚠ Importante — Não vendemos nenhum tipo de conteúdo de mídia. Somos uma equipe que faz somente ativações de aplicativos de mídias, não vendemos e não revendemos nenhum conteúdo nada relacionado a iptv ou p2p ou ott.`
6. **#sobre — Sobre nós / Quem somos?:**
   - `Somos uma empresa prestadora de serviços e aqui você irá encontrar tal como: ativações de aplicativos de mídias que são encontrados nas televisões smart e android, nossa intenção é em um site apenas ter a ativação de todos os aplicativos assim unificando tudo em apenas um lugar deixando uma coisa mais simplificada; NÃO VENDEMOS conteúdo de mídias como canais, filmes e séries.`
   - `Temos uma equipe formada trabalhando das 08:30 às 23:00 de segunda à sábado para atender todas as solicitações de ativações de aplicativo, as atividades é ativar e notificar cada um usuário das ativações solicitadas por eles.`
   - Contato: `Email frftech2023@gmail.com`
7. **#faq — FAQ / Perguntas Frequentes (8 perguntas visíveis no DOM):**
   1. `Como ativar um aplicativo?`
   2. `Se eu errar o Mac ou o key dando as informações?`
   3. `Vocês vendem o conteúdo do aplicativo? como canais filmes e séries?`
   4. `A ativação é imediata?`
   5. `Vocês tem planos de revendedor?`
   6. `Posso solicitar o reembolso?`
   7. `Vou ter suporte em duvidas do aplicativo?`
   8. `Quero indicar um aplicativo para acrescentar na loja, como faço?`
   - Respostas completas ficam em chunk i18n (`pt-BR-hhlUji2g.js` / namespace `landing`); modal de detalhe tem FAQ próprio: `afterPurchaseQuestion`, `sellContentQuestion (highlighted)`, `instantQuestion`, `notifyQuestion`.
8. **Rodapé:** `Termos de Uso | Privacidade | Cookies | Contato`, `© 2026 AtiveAPP Mídias. Todos os direitos reservados.`, botão `Fale conosco`
9. **Modal de consentimento (primeira visita):**
   - `Fale conosco / Antes de prosseguir / ATENÇÃO: NÃO VENDEMOS O CONTEÚDO DOS APLICATIVOS!`
   - Texto: site oferece ativação de apps LG/Samsung/Roku/Philips, teste grátis 7 dias, precisa de playlist, só ativação.
   - Checkbox implícito: `Termos de Uso, Políticas de Privacidade, Políticas de Cookies` + `Não concordo / Concordo / Close`

## 4. Fluxo de compra/ativação (para o agente entender o funil)

1. Usuário busca app no `#apps` → clica card → modal detalhes (`appDetailsModal.title`, banners, `common.licenseAnnual/Lifetime`).
2. Clica ativar → modal `activateModal`: pede conforme flags do app (ver §6):
   - padrão: `MAC` (com `macFormatHint`, normalizado por `hr()`),
   - `is_device_id=true`: `Device ID`,
   - `clouddy=true`: `email + password`,
   - `mac_e_key=true`: `MAC + Key`,
   - `coringa=true`: ver IBO (abaixo).
3. Modal pagamento `paymentModal`: método `pix` (sempre) e `card` (só quando `parametro` vazio/loja própria — lógica `kr()`); resumo `paymentModal.summary/total`; CPF obrigatório ou opcional conforme loja (`cpfRequiredHint/cpfSaveHint`, validação `Ke/Ie`); aceite de 3 termos (`term1/2/3`); gera `qr_code`/`qr_code_base64` (Pix copia-e-cola) ou `url` (cartão, abre nova aba); polling de confirmação com countdown `MM:SS` (`waitingPayment/waiting`), tela `confirmedTitle/confirmedDesc`.
4. Pós-pagamento: toasts `sonner`, invalidação de queries `react-query` (`store-activation`, `me`, etc.), registro em `Minhas Ativações`, erro de front logado em `POST /front-end-errors`.

## 5. Catálogo `#apps` — dados reais da API (2026-09-22)

- **Endpoints públicos descobertos no chunk `useAplicationsHooks-D9eSyLcN.js`:**
  - `GET https://api.ativeapp.com/apps/store?parametro=mkativador` → **175 apps** (testado, JSON válido)
  - `GET https://api.ativeapp.com/apps/store/domain?dominio=mkativador.com` → mesmos 175 apps
  - Admin (requer auth): `GET /apps`, `PUT /apps/:id`, `PUT /apps/bulk-by-value`
- **Resumo de preços (anual; `valor_vitalicio` quase sempre null):**
  - `R$ 15 → 48 apps | R$ 20 → 124 apps | R$ 25 → 2 apps (CLOUDDY, HOT IPTV) | vitalícia → 1 app (SET IPTV = R$ 80 vitalícia, sem anual)`
- **Campos por app:** `id (uuid), created_at, nome, valor_anual, valor_vitalicio, banner_1_link, banner_2_link, logo, ordem, aplicativos_detalhes {coringa, licenca, mac_e_key, clouddy, is_device_id}`
- **Apps famosos para smoke test:** `IBO PLAYER, IBO PLAYER PRO, IBO PRO PLAYER, BOB PLAYER, DUPLEX PRO, VU PLAYER PRO, NINJA PLAYER, SMARTONE PRO, TIVIMATE, HOT IPTV, CLOUDDY`

### 5.1 Lista completa (ordem A–Z, `nome | anual | vitalícia | flags`)

```text
9XTREAM 4K PLAYER | anual=20 | vitalicio=None | flags=
A PLUS PLAYER | anual=15 | vitalicio=None | flags=licenca
ABE PLAYER | anual=20 | vitalicio=None | flags=
AI PLAYER | anual=20 | vitalicio=None | flags=licenca
ALL PLAYER | anual=20 | vitalicio=None | flags=
ARABISK PLAYER | anual=15 | vitalicio=None | flags=licenca
ASSIST PLUS | anual=20 | vitalicio=None | flags=licenca
BAY IPTV | anual=20 | vitalicio=None | flags=
BAYTVPRO | anual=20 | vitalicio=None | flags=licenca
BIG PLAYER | anual=20 | vitalicio=None | flags=licenca
BLINK PLAYER | anual=15 | vitalicio=None | flags=licenca
BOB PLAYER | anual=20 | vitalicio=None | flags=
BOB PREMIUM | anual=20 | vitalicio=None | flags=
BOB PRO | anual=20 | vitalicio=None | flags=
BOX LITE | anual=20 | vitalicio=None | flags=licenca
BOX PLAYER | anual=20 | vitalicio=None | flags=licenca
BOX PRIME | anual=20 | vitalicio=None | flags=licenca
CAP PLAYER | anual=20 | vitalicio=None | flags=
CLOUDDY | anual=25 | vitalicio=None | flags=licenca,mac_e_key,clouddy
CONECTADOS TV | anual=15 | vitalicio=None | flags=licenca
CORE PLAYER | anual=20 | vitalicio=None | flags=licenca
CR7 PLAYER | anual=20 | vitalicio=None | flags=
DHUB IPTV | anual=15 | vitalicio=None | flags=licenca
DIRETV PLAY | anual=15 | vitalicio=None | flags=licenca
DONTV | anual=15 | vitalicio=None | flags=licenca
DREAM TV | anual=20 | vitalicio=None | flags=licenca
DTV SOL | anual=15 | vitalicio=None | flags=licenca
DUPLECAST IPTV | anual=20 | vitalicio=None | flags=
DUPLEX MAX | anual=20 | vitalicio=None | flags=licenca
DUPLEX PLUS | anual=15 | vitalicio=None | flags=licenca
DUPLEX PRO | anual=20 | vitalicio=None | flags=is_device_id
DUPLEXTV PLAYER | anual=20 | vitalicio=None | flags=
EASY PLAYER | anual=20 | vitalicio=None | flags=licenca
EGO IPTV | anual=20 | vitalicio=None | flags=licenca
ENZO PLAYER | anual=20 | vitalicio=None | flags=
EPIC PLAY | anual=20 | vitalicio=None | flags=licenca
FAMILY 4K | anual=20 | vitalicio=None | flags=
FAST PLAYER | anual=20 | vitalicio=None | flags=
FENIX PLAYER | anual=20 | vitalicio=None | flags=licenca,mac_e_key
FLIX PRO PLAYER | anual=20 | vitalicio=None | flags=
FLIX TV PLAY | anual=15 | vitalicio=None | flags=licenca
FLIXNET PLAYER | anual=20 | vitalicio=None | flags=
FLIXTRA PLAYER | anual=20 | vitalicio=None | flags=licenca
FOCO XPLAY | anual=20 | vitalicio=None | flags=licenca
FUN PLAY | anual=20 | vitalicio=None | flags=
GALAXY TV | anual=15 | vitalicio=None | flags=licenca
GRAVITY PLAYER | anual=20 | vitalicio=None | flags=is_device_id
GREEN PLAYER | anual=15 | vitalicio=None | flags=licenca
GTV PLAYER | anual=20 | vitalicio=None | flags=mac_e_key
HD PLAYER | anual=20 | vitalicio=None | flags=
HOME IPTV | anual=15 | vitalicio=None | flags=licenca
HOT IPTV | anual=25 | vitalicio=None | flags=
HQ PLAYER | anual=20 | vitalicio=None | flags=licenca
HUSHPLAY | anual=20 | vitalicio=None | flags=
IB PLAYER | anual=20 | vitalicio=None | flags=
IB PLAYER PRO | anual=20 | vitalicio=None | flags=
IBO PLAYER | anual=20 | vitalicio=None | flags=coringa
IBO PLAYER PRO | anual=20 | vitalicio=None | flags=coringa
IBO PLAYER PRO (ibosol) | anual=20 | vitalicio=None | flags=
IBO PLAYER SMARTER | anual=15 | vitalicio=None | flags=
IBO PRO PLAYER | anual=20 | vitalicio=None | flags=
IBO SMARTERS | anual=15 | vitalicio=None | flags=
IBO STB | anual=20 | vitalicio=None | flags=
IBO VPN PLAYER | anual=20 | vitalicio=None | flags=
IBO XPLAYER | anual=20 | vitalicio=None | flags=
IBOSOL PLAYER | anual=20 | vitalicio=None | flags=
IBOSS IPTV | anual=20 | vitalicio=None | flags=
ION PLAYER | anual=15 | vitalicio=None | flags=licenca
IPTV 4K | anual=20 | vitalicio=None | flags=licenca
IPTV DUPLEX PLAY | anual=20 | vitalicio=None | flags=
IPTV ENTERTAINMENT | anual=15 | vitalicio=None | flags=
IPTV IBO PLAYER | anual=20 | vitalicio=None | flags=
IPTV NEXT | anual=20 | vitalicio=None | flags=licenca
IPTV OTT PLAYER | anual=20 | vitalicio=None | flags=licenca
IPTV PLAY | anual=20 | vitalicio=None | flags=licenca
IPTV PLAYER | anual=20 | vitalicio=None | flags=licenca
IPTV PLAYER - SMART PRO TV | anual=20 | vitalicio=None | flags=licenca
IPTV PLAYER - SMART PRO TV | anual=20 | vitalicio=None | flags=licenca
IPTV PLAYERIO | anual=20 | vitalicio=None | flags=licenca
IPTV PLUS | anual=20 | vitalicio=None | flags=licenca
IPTV PRO | anual=20 | vitalicio=None | flags=licenca
IPTV PRO PLAYER | anual=20 | vitalicio=None | flags=
IPTV SMART 4K PLAYER | anual=20 | vitalicio=None | flags=
IPTV SMARTER 4K PLAYER | anual=20 | vitalicio=None | flags=
IPTV SMARTERS | anual=15 | vitalicio=None | flags=licenca
IPTV SMARTERS  | anual=20 | vitalicio=None | flags=
IPTV SMARTERS LITE | anual=20 | vitalicio=None | flags=
IPTV XTREAM PLAYER | anual=20 | vitalicio=None | flags=
iptvactivation.com | anual=20 | vitalicio=None | flags=licenca
IPTVSmartersPlayer | anual=20 | vitalicio=None | flags=
ITELSMARTER PLAYER | anual=15 | vitalicio=None | flags=licenca
KEMET TV | anual=20 | vitalicio=None | flags=is_device_id
KIDS PLAY | anual=15 | vitalicio=None | flags=licenca
KING 4K | anual=20 | vitalicio=None | flags=
KING 4K OTT PLAYER | anual=15 | vitalicio=None | flags=licenca
KIWI 4K PLAYER | anual=15 | vitalicio=None | flags=licenca
KTN | anual=20 | vitalicio=None | flags=
LAXY PLAYER | anual=15 | vitalicio=None | flags=licenca
LAZER PLAY | anual=20 | vitalicio=None | flags=licenca
LUMINA PLAYER | anual=20 | vitalicio=None | flags=licenca
M3U IPTV PLAYER | anual=15 | vitalicio=None | flags=licenca
MAC MEDIA PLAYER | anual=20 | vitalicio=None | flags=
MAGIC PLAYER | anual=20 | vitalicio=None | flags=
MAX MEDIA PLAYER | anual=15 | vitalicio=None | flags=licenca
MCV PLAYER | anual=15 | vitalicio=None | flags=licenca
MESSITV | anual=20 | vitalicio=None | flags=
META PLAYER | anual=20 | vitalicio=None | flags=licenca
MIKA PLAYER | anual=20 | vitalicio=None | flags=licenca
MIROPLAYER | anual=15 | vitalicio=None | flags=licenca
MULTI PLAY | anual=15 | vitalicio=None | flags=licenca
NINJA PLAYER | anual=20 | vitalicio=None | flags=licenca,mac_e_key
NINJA PLUS | anual=20 | vitalicio=None | flags=licenca,mac_e_key
NUBIA TV | anual=15 | vitalicio=None | flags=licenca
NUM PLAYER | anual=15 | vitalicio=None | flags=licenca
ORA IPTV PLAYER | anual=20 | vitalicio=None | flags=is_device_id
ORA PLAYER | anual=20 | vitalicio=None | flags=licenca
ORA PRO | anual=20 | vitalicio=None | flags=is_device_id
ORION PLAY | anual=20 | vitalicio=None | flags=licenca
OTT PLAY | anual=15 | vitalicio=None | flags=licenca
PLAYSIM | anual=20 | vitalicio=None | flags=
POP PLAYER | anual=15 | vitalicio=None | flags=licenca
POWER PLAY | anual=20 | vitalicio=None | flags=
PRO PLAYER | anual=20 | vitalicio=None | flags=licenca
QPLAY | anual=20 | vitalicio=None | flags=licenca
QUEEN TV | anual=15 | vitalicio=None | flags=licenca
QUICK PLAY BLACK | anual=20 | vitalicio=None | flags=licenca
QUICK PLAYER | anual=20 | vitalicio=None | flags=licenca
QUICK PLAYER PRO | anual=20 | vitalicio=None | flags=licenca
QUICKPLAYER+ | anual=20 | vitalicio=None | flags=mac_e_key
RIEN TV STAR | anual=15 | vitalicio=None | flags=licenca
RIVOLUT PLAYER | anual=20 | vitalicio=None | flags=
RV PLAYER | anual=20 | vitalicio=None | flags=
SCANDIC IPTV PLAYER | anual=20 | vitalicio=None | flags=licenca
SET IPTV | anual=None | vitalicio=80 | flags=
SHAMEL TV | anual=20 | vitalicio=None | flags=
SIMPLE PRO | anual=20 | vitalicio=None | flags=licenca
SKY PLAY PLUS | anual=15 | vitalicio=None | flags=licenca
SMART IPTV PLAY | anual=15 | vitalicio=None | flags=licenca
SMART IPTV PLAYER | anual=20 | vitalicio=None | flags=
SMART IPTV PLAYER PRO | anual=20 | vitalicio=None | flags=licenca
SMART LIVE TV | anual=20 | vitalicio=None | flags=
SMARTERS IPTV PLAYER | anual=20 | vitalicio=None | flags=
SMARTERS MAX | anual=20 | vitalicio=None | flags=
SMARTERS VPN PLAYER | anual=20 | vitalicio=None | flags=
SMARTONE IPTV | anual=20 | vitalicio=None | flags=
SMARTONE PRO | anual=20 | vitalicio=None | flags=
SPORTS TV | anual=15 | vitalicio=None | flags=licenca
STAR IPTV | anual=20 | vitalicio=None | flags=licenca
STREAM MEDIA PLAYER | anual=20 | vitalicio=None | flags=
STREAM XTREAM | anual=20 | vitalicio=None | flags=
SUPER PLAY | anual=20 | vitalicio=None | flags=licenca
TELEVIZO IPTV PLAYER | anual=20 | vitalicio=None | flags=
TERRY IPTV | anual=15 | vitalicio=None | flags=licenca
TERRY PLAYER | anual=15 | vitalicio=None | flags=licenca
TEVIS TV | anual=15 | vitalicio=None | flags=licenca
TIVI PLAYER | anual=20 | vitalicio=None | flags=licenca
TIVIMATE | anual=20 | vitalicio=None | flags=
TVIP PLAYER | anual=20 | vitalicio=None | flags=licenca
TVOYATV | anual=15 | vitalicio=None | flags=licenca
UK IPTV 4K | anual=15 | vitalicio=None | flags=licenca
ULTRA PLAYER | anual=20 | vitalicio=None | flags=
UN TV PLAYER | anual=15 | vitalicio=None | flags=licenca
VIP | anual=15 | vitalicio=None | flags=licenca
VIRGINIA PLAYER | anual=20 | vitalicio=None | flags=
VIVO PLAYER | anual=20 | vitalicio=None | flags=
VIZZION PLAY | anual=20 | vitalicio=None | flags=licenca
VU PLAYER PRO | anual=20 | vitalicio=None | flags=
VUX PLAYER | anual=15 | vitalicio=None | flags=licenca
WORLD VISION IPTV | anual=15 | vitalicio=None | flags=licenca
X CLOUD | anual=20 | vitalicio=None | flags=is_device_id
XENDLY 4K IPTV PLAYER | anual=20 | vitalicio=None | flags=
XTREAMUITV | anual=15 | vitalicio=None | flags=licenca
YOU TIVI | anual=20 | vitalicio=None | flags=
YTV 4K PLAYER | anual=20 | vitalicio=None | flags=
ZEBRA PLAYER | anual=15 | vitalicio=None | flags=licenca
```

## 6. Semântica das flags `aplicativos_detalhes` (inferida do front)

- `licenca=true`: fluxo pede **licença/chave** (ex.: 48+ apps de R$ 15 usam isso).
- `mac_e_key=true`: pede **MAC + Key** (ex.: FENIX PLAYER, NINJA PLAYER/PLUS, GTV PLAYER, QUICKPLAYER+; CLOUDDY pede MAC+Key+login).
- `clouddy=true`: credencial **email+senha estilo Clouddy** (só CLOUDDY).
- `is_device_id=true`: pede **Device ID** em vez de MAC (DUPLEX PRO, GRAVITY PLAYER, KEMET TV, ORA IPTV PLAYER, ORA PRO, X CLOUD).
- `coringa=true`: **IBO PLAYER e IBO PLAYER PRO** — provável fluxo coringa/oficial IBO.
- Sem flag: fluxo MAC padrão.

## 7. Jurídico / institucional (via busca — Termos/Privacidade AtiveAPP)

- **Razão:** ATIVE APP, CNPJ `51.850.195/0001-08`, Rua João Francisco de Almeida 339, Centro, Rio de Janeiro/RJ, CEP 28200-000 (endereço declarado nos Termos).
- **Conceitos:** Conta de Acesso (login/senha), Créditos (unidades que permitem X ativações), Cookies, LGPD.
- **Regras-chave:** só vende **ativação**; não vende/fornece playlist/mídia; usuário declara ciência disso; cooperação com autoridades; cadastro PF (nome, CPF, nascimento, endereço, telefone) / PJ (fantasia, razão, CNPJ, constituição, endereço, telefone, sócios); pode pedir documentos; dados para info de serviços, estatística, obrigação legal; compartilhamento só com operadores necessários ou por lei; **não coleta dado sensível** (declarado).
- Rotas no SPA: `/terms-of-use`, `/privacy-policy`, `/cookies-policy` (+ variantes `/index/:parametro/...`).

## 8. Como reproduzir / verificar (para o próximo agente)

1. Abrir `https://ativeapps.com/` (espelho que renderizou) ou `https://mkativador.com/#apps`; aceitar modal (`Concordo`).
2. Rolagem até `#apps`; busca `Buscar aplicativo por nome...`; grade carrega via API.
3. API direta (sem CORS, server-side):
   - `GET https://api.ativeapp.com/apps/store?parametro=mkativador`
   - `GET https://api.ativeapp.com/apps/store/domain?dominio=mkativador.com`
4. Teste de fumaça: buscar `IBO PLAYER` (R$ 20, `coringa`), `CLOUDDY` (R$ 25, `clouddy+mac_e_key+licenca`), `SET IPTV` (R$ 80 vitalícia).
5. Não tentar `POST` sem auth; endpoints `/session`, `/partner/*`, `/users/*`, `/apps` exigem login/token.
6. JSON bruto da coleta atual salvo temporariamente em `AppData\Local\Temp\opencode\apps_store.json` (175 itens) — se foi limpo, refazer passo 3.

## 9. Limitações desta análise

- Respostas completas do FAQ e textos i18n (`pt-BR-hhlUji2g.js`) não foram extraídos na íntegra — só os títulos das 8 perguntas visíveis no DOM.
- Preços podem variar por `parametro`/domínio e campanha; valores acima são snapshot de `mkativador` em 2026-09-22.
- `Top 10 Mais Vendidos` é dinâmico (API) e não foi capturado com ranking.
- Não foi feito login; área `Minhas Ativações`, `Login`, `Sugerir App`, painel `/painel`, `admin`, `partner` não foram mapeadas por dentro.
