# PF-02 — Tenant Context & Authorization Baseline

## Goal

Make tenant isolation an application primitive rather than a convention.

## Tasks

- resolve authenticated user from the selected Auth adapter;
- load active tenant membership and role;
- create immutable request-scoped TenantContext;
- reject tenant IDs supplied in mutation bodies as an authority source;
- implement repository/query helper requiring TenantContext;
- implement authorization primitive for role/permission checks;
- attach tenant/actor/correlation fields to audit writes;
- add tests for absent, suspended, revoked and cross-tenant memberships.

## Acceptance tests

- authenticated user without active membership receives authorization failure;
- user from Tenant A cannot read Person from Tenant B by guessing UUID;
- mutation body containing a different `tenant_id` cannot switch scope;
- audit record contains the resolved tenant and actor;
- suspended membership cannot execute protected command.

## Hard fail

Any repository/API that can access tenant-owned data without TenantContext blocks completion of this Story.
