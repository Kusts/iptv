# EPIC-00 — Platform Foundation

## Outcome

Ter uma base multi-tenant segura e observável onde todos os slices seguintes podem operar.

## Dependências

Nenhuma.

## Stories

### PF-01 — Bootstrap do workspace

**Aceite:** aplicações Web/API/Worker/Browser Worker iniciam com configuração por ambiente; CI executa lint/typecheck/test/docs validator.

**Tasks:** workspace; env schema; health endpoints; base logging; CI.

### PF-02 — Tenant context e autorização baseline

**Aceite:** toda request autenticada resolve tenant explícito; tentativa cross-tenant falha; audit registra actor/tenant.

**Tasks:** tenant middleware; membership lookup; permission primitive; integration tests de isolamento.

### PF-03 — PostgreSQL migrations 001–011 + synthetic fixtures

**Aceite:** banco vazio sobe 001–011 em ordem; rollback de deployment segue Migration Strategy; fixtures sintéticas do tenant piloto aplicam duas vezes com segurança e cobrem tenant/person/trial/support/referral sem dados reais.

**Tasks:** migration runner; CI Postgres service; migration checksum; synthetic seed; fixture assertions; runtime migration/integration gate.

### PF-04 — Idempotency / Inbox / Outbox

**Aceite:** command duplicado retorna mesmo efeito; webhook duplicado não duplica side effects; outbox publica após commit.

### PF-05 — Secrets + kill switches

**Aceite:** secret não aparece em log/trace; provider/browser/AI outbound podem ser desligados por tenant sem deploy.

## Epic Gate

- cross-tenant suite verde;
- migrations runtime-tested;
- outbox atomicity provada;
- audit + correlation IDs visíveis.
