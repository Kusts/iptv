# scripts/

Repository maintenance and CI-gate scripts. The Python gates are part of the
CI order; the `.sh` scripts need bash + `psql`.

## `validate_docs.py` (CI gate)

`python scripts/validate_docs.py` — static documentation/contracts/migration
integrity check. Verifies, among other things: every relative Markdown link in
the repo resolves; the event registry block in
`docs/02-domain/event-model.md` is well-formed and every declared source
honestly contains the ID; `docs/15-implementation-baseline/04-event-catalog.md`
matches that block row-by-row; AsyncAPI channel keys and SPEC operational
sections reference only registry IDs. **Any change under `docs/**`, the
contracts or `db/migrations/` must keep it green.**

## `validate_doc_reviews.py` (NOT a gate)

`python scripts/validate_doc_reviews.py` — checks that a fixed list of
historical Markdown files still contains the `Auto-reviewed v0.14` marker.
It is intentionally out of date and red by design: those markers are
historical records, not a live review state. **Do not "fix" it and do not add
claims of review just to turn it green.** It is not wired into CI.

## `run_pg_tests.sh` (needs bash + psql)

`DATABASE_URL=postgresql://... ./scripts/run_pg_tests.sh` — applies every
`db/migrations/*.sql` in filename order, then runs every `db/tests/*.sql`, with
`ON_ERROR_STOP=1`. Requires `bash`, `psql` and `DATABASE_URL`, and it is
destructive: point it at a **disposable** database. On Windows use Git Bash
or WSL.

## `run_pg_fixture_tests.sh` (needs bash + psql)

`DATABASE_URL=postgresql://... ./scripts/run_pg_fixture_tests.sh` — same as
above plus `db/seeds/*.sql`, each applied **twice** to prove the pilot seed is
idempotent. Requires a disposable database as well.