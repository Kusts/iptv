# Capability, Skill and Tool Registry Contract

## Definitions

- **Capability**: something the platform is able to do.
- **Tool**: a concrete implementation exposed to the Agent Runtime to invoke a capability.
- **Skill**: contextual strategy/knowledge that improves agent behavior; it grants no permission.
- **Policy**: determines whether/how a capability may be used.

## Capability definition

Each capability must declare:

- canonical key and owning domain;
- availability (`AVAILABLE | DEGRADED | UNAVAILABLE`);
- certification status;
- provider/integration requirements;
- risk class;
- permissions;
- policy family;
- manual UI equivalent;
- MVP phase;
- degradation behavior.

## Tool definition

Each tool declares:

- `key` and implemented capability;
- input/output schemas;
- tenant scope;
- required permissions;
- risk/idempotency class;
- timeout/retry rules;
- preconditions and postconditions;
- error taxonomy;
- whether human approval may be requested.

**Tool existence never implies authorization.**

## Action-resolution algorithm

`Capability available? → actor permitted? → policy allows? → preconditions valid? → autonomy level? → AUTO / APPROVAL / MANUAL / DENY`

## Provider examples

CINEVISION capabilities confirmed for the MVP include:

- Service Trial 1h/3h/6h;
- adult on/off;
- add connection with same expiration as primary;
- Trust Renewal exactly +3 days, only ACTIVE and remaining_days <= 3;
- server migration where supported;
- Portal VOD request submission;
- customer/state/credit reads.

Unsupported/invented capabilities such as arbitrary +N free days must never appear in an Agent tool schema.

## Manual equivalence

Every operational Agent tool with business impact must resolve to the same application command used by its frontend action. Direct DB tools are forbidden for normal product operations.
