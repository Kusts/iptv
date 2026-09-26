# CRM-01 — Deterministic Person & Identity Resolution

## Goal

Resolve channel identities into one canonical Person without probabilistic auto-merge.

## Tasks

- implement normalization per identity type behind IdentityNormalizer;
- implement exact active identity lookup scoped by tenant;
- create Person + Identity transactionally when no exact match exists and policy permits;
- return existing Person for exact match;
- represent ambiguous/conflicting identity as Merge Review instead of auto-merge;
- emit canonical identity/person events through outbox;
- expose/create Person using OpenAPI contract;
- add repository and API integration tests;
- ensure detached/disputed identities are not treated as trusted exact matches unless policy says so.

## Acceptance tests

- same normalized WhatsApp identity resolves same Person on repeated request;
- same raw identifier in two tenants resolves two independent Persons;
- new identity creates exactly one Person under concurrent duplicate requests;
- conflicting identity signals create review path and do not merge automatically;
- emitted `person.created.v1` contains no raw secret and is tenant scoped.

## Done when

Downstream domains can depend exclusively on `person_id`; no feature creates its own parallel customer/contact identity table.
