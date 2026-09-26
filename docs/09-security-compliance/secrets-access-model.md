# Secrets & Privileged Access Model

> Status: Canonical security baseline  
> Version: 1.0  
> Review: Auto-reviewed v0.12 — checked for tenant scoping, least privilege, browser credentials, audit and rotation.

## Secret classes

- platform infrastructure secrets;
- tenant integration credentials;
- provider/browser credentials;
- webhook verification tokens;
- API keys/OAuth refresh tokens;
- signing/encryption material.

## Rules

- never store secret values in normal application tables, logs, traces, events, prompts or knowledge;
- persist only secret references/metadata where the domain needs linkage;
- access is least-privilege by service/workload identity;
- tenant-scoped integration secrets cannot be resolved by another tenant context;
- Browser Worker receives only credentials needed for the specific provider/tenant operation;
- human secret reveal should be exceptional and audited.

## Rotation

Each secret type defines owner, rotation capability, overlap strategy and rollback. Rotating credentials must not require editing source code.

## Incident response

Suspected compromise triggers revoke/rotate, affected-operation review, audit correlation and tenant/customer notification assessment according to privacy/security process.

## Auto-review result

Reviewed to prevent credentials from leaking into the AI/context/observability planes and to preserve tenant isolation for integrations.
