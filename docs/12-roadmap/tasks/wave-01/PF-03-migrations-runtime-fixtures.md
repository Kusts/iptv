# PF-03 — Migrations, Runtime Gate & Synthetic Fixtures

## Goal

Prove that the documented physical model is executable before application code depends on it.

## Tasks

- choose/implement migration runner compatible with Migration Strategy;
- apply migrations `001–011` in strict order to disposable PostgreSQL;
- record migration checksum/history outside mutable schema semantics;
- run `db/tests/*.sql`;
- apply `db/seeds/001_pilot_baseline.sql` twice;
- run seed assertions;
- wire disposable PostgreSQL service into CI;
- preserve database logs/artifacts on failure;
- document PostgreSQL version used by CI/staging.

## Acceptance tests

- clean database reaches migration 011 with no manual intervention;
- second seed application is safe;
- Trial primary uniqueness test fails invalid duplicate as expected;
- cross-tenant FK test rejects invalid relationship;
- monthly fixture price equals BRL 30.00;
- additional-connection fixture remains recurring and has no invented sale price;
- fixture contains no production secrets or real identities.

## Done when

`./scripts/run_pg_fixture_tests.sh` is green in CI against the target PostgreSQL major version.
