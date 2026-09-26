# Referral & Rewards — State Machines

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Domínios: D22 — Referral; D23 — Loyalty, Gamification & Rewards

## 1. Referral Lifecycle

Estados:

```text
CREATED
ATTRIBUTED
ENGAGED
QUALIFYING
CONFIRMED
REJECTED
EXPIRED
REVERSED
```

### Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `referral.created.v1` | CREATED | vínculo/código/origem registrado |
| CREATED | `referral.attributed.v1` | ATTRIBUTED | Person indicada associada de forma válida |
| ATTRIBUTED | `referral.engaged.v1` | ENGAGED | iniciou jornada relevante |
| ENGAGED | `referral.qualification_started.v1` | QUALIFYING | condição econômica mínima em avaliação |
| QUALIFYING | `referral.confirmed.v1` | CONFIRMED | critérios de conversão/anti-abuse atendidos |
| CREATED/ATTRIBUTED/ENGAGED/QUALIFYING | `referral.rejected.v1` | REJECTED | fraude, self-referral ou inelegibilidade |
| CREATED/ATTRIBUTED/ENGAGED | `referral.expired.v1` | EXPIRED | janela expirou |
| CONFIRMED | `referral.reversed.v1` | REVERSED | conversão posteriormente invalidada conforme política |

## 2. Momento de confirmação

`CONFIRMED` não deve significar apenas clique ou cadastro.

A regra pode exigir:

- pagamento confirmado;
- ausência de fraude;
- eventual janela mínima;
- não ser self-referral;
- elegibilidade da campanha.

O critério exato pertence à Referral Policy versionada.

## 3. Reward Lifecycle

Estados:

```text
PENDING
APPROVED
ISSUED
AVAILABLE
REDEEMED
EXPIRED
REVOKED
FAILED
```

### Transições

| De | Evento | Para |
|---|---|---|
| — | `reward.pending_created.v1` | PENDING |
| PENDING | `reward.approved.v1` | APPROVED |
| APPROVED | `reward.issued.v1` | ISSUED |
| ISSUED | `reward.available.v1` | AVAILABLE |
| AVAILABLE | `reward.redeemed.v1` | REDEEMED |
| PENDING/APPROVED/ISSUED/AVAILABLE | `reward.expired.v1` | EXPIRED |
| APPROVED/ISSUED/AVAILABLE/REDEEMED | `reward.revoked.v1` | REVOKED |
| APPROVED/ISSUED | `reward.fulfillment_failed.v1` | FAILED |

## 4. Reward versus Entitlement

Reward explica **por que** o benefício existe.

O benefício pode materializar-se em:

- referral wallet credit;
- Coupon/discount;
- Order credit;
- Entitlement;
- app license;
- gift pass.

Exemplo:

```text
3 referrals confirmed
→ Reward APPROVED
→ Reward ISSUED
→ APP_LICENSE entitlement
```

## 5. Rewards recorrentes

Conexão adicional permanente/longa possui custo recorrente. Antes de aprovação, o Reward Engine deve avaliar:

```text
expected duration
expected recurring provider COGS
customer value
policy cap
```

Preferir reward temporário quando fizer sentido econômico.

## 6. Free renewal

"Renovação grátis" não deve falsificar Payment.

Pode ser modelada por crédito/benefício aplicado a Order de renovação:

```text
Renewal Order = R$30
Referral Reward Credit = -R$30
Amount due = R$0
```

O ledger preserva valor econômico e custo.

## 7. Gift Pass

Gift Pass deve possuir:

```text
issuer
recipient/redemption identity
expiry
benefit
redemption
conversion attribution
```

Self-redemption ou loops suspeitos passam pelo Risk Engine.

## 8. Winback + Referral

Campanha pode condicionar benefício futuro a referrals confirmados, por exemplo:

```text
Customer reactivated
+ X referrals confirmed
→ free renewal reward
```

A política deve definir claramente se benefício é imediato ou adquirido após condição.

## 9. Invariantes

- Referral não é confirmado apenas por convite;
- Reward não é saldo mutável sem ledger;
- benefício recorrente carrega custo recorrente esperado;
- reversão preserva histórico;
- anti-abuse pode exigir REVIEW antes de CONFIRMED/APPROVED.

## 10. Métricas ligadas

- Referral Conversion;
- Referral CAC;
- Referral LTV;
- Referral Contribution Margin;
- K-factor;
- Reward Cost;
- Reward ROI;
- Referral-assisted Winback.
