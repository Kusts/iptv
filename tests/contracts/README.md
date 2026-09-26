# Executable Contract Tests

Run:

```bash
python tests/contracts/test_contracts.py
python tests/contracts/test_seed_contract.py
```

The suite currently checks:

- OpenAPI lifecycle enums against PostgreSQL CHECK constraints;
- unique OpenAPI `operationId` values via the documentation validator;
- required MVP API surfaces for Support/HITL/Knowledge/Referral/Rewards;
- AsyncAPI event names against the canonical Event Model;
- operational-learning event coverage;
- critical semantic invariants that must not regress during schema evolution;
- synthetic seed safety;
- confirmed monthly price stays BRL 30.00;
- additional connection remains recurring and unpriced until policy defines it;
- high-risk outbound fixture flags remain OFF.

These tests run without PostgreSQL and complement, rather than replace, `db/tests/*.sql`.
