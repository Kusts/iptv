# SPEC — SaaS Control Plane

> Status: Supporting detail — reconciled under v1.0 implementation baseline
> Version: 1.0  
> Review: Auto-reviewed v0.11 — checked for authority, state/event vocabulary, tenant isolation, failure paths and testability.

## Purpose

Manage tenant lifecycle independently from each tenant's operational data plane.

## Capabilities

Tenant catalog/provisioning, users/memberships/RBAC, SaaS subscription/feature entitlements, limits/quotas, usage metering, integration credential references, tenant health, tenant billing, onboarding and offboarding.

## Usage metering baseline

Track per tenant: LLM tokens/cost, agent runs, messages, browser minutes, transcription, storage, contacts, workflows and support volume where relevant.

## Isolation

Control-plane permission never implicitly grants data-plane customer access. Tenant deletion/offboarding follows privacy/retention/ledger obligations.

## Auto-review result

Reviewed to separate SaaS operator concerns from the IPTV/subscription-business domain runtime.
