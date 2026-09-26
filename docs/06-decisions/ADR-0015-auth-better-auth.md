# ADR-0015 — Better Auth for Application Authentication

> Status: Proposed
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — checked against provider-agnostic auth and RBAC boundaries.

## Context

The product needs secure login/session management, MFA-capable evolution and organization/workspace compatibility without coupling identity to a specific database host.

## Decision proposed

Use Better Auth for authentication/session primitives. Product authorization/RBAC remains domain-owned and must not be replaced by library defaults.

## Consequences

- TypeScript-native and framework agnostic;
- supports extensible auth methods, 2FA/passkeys/organization capabilities;
- authentication data remains in our controlled data model/infrastructure;
- requires a spike to map tenant membership, session revocation and audit evidence.

## Validation before Accepted

- email/password or chosen login flow;
- MFA flow;
- session revocation;
- tenant membership mapping;
- RBAC guard integration;
- cross-tenant authorization tests.
