# SPEC — Provider Fulfillment & Browser Worker

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Versão: 1.0  
> Slice: MVP-05  
> Dependências: Provider adapter interface, Browser Worker, Subscription/Entitlements

## 1. Objetivo

Executar e verificar operações no provider externo sem transformá-lo em fonte da verdade e sem expor o restante do produto a detalhes de API/UI.

## 2. Estados canônicos

```text
REQUESTED
QUEUED
RUNNING
VERIFYING
RETRY_WAIT
HUMAN_REQUIRED
SUCCEEDED
FAILED
CANCELLED
```

## 3. Regra fundamental

> Uma ProviderOperation só é `SUCCEEDED` quando a **pós-condição de negócio observável** foi confirmada.

HTTP 200, clique concluído ou ausência de erro no navegador não bastam por si só.

## 4. Ações iniciais

Interface conceitual:

```text
CREATE_TRIAL
CREATE_CUSTOMER
RENEW_CUSTOMER
TRUST_RENEWAL
BLOCK_CUSTOMER
UNBLOCK_CUSTOMER
SYNC_CUSTOMER
MIGRATE_SERVER
CHANGE_CONNECTIONS
FETCH_CREDENTIALS
FETCH_PLAYLIST
```

Nem todas precisam estar expostas no primeiro release do Control Center.

## 5. API

```text
POST /v1/provider-operations
GET  /v1/provider-operations/{providerOperationId}
```

O request informa intenção semântica, não instruções de clique.

## 6. Adapter strategy

```text
ProviderPort
├─ Official/API Adapter quando disponível e autorizado
└─ Browser Adapter quando necessário e permitido
```

Core domain não sabe qual mecanismo foi usado.

## 7. Browser Worker

Requisitos:

- sessão persistente protegida;
- allowlist de domínios/origens;
- credentials via secrets manager;
- sem secrets no trace;
- Playwright/Chrome controlado;
- screenshots/DOM/network trace quando necessário;
- selector strategy robusta;
- postcondition verifier separado da etapa de ação.

## 8. Security challenges

CAPTCHA, 2FA inesperado, challenge de segurança ou alteração ambígua da UI:

```text
RUNNING
↓
HUMAN_REQUIRED
```

Não implementar bypass de controles de acesso ou anti-bot.

## 9. Idempotência

Cada operação recebe chave de efeito baseada no command lógico.

Retry de `RENEW_CUSTOMER` precisa primeiro verificar estado externo para não renovar duas vezes.

Padrão:

```text
precondition observation
↓
execute if still needed
↓
postcondition observation
```

## 10. Evidência

Guardar conforme classificação e retenção:

- before snapshot resumido;
- after snapshot resumido;
- provider external IDs;
- browser trace reference;
- screenshots quando necessário;
- attempt count;
- error classification;
- adapter version.

## 11. Drift da UI

Se selector/page contract divergir:

```text
operation cannot verify safely
↓
HUMAN_REQUIRED or FAILED
↓
adapter marked DEGRADED if systemic
```

Uma atualização futura deve produzir nova adapter revision, testada em conta segura/dry run quando possível.

## 12. Provider health

Sinais:

- operation success rate;
- latency;
- repeated challenge;
- server incidents;
- trial technical failures;
- reconciliation mismatches.

Provider Health não altera automaticamente customer entitlements; alimenta routing/review.

## 13. Eventos

Utilizar eventos canônicos do Event Model para provider operations/fulfillment. A implementação física deve mapear transições sem criar nomes paralelos fora do catálogo.

## 14. Critérios de aceitação

- CA-01: core não depende de selector/browser API.
- CA-02: operação sem pós-condição confirmada não fica SUCCEEDED.
- CA-03: retry não duplica renovação/conexão.
- CA-04: CAPTCHA/2FA/challenge vira HITL.
- CA-05: credentials não aparecem em trace/log.
- CA-06: adapter version fica associada à tentativa.
- CA-07: tenant A não consegue operar provider account do tenant B.
- CA-08: UI drift sistêmico pode degradar/desligar automação sem deploy.

## 15. Testes mínimos

- API adapter success;
- browser adapter success;
- postcondition false despite click success;
- idempotent retry;
- provider timeout;
- CAPTCHA/HITL;
- UI drift;
- cross-tenant provider account denial;
- trace redaction.

## 16. Refinamentos de operação v0.14

### Automation/manual parity

Toda semantic operation relevante disponível à IA deve possuir ação manual equivalente no Control Center quando RBAC/policy permitir. Ambos chamam o mesmo Command/Policy/Provider Adapter e produzem o mesmo audit trail.

### Importação e sync de base existente

Provider onboarding deve suportar `Discover → Normalize → Preview → Conflict Review → Import → Reconcile`, idempotente por `(tenant, provider, external_customer_id)`. Dados ausentes permanecem incompletos; não inventar identidade. Mudanças feitas diretamente no painel são detectadas como external change/drift.

### Desired vs observed

Persistir/projetar estado desejado interno e snapshot observado do provider. Reconciliation decide reparar provider, aceitar alteração manual autorizada ou escalar; nunca sobrescrever verdade comercial silenciosamente.

### Autonomia inicial

Novo tenant inicia preferencialmente em `OBSERVE → RECOMMEND → APPROVAL → AUTO`, configurável por operação. CAPTCHA/2FA/security challenge permanece HUMAN_REQUIRED.

## Auto-revisão v0.14

> Review: Auto-reviewed v0.14 — manual parity/import/reconciliation checked.

