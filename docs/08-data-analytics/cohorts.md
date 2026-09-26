# Cohort Framework

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: como formar e comparar populações ao longo do tempo.

## 1. Objetivo

Evitar análises enganosas causadas por misturar Customers com idades, origens ou condições diferentes.

## 2. Princípio

> Uma coorte deve possuir evento de entrada claro e membership reproduzível.

A dimensão de segmentação pode mudar, mas o evento que formou a coorte não deve ser reescrito silenciosamente.

## 3. Coortes canônicas

### 3.1 Lead Creation Cohort

Entrada:

```text
lead.created.v1
```

Uso:

- Lead → Trial;
- Lead → Paid;
- sales cycle.

### 3.2 Trial Activation Cohort

Entrada:

```text
trial.activated.v1
```

Uso:

- technical pass;
- time to playback;
- Trial → Paid.

Separar:

- first Trial;
- legitimate Retrial.

### 3.3 First Paid Cohort

Entrada:

primeiro `order.settled.v1` de subscription adquirido economicamente.

Uso:

- retention;
- LTV;
- payback;
- churn;
- referral behavior.

### 3.4 Subscription Activation Cohort

Entrada:

```text
subscription.activated.v1
```

Uso operacional quando fulfillment/activation pode ocorrer depois do settlement.

### 3.5 Churn Cohort

Entrada:

```text
customer.churned.v1
```

Uso:

- winback;
- recovery strategy;
- time-to-reactivation.

### 3.6 Referral Advocate Cohort

Entrada:

primeiro momento em que Customer se torna elegível ou cria Referral, conforme análise.

Uso:

- asks;
- invites;
- confirmed referrals;
- rewards;
- K-factor operacional.

## 4. Dimensões permitidas

Aplicáveis conforme disponibilidade:

- Primary Acquisition Channel;
- campaign/creative;
- referral versus paid versus organic;
- plan;
- billing interval;
- coupon/promotion use;
- device class/model;
- app;
- ISP/network class;
- initial server;
- Trial type/duration;
- technical outcome;
- tenant.

## 5. Dimensões históricas versus atuais

Distinguir:

```text
Acquisition Plan
Current Plan
Initial App
Current App
Initial Server
Current Server
```

Não analisar retention por “server inicial” usando silenciosamente server atual.

## 6. Maturity

Coortes recentes não possuem tempo suficiente para 90d/180d/365d retention.

Dashboard deve marcar:

```text
MATURE
PARTIALLY_MATURE
IMMATURE
```

por métrica/janela.

Nunca comparar 90-day retention de uma coorte com apenas 30 dias de idade.

## 7. Survival / incomplete outcomes

Leads recentes ainda podem converter; Trials recentes ainda podem pagar.

Por isso:

- conversion deve mostrar maturity window;
- evitar comparar coortes com janelas de observação diferentes sem normalização;
- futuras análises podem usar survival methods, mas não são requisito do MVP.

## 8. Cohort economic view

Para First Paid Cohort acompanhar cumulativamente:

```text
Revenue
COGS
Contribution
CAC
Reward Cost
Support Cost
Refunds
LTV observed
Payback
```

Isso permite comparar qualidade econômica real de Referral, Ads e Organic.

## 9. Add-on cohort analysis

Para additional connections, criar análises por:

- cohort de ativação do add-on;
- duração ativa;
- recurring revenue;
- recurring COGS;
- cancellation rate;
- rewarded versus paid.

Um Reward de tela extra permanente não deve parecer barato apenas no mês da concessão.

## 10. Auto-revisão aplicada

Revisado para:

- separar first paid de subscription activation;
- impedir leakage de atributos atuais em análise histórica;
- incorporar maturidade de coorte;
- tratar Retrial separadamente;
- calcular custo recorrente de conexão adicional ao longo do tempo.
