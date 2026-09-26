# Entitlements — State Machine

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20  
> Domínio: D11 — Entitlements

## 1. Responsabilidade

Entitlement representa **direito concedido**, não compra nem execução no provider.

Exemplos:

- IPTV access;
- connection quantity;
- adult-content permission;
- app license;
- Trust Renewal Grant (provider capability-specific, fixed +3 days when eligible);
- gift pass;
- temporary upgrade.

## 2. Estados

```text
PENDING
ACTIVE
SUSPENDED
EXPIRED
REVOKED
CANCELLED
```

### Transições

| De | Evento | Para | Regra |
|---|---|---|---|
| — | `entitlement.created.v1` | PENDING | direito calculado/criado |
| PENDING | `entitlement.activated.v1` | ACTIVE | effective_at atingido e condições satisfeitas |
| ACTIVE | `entitlement.suspended.v1` | SUSPENDED | direito temporariamente indisponível por regra |
| SUSPENDED | `entitlement.resumed.v1` | ACTIVE | causa removida |
| PENDING/ACTIVE/SUSPENDED | `entitlement.expired.v1` | EXPIRED | janela temporal terminou |
| PENDING/ACTIVE/SUSPENDED | `entitlement.revoked.v1` | REVOKED | direito retirado por decisão válida |
| PENDING | `entitlement.cancelled.v1` | CANCELLED | não chegou a vigorar |

## 3. Fulfillment é estado separado

Um Entitlement ACTIVE pode temporariamente ter fulfillment pendente.

Exemplo:

```text
Entitlement = ACTIVE
ProviderOperation = RETRY_WAIT
Fulfillment projection = DEGRADED/PENDING
```

Isso permite reconhecer que **o cliente tem direito ao serviço** mesmo quando o provider está com falha.

A resposta operacional é corrigir fulfillment, não apagar o direito.

## 4. Tipos e quantidade

Entitlement pode possuir:

```text
type
quantity
effective_at
expires_at
source_type
source_id
scope
```

Exemplo:

```text
type = CONNECTIONS
quantity = 2
source = Subscription + recurring add-on
```

O quantity efetivo pode ser projeção da soma/regra de múltiplos entitlements, conforme definição futura.

## 5. Conexão adicional

Uma conexão extra recorrente gera entitlement vinculado ao ciclo/subscription add-on.

Quando o add-on deixa de ser renovado:

```text
entitlement.expired.v1
```

ou é recalculado para o novo ciclo.

Não modelar a conexão como benefício permanente apenas porque o provider foi alterado uma vez.

## 6. Reward e Gift Pass

Reward pode originar entitlement.

Exemplos:

```text
Reward: app anual
→ APP_LICENSE entitlement

Reward: +1 tela por 30 dias
→ CONNECTIONS entitlement temporário

Reward: desconto/crédito para renovação
→ benefício econômico aplicado no próximo Order

Trust Renewal não é reward genérico; é provider capability fixa e elegível somente nas condições do provider.
```

O Reward continua existindo como razão econômica/auditável.

## 7. Reversões

Refund, fraude confirmada ou erro administrativo podem resultar em `entitlement.revoked.v1`, conforme policy.

Revogação deve preservar histórico e razão; nunca deletar silenciosamente.

## 8. Invariantes

- Entitlement não contém credenciais do provider como fonte primária;
- Order Item não é Entitlement;
- Payment não é Entitlement;
- Reward não é Entitlement, embora possa originá-lo;
- alteração de fulfillment não modifica automaticamente o direito;
- entitlements temporários precisam de expiração explícita.

## 9. Métricas ligadas

- fulfillment gap;
- entitlement activation latency;
- rewarded connection cost;
- active entitlement composition;
- entitlement/provider drift.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — removed invalid arbitrary-day reward mapping for the initial provider.
