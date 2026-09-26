# Service Trial — State Machine v1.0

> Status: FINAL supporting detail.

## Lifecycle

`REQUESTED | PROVISIONING | ACTIVE | ENDED | INVALIDATED | CANCELLED`

Typical path is `REQUESTED → PROVISIONING → ACTIVE → ENDED`. An unusable trial may be `INVALIDATED`; provisioning failure belongs to the attempt and a technical `FAILED` belongs to the assessment, not the lifecycle.

Technical assessment is independent: `PENDING | PASSED | FAILED | INCONCLUSIVE`.

## Trial kinds

- `TRIAL`: the primary free commercial Trial, at most one per Person by default.
- `RETRIAL`: requires `previous_trial_id` and a legitimate documented reason such as provisioning failure, invalid credentials, provider incident or compatibility problem.

At most one open free-access window (`REQUESTED|PROVISIONING|ACTIVE`) may exist per Person.

Provider-supported durations are 1h/3h/6h. Existing/ex-customers needing diagnosis use `TechnicalAccessGrant`, not another commercial Trial. Trust Renewal is also a separate concept.
