# EPIC-02 — Trial & Compatibility

## Outcome

Oferecer um único Trial legítimo por Person, permitir Retrial justificado e produzir validação técnica útil para venda e conhecimento.

## Stories

### TR-01 — Trial Eligibility

**Aceite:** primeira Person elegível recebe ALLOW; Person com Trial primário recebe DENY por padrão; exception path produz ALLOW_RETRIAL somente com razão/evidência/policy.

### TR-02 — Concorrência e antiabuso

**Aceite:** duas solicitações simultâneas não criam dois acessos abertos; Risk Engine pode retornar REVIEW/DENY; decisão fica auditada.

### TR-03 — Provisionamento do Trial

**Aceite:** CREATE_TRIAL usa Provider Port; lifecycle vai REQUESTED → PROVISIONING → ACTIVE somente após verificação.

### TR-04 — Technical assessment

**Aceite:** installation/auth/playback/buffering resultam em outcome PENDING/PASSED/FAILED/INCONCLUSIVE sem encerrar Trial automaticamente.

### TR-05 — Retrial por falha comprovada

**Aceite:** Retrial referencia Trial anterior e reason; incidente/provider failure elegível não consome um novo Trial primário.

### TR-06 — Compatibility observations

**Aceite:** device/app/network/server/procedure/outcome são persistidos sem transformar hipótese do fornecedor em verdade global.

## Epic Gate

Demo obrigatória: primeiro Trial funciona; segunda solicitação é bloqueada; provider failure gera Retrial legítimo.
