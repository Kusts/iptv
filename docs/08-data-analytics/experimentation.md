# Experimentation Framework

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Autoridade: processo mínimo para transformar hipótese em evidência antes de alterar policies comerciais relevantes.

## 1. Objetivo

Evitar que o Business Learning Engine transforme correlação, ruído ou amostra pequena em mudança automática de preço, reward, mensagem, campanha ou eligibility.

## 2. Fluxo oficial

```text
Observation
↓
Insight
↓
Hypothesis
↓
Experiment Design
↓
Assignment
↓
Exposure
↓
Outcome Collection
↓
Analysis
↓
Decision
↓
Rollout / Reject / Iterate
```

## 3. Experiment record

Todo experimento precisa declarar antes de iniciar:

```text
experiment_id
name
owner
hypothesis
population
exclusions
unit_of_randomization
variants
allocation
assignment_version
exposure_event
primary_metric
secondary_metrics
guardrail_metrics
minimum_evidence_rule
planned_duration
start_at
stop_conditions
risk_class
approval_required
```

## 4. Assignment versus Exposure

`experiment.assigned.v1` significa que o sujeito foi alocado.

`experiment.exposed.v1` significa que o tratamento realmente chegou ao sujeito.

Análise principal deve ser explícita sobre:

- intent-to-treat por assignment;
- exposed analysis quando apropriado.

Não misturar silenciosamente.

## 5. Unit of randomization

Preferência:

- `Person` para aquisição/Trial;
- `Customer` para retention/reward;
- `Conversation` apenas em experimentos de interação que não contaminem Customer;
- `Tenant` para features SaaS que alterem toda a operação.

Uma mesma Person/Customer deve permanecer na mesma variante durante o experimento, salvo desenho explicitamente diferente.

## 6. Stable assignment

Assignment deve usar algoritmo determinístico/versionado, por exemplo hash de:

```text
experiment_id + subject_id + assignment_version
```

Evita trocar variante entre sessões.

## 7. Tipos de experimento previstos

### Sales

- mensagem/ordem de argumentos;
- oferta autorizada;
- timing de follow-up.

### Trial

- follow-up timing;
- onboarding sequence;
- orientação de instalação.

Nunca sacrificar technical validation apenas para elevar conversion.

### Referral

- momento do ask;
- reward type;
- threshold;
- gift pass versus desconto.

Atenção a network spillover: uma variante pode influenciar terceiros.

### Retention / Winback

- Trust Renewal timing/context analysis (provider capability remains fixed; not an experimental duration);
- discount;
- referral challenge;
- app reward;
- gift pass.

### Growth

- creatives;
- audience;
- landing variation;
- bidding/budget dentro de limites de risco.

## 8. Métricas

Todo experimento deve ter:

### Primary metric
A principal decisão.

### Secondary metrics
Explicam comportamento.

### Guardrails
Protegem contra otimização destrutiva.

Exemplo:

```text
Hypothesis:
App premium como reward aumenta Referral Conversion.

Primary:
REF-04 Referral Conversion

Secondary:
REF-02 Invite Rate
REF-05 Referrals per Advocate

Guardrails:
FIN-04 Contribution Margin
SUP-02 Resolution Time
RET-04 90d Retention quando maduro
```

## 9. Evidence and sample

O sistema não deve declarar vencedor apenas porque uma variante está temporariamente acima.

A SPEC analítica futura definirá método estatístico, mas os requisitos mínimos são:

- tamanho mínimo planejado ou regra de evidência;
- janela mínima;
- análise de SRM/assignment integrity;
- população/exclusions congeladas;
- treatment effects com incerteza;
- não fazer p-hacking/peek-and-stop oportunista.

## 10. Early stopping

Permitido quando:

- guardrail crítico viola limite de segurança;
- fraude/abuso significativo;
- erro técnico;
- policy/compliance problem;
- tratamento claramente prejudicial segundo regra previamente definida.

Não parar apenas porque “já parece estar ganhando”.

## 11. Pricing / discount experiments

Exigem proteção adicional:

- approval humano;
- price floor/margin floor;
- população e período claros;
- nunca inventados pelo Agent;
- compliance/fairness review quando necessário.

## 12. Referral experiments

Precisam observar:

- reward cost real;
- delayed cost de Reward recorrente;
- fraud;
- downstream retention/LTV;
- spillover/network effects.

Uma tela adicional gratuita por vários ciclos possui custo recorrente e deve entrar como guardrail econômico acumulado.

## 13. Experiment lifecycle events

Usar somente eventos existentes:

```text
experiment.created.v1
experiment.started.v1
experiment.assigned.v1
experiment.exposed.v1
experiment.outcome_recorded.v1
experiment.completed.v1
experiment.stopped.v1
```

Policy change posterior é decisão separada e auditada.

## 14. Business Learning Engine integration

```text
Business Learning
↓
Insight
↓
Suggested Hypothesis
↓
Human/Policy Review
↓
Experiment
```

O Learning Engine pode sugerir, mas não promover automaticamente mudança comercial relevante.

## 15. Auto-revisão aplicada

Revisado para:

- separar assignment de exposure;
- impedir early stopping oportunista;
- incorporar guardrails econômicos;
- tratar referral/network effects;
- considerar custo recorrente de Reward de conexão;
- manter Agent fora da autorização de preços/descontos.
