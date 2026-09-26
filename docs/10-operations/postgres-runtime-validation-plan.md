# PostgreSQL Runtime Validation Plan

> Status: Ready for execution
> Versão: 0.13
> Data: 2026-09-20
> Review: Auto-reviewed v0.13 — complements existing migration runtime plan.

## Environments

Run on the exact target PostgreSQL major/minor used by staging/pilot.

## Required gates

- fresh DB applies migrations 001–011 in order;
- pilot seed applies successfully;
- contract/integration SQL tests pass;
- Trial primary uniqueness survives concurrent transactions;
- tenant composite FK/constraints reject cross-tenant links;
- ledger deferred balance constraint works under transaction boundaries;
- outbox/inbox idempotency survives duplicate delivery;
- rollback strategy tested for at least one additive and one multi-step migration;
- backup/restore after migrations proven;
- representative query/index plans captured.

## Evidence

Store CI run URL, PostgreSQL version, migration checksums and test output in release evidence.
