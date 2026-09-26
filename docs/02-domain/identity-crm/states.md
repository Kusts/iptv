# Identity & CRM — State Machines

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Domínio: D02 — Identity & CRM

## 1. Decisão de modelagem

`Person`, `Lead` e `Customer` não são três cópias da mesma pessoa.

- `Person` é a identidade canônica e não possui um lifecycle comercial terminal.
- `Lead` representa uma oportunidade/relação pré-compra.
- `Customer` representa relação comercial ativa ou histórica.
- Uma `Person` pode ser Customer e voltar a gerar uma nova oportunidade comercial sem perder histórico.

Por isso há **duas máquinas ortogonais**.

## 2. Lead Lifecycle

Estados:

```text
NEW
CONTACTED
QUALIFIED
ENGAGED
OFFERED
CONVERTED
NURTURE
LOST
DISQUALIFIED
```

### Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `lead.created.v1` | NEW | Person identificada como oportunidade |
| NEW | `lead.contacted.v1` | CONTACTED | houve contato útil |
| CONTACTED | `lead.qualified.v1` | QUALIFIED | critérios mínimos atendidos |
| QUALIFIED | `lead.engaged.v1` | ENGAGED | interesse/engajamento suficiente |
| ENGAGED | `offer.presented.v1` | OFFERED | oferta válida apresentada |
| OFFERED | `order.settled.v1` | CONVERTED | primeira compra confirmada |
| NEW/CONTACTED/QUALIFIED/ENGAGED/OFFERED | `lead.nurture_started.v1` | NURTURE | sem conversão imediata, relacionamento continua |
| NURTURE | `lead.reengaged.v1` | ENGAGED | voltou a demonstrar interesse |
| NEW/CONTACTED/QUALIFIED/ENGAGED/OFFERED/NURTURE | `lead.lost.v1` | LOST | ciclo encerrado sem conversão |
| NEW/CONTACTED/QUALIFIED | `lead.disqualified.v1` | DISQUALIFIED | não elegível para oferta/serviço |
| LOST | `lead.reopened.v1` | ENGAGED | novo ciclo de oportunidade associado ao histórico |

### Invariantes

- `CONVERTED` significa conversão daquele ciclo de Lead; não significa Subscription necessariamente ativa para sempre.
- Trial não é estágio de Lead. O funil pode projetar "em trial" combinando Lead + Trial.
- Payment failure não deve mover automaticamente Lead para LOST.
- `DISQUALIFIED` requer razão estruturada.

## 3. Customer Relationship Lifecycle

Estados:

```text
ACTIVE
LAPSED
CHURNED
REACTIVATING
```

`AT_RISK` não é estado do lifecycle. É uma classificação/score derivado que pode coexistir com `ACTIVE` e alimentar workflows preventivos.

### Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `customer.activated.v1` | ACTIVE | primeira relação comercial efetivamente ativada |
| ACTIVE | `customer.lapsed.v1` | LAPSED | perdeu continuidade, mas ainda em janela de recuperação |
| LAPSED | `customer.churned.v1` | CHURNED | regra de churn confirmada |
| LAPSED/CHURNED | `customer.reactivation_started.v1` | REACTIVATING | iniciou fluxo de retorno |
| REACTIVATING | `customer.reactivated.v1` | ACTIVE | nova assinatura/acesso efetivado |
| REACTIVATING | `customer.reactivation_failed.v1` | CHURNED | tentativa encerrada sem retorno |

### Customer Health / Risk

Eventos como `customer.risk_detected.v1` e `customer.risk_cleared.v1` atualizam uma projeção/score de saúde e podem disparar automações, mas não substituem o lifecycle comercial.

O score precisa de definição objetiva no Metric/Policy Catalog; não inferir risco somente porque o Agent "acha".

## 4. Identity Linking

Identity não usa um funil comercial. Possui status simples:

```text
UNVERIFIED
VERIFIED
LINKED
DISPUTED
DETACHED
```

Transições relevantes publicam:

- `identity.created.v1`;
- `identity.verified.v1`;
- `identity.linked.v1`;
- `identity.merge_review_requested.v1`;
- `identity.detached.v1`.

Merge de Persons deve gerar uma operação auditável e reversível; não apagar a Person de origem.

## 5. Customer 360

Customer 360 é projeção e pode combinar:

```text
Lead = ENGAGED
Trial = ACTIVE
Payment = PENDING
Subscription = nenhuma
SupportTicket = nenhum
```

Nunca persistir "status geral do cliente" como substituto desses estados.

## 6. Casos excepcionais

### Pessoa já Customer gera nova compra

Não recriar Person. Criar novo Order/Subscription ou add-on conforme o caso.

### Pessoa churned pede novo serviço

Preservar Customer histórico e iniciar `REACTIVATING`.

### Merge incorreto

Executar `identity.detached.v1` / operação de unmerge mantendo trilha de auditoria.

## 7. Métricas ligadas

- Lead → Paid Conversion;
- Sales Cycle Time;
- Winback Rate;
- Customer Health;
- Referral Propensity;
- cohort retention.
