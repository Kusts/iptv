# Migration Batch v0.9 — Communications, Operations Learning & Referral

> Status: static-reviewed; runtime tests prepared
> Date: 2026-09-20

## Scope

This batch materializes the remaining MVP operational core after Commerce/Fulfillment.

### 009 — Communications

Creates:

- conversations;
- immutable messages;
- delivery attempts/history;
- communication preferences;
- suppressions;
- append-only conversation control history.

Key invariant: `Conversation.control_mode` is independent from Support Ticket status and can only use `AI_CONTROL`, `HUMAN_CONTROL` or `PAUSED`.

### 010 — Support / HITL / Knowledge

Creates:

- incidents and problems;
- support tickets;
- ticket ↔ incident/problem links;
- solution attempts;
- knowledge sources/items/versions/source links;
- reusable solutions and observed outcomes;
- human review requests/actions.

Key invariants:

- Ticket, HumanReview and KnowledgeItem keep independent lifecycles;
- knowledge versions and observed solution outcomes are append-only;
- external knowledge starts with explicit trust classification;
- a successful support attempt does not automatically make knowledge `VERIFIED`;
- human review action history is append-only.

### 011 — Referral / Rewards

Creates:

- referral programs;
- referrals;
- qualification decisions;
- reward definitions;
- rewards;
- append-only reward ledger;
- Gift Passes;
- referral ↔ reward links.

Key invariants:

- Referral `CONFIRMED` remains distinct from invite/click/Trial;
- only one active attribution per referred Person/program can exist at a time;
- risk assessment references are tenant-safe;
- reward wallet changes use an append-only ledger;
- a Gift Pass has a unique tenant-scoped code;
- economic rewards preserve explicit value/cost fields rather than hiding their cost.

## Executable tests

Two layers now exist:

1. `tests/contracts/test_contracts.py` — executable contract consistency checks that compare OpenAPI lifecycle enums with PostgreSQL CHECK constraints and validate AsyncAPI events.
2. `db/tests/*.sql` — PostgreSQL integration tests for invariants that require a real database.

`./scripts/run_pg_tests.sh` applies migrations then executes the SQL integration tests against a disposable database identified by `DATABASE_URL`.

## Runtime status

- static migrations validation: passed;
- Python contract tests: passed;
- PostgreSQL integration tests: prepared, not executed here because `psql`/PostgreSQL runtime is unavailable in the current environment.

No migration should be labelled `runtime-tested` until the SQL suite passes against the selected PostgreSQL production major version.
