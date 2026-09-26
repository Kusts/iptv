# Data & Analytics Governance

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: organização da camada analítica, suas fontes canônicas e limites.

## 1. Objetivo

Transformar eventos operacionais em métricas confiáveis, análises comparáveis, experimentos reproduzíveis e decisões auditáveis.

Esta pasta **não** define regras de negócio do domínio. Regras pertencem a `docs/02-domain/`. Aqui definimos como fatos já produzidos pelo produto são medidos, atribuídos e analisados.

## 2. Fontes canônicas

| Tema | Arquivo canônico |
|---|---|
| Eventos e semântica de fatos | `../02-domain/event-model.md` |
| Tracking e classificação analítica | `tracking-plan.md` |
| Fórmulas e definições de métricas | `metric-catalog.md` |
| Atribuição de aquisição/conversão | `attribution.md` |
| Coortes | `cohorts.md` |
| Experimentos | `experimentation.md` |
| Organização dos dashboards | `dashboards.md` |

## 3. Princípios

1. Evento de domínio não deve existir apenas para “alimentar dashboard”.
2. Métricas derivam de fontes autoritativas e possuem versão/owner.
3. Atribuição preserva touchpoints brutos antes de aplicar um modelo.
4. Coortes não podem mudar silenciosamente depois de formadas.
5. Correlação não vira policy automaticamente.
6. Experimento só conta exposição quando o tratamento foi realmente apresentado/aplicado.
7. Dados financeiros usam ledger/Orders/Payments como base, não eventos de UI.
8. Dashboard não pode inventar definição própria de métrica.
9. PII deve ser minimizada na camada analítica.
10. Toda mudança semântica incompatível exige nova versão ou migração explícita.

## 4. Camadas de dados

```text
Operational Sources
    ↓
Domain Events / Ledgers / Snapshots
    ↓
Validated Analytics Events
    ↓
Semantic Metrics Layer
    ↓
Cohorts / Attribution / Experiments
    ↓
Dashboards / Insights / Learning
```

## 5. Classes de dados

### Domain-critical
Fatos que representam mudança real de negócio.

Exemplos:

- `payment.confirmed.v1`;
- `order.settled.v1`;
- `subscription.renewed.v1`;
- `referral.confirmed.v1`.

### Analytics
Observações úteis para análise que não comandam estado crítico.

Exemplos:

- exposição de experimento;
- visualização de oferta;
- scroll/click de landing quando realmente necessário.

### Integration
Entradas externas antes de normalização.

Exemplos:

- webhook bruto do Asaas;
- payload do WhatsApp;
- sync de spend de Ads.

### Operational telemetry
Logs, traces e métricas técnicas.

Exemplos:

- latência do browser;
- retry de selector;
- duração de chamada LLM.

Não devem ser confundidos com eventos de domínio.

## 6. Auto-revisão aplicada

Revisado para:

- preservar autoridade do Event Model;
- impedir duplicação entre métricas e dashboards;
- separar analytics de telemetria;
- separar atribuição de plataforma de atribuição canônica do negócio;
- manter compatibilidade com multi-tenancy e future SaaS metering.
