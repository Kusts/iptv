# Attribution Model

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: regras para preservar touchpoints e atribuir aquisição/conversões sem sobrescrever histórico.

## 1. Objetivo

Responder de forma consistente:

- de onde veio o Lead?;
- quais canais ajudaram?;
- qual campanha deve receber crédito operacional?;
- quanto CAC/LTV/Contribution cada origem gera?;
- quais sinais devemos enviar de volta às plataformas de Ads?

## 2. Regra principal

> Touchpoint bruto nunca é substituído por attribution calculada.

Armazenar primeiro:

```text
AcquisitionTouch
```

Depois aplicar modelos versionados.

## 3. Tipos de touch

Exemplos:

```text
PAID_META
PAID_GOOGLE
PAID_TIKTOK
REFERRAL
ORGANIC_SOCIAL
ORGANIC_SEARCH
DIRECT
CONTENT
LANDING
UNKNOWN
```

Cada touch pode guardar:

- platform;
- campaign;
- ad set/ad group;
- creative;
- click/session IDs permitidos;
- referral_id;
- landing/session;
- timestamp.

## 4. Modelos oficiais iniciais

### 4.1 First Attributable Touch

Primeiro touch não-unknown dentro da janela definida antes de `lead.created`.

Uso:

- origem inicial;
- análise de aquisição de topo de funil.

### 4.2 Last Non-Direct Touch

Último touch atribuível antes da conversão, ignorando `DIRECT` quando existe outro touch válido na janela.

Uso:

- análise comercial auxiliar.

### 4.3 Primary Acquisition Attribution

Modelo operacional canônico do MVP.

Regra inicial:

1. considerar janela pré-Lead configurada;
2. preservar todos os touches;
3. escolher o primeiro touch qualificado que realmente introduziu a Person/Lead à operação;
4. se houver Referral válido criado/atribuído antes da criação do Lead, `REFERRAL` pode ser Primary Acquisition;
5. `DIRECT` só vence quando não há outro touch atribuível confiável;
6. `UNKNOWN` nunca recebe redistribuição artificial.

Resultado é persistido/versionado como attribution calculada, sem alterar raw touches.

## 5. Referral attribution

Referral merece tratamento próprio porque possui reward econômico e risco de fraude.

Um referral só pode ser classificado como `CONFIRMED` depois das regras de qualificação do Referral Engine.

Distinções:

```text
Referral Attributed
Referral Confirmed
Primary Acquisition = Referral
Referral Assisted
```

Nem todo referral atribuído deve automaticamente substituir uma origem anterior legítima.

Exemplo:

```text
Pessoa já era Lead de Google Ads
↓
mais tarde recebe link de amigo
↓
Referral pode ser assistido/promocional
mas não necessariamente Primary Acquisition
```

Essa regra evita pagar reward/atribuir aquisição de forma incorreta.

## 6. Winback attribution

Winback não cria “novo Customer adquirido” para CAC primário.

Registrar:

```text
reactivation_source
reactivation_campaign
reactivation_referral_assist
```

separadamente de original acquisition.

## 7. Platform attribution versus business attribution

Meta/Google/TikTok possuem seus próprios modelos e janelas.

Portanto manter:

```text
Platform Reported Attribution
```

separado de:

```text
Canonical Business Attribution
```

Nunca somar conversões reportadas por plataformas como se fossem mutuamente exclusivas.

## 8. Conversion signals

Podemos produzir sinais derivados de eventos canônicos:

```text
Lead
Trial Activated
Technical Pass
Order Settled
Subscription Activated
Renewal
```

O evento exportado para Ads deve referenciar o `source_event_id` interno para auditoria e deduplicação.

## 9. Lookback windows

Janelas precisam ser configuráveis/versionadas por modelo.

Não fixar silenciosamente uma janela eterna.

Toda análise deve saber:

- attribution model version;
- lookback window;
- conversion event;
- evaluation period.

## 10. Cross-device / identity resolution

Attribution só cruza canais depois de Identity Graph possuir confiança suficiente.

Merge ambíguo não deve automaticamente unir históricos de aquisição.

Quando houver unmerge, attribution dependente deve ser recalculável.

## 11. Cost allocation

Spend é sincronizado no nível mais granular confiável:

```text
platform → campaign → adset/adgroup → creative
```

CAC por creative só é apresentado quando houver associação e volume suficientes; caso contrário usar nível superior para evitar falsa precisão.

## 12. Auto-revisão aplicada

Revisado para:

- impedir que referral “roube” origem de Lead preexistente;
- separar winback de aquisição nova;
- separar platform attribution de business attribution;
- preservar unknown em vez de redistribuir;
- preservar touchpoints brutos;
- suportar recalculação após identity merge/unmerge.
