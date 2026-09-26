# ADR-0021 — PostgreSQL/Neon for pilot canonical database

- Status: **ACCEPTED**
- Decision: PostgreSQL remains the database contract; Neon in São Paulo is the recommended managed pilot deployment. Application code must avoid making Neon-specific APIs part of the domain so migration to another PostgreSQL deployment remains feasible.
