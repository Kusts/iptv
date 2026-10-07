/**
 * Boot-time role guard: proves the live connection really is the least-
 * privilege `outbox_worker` identity from migration 050 BEFORE any claim can
 * run. Checks, in order:
 *
 *   (a) `current_user` and `session_user` are both `outbox_worker`;
 *   (b) role attributes are exactly LOGIN with no superuser/createdb/
 *       createrole/replication/bypassrls powers;
 *   (c) zero `pg_auth_members` rows in either direction (no SET ROLE path);
 *   (d) NO direct table privileges on `platform.outbox_messages` or
 *       `platform.outbox_transitions` (the worker may only EXECUTE the four
 *       lifecycle functions; table access flows through the SECURITY DEFINER
 *       executor);
 *   (e) EXECUTE on exactly the four lifecycle functions with their exact
 *       signatures from migration 050.
 *   (f) zero cluster-global parameter ACLs (`pg_parameter_acl`) naming the
 *       worker — `GRANT ... ON PARAMETER ...` is server-configuration
 *       power living outside every object catalog (051 mirror).
 *   (g) the worker owns NO object in the database (relations, functions,
 *       types, schemas, large objects) — 051 mirror.
 *   (h) no `CREATE` on the `platform` schema — the worker may USE the
 *       schema to reach its functions, never create in it.
 *
 * Deliberately NOT asserted: `TEMPORARY` on the database and other
 * instance defaults vary by provider (PUBLIC defaults, cloud presets) and
 * confer no object access by themselves — documented here, never gated.
 *
 * Failure messages name only the failed predicate — never values, URLs, or
 * tokens. The query port is injectable so the whole matrix is unit-testable.
 */

export class RoleGuardError extends Error {
  constructor(detail: string) {
    super(`outbox-worker role guard: ${detail}`);
    this.name = "RoleGuardError";
  }
}

/** Minimal query port (subset of `pg.Pool`), injectable for tests. */
export type RoleQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface RoleCheckResult {
  ok: true;
}

async function singleRow(query: RoleQuery, sql: string, params?: unknown[]): Promise<Record<string, unknown>> {
  const res = params === undefined ? await query(sql) : await query(sql, params);
  const row = res.rows[0];
  if (row === undefined) {
    throw new RoleGuardError("identity query returned no rows");
  }
  return row;
}

const EXPECTED_FUNCTIONS = [
  "platform.outbox_claim(integer,text,integer)",
  "platform.outbox_renew(uuid,uuid,integer)",
  "platform.outbox_complete(uuid,uuid)",
  "platform.outbox_fail(uuid,uuid,text,timestamptz)",
] as const;

const OUTBOX_TABLES = ["platform.outbox_messages", "platform.outbox_transitions"] as const;

const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

export async function assertOutboxWorkerIdentity(query: RoleQuery): Promise<RoleCheckResult> {
  const identity = await singleRow(query, "SELECT current_user AS u, session_user AS s");
  if (identity["u"] !== "outbox_worker" || identity["s"] !== "outbox_worker") {
    throw new RoleGuardError("session identity is not the outbox_worker role");
  }

  const attrs = await singleRow(
    query,
    "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user",
  );
  if (
    attrs["rolcanlogin"] !== true ||
    attrs["rolsuper"] !== false ||
    attrs["rolbypassrls"] !== false ||
    attrs["rolcreatedb"] !== false ||
    attrs["rolcreaterole"] !== false ||
    attrs["rolreplication"] !== false
  ) {
    throw new RoleGuardError("role attributes diverge from the least-privilege posture");
  }

  const memberships = await singleRow(
    query,
    "SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker') OR member = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')",
  );
  if (Number(memberships["n"]) !== 0) {
    throw new RoleGuardError("unexpected role memberships for the worker identity");
  }

  for (const table of OUTBOX_TABLES) {
    for (const privilege of TABLE_PRIVILEGES) {
      const check = await singleRow(
        query,
        `SELECT has_table_privilege('${table}', '${privilege}') AS v`,
      );
      if (check["v"] !== false) {
        throw new RoleGuardError("direct table privilege detected on outbox storage");
      }
    }
  }

  for (const fn of EXPECTED_FUNCTIONS) {
    const check = await singleRow(query, "SELECT has_function_privilege($1, 'EXECUTE') AS v", [fn]);
    if (check["v"] !== true) {
      throw new RoleGuardError("lifecycle function is not executable by the worker identity");
    }
  }

  const parameterAcls = await singleRow(
    query,
    "SELECT count(*)::int AS n FROM pg_parameter_acl AS p, aclexplode(p.paracl) AS a WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')",
  );
  if (Number(parameterAcls["n"]) !== 0) {
    throw new RoleGuardError("unexpected parameter privileges for the worker identity");
  }

  const ownedObjects = await singleRow(
    query,
    "SELECT ((SELECT count(*) FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')) + (SELECT count(*) FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')) + (SELECT count(*) FROM pg_type WHERE typowner = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')) + (SELECT count(*) FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')) + (SELECT count(*) FROM pg_largeobject_metadata WHERE lomowner = (SELECT oid FROM pg_roles WHERE rolname = 'outbox_worker')))::int AS n",
  );
  if (Number(ownedObjects["n"]) !== 0) {
    throw new RoleGuardError("worker identity owns database objects");
  }

  const schemaCreate = await singleRow(
    query,
    "SELECT has_schema_privilege('platform', 'CREATE') AS v",
  );
  if (schemaCreate["v"] !== false) {
    throw new RoleGuardError("schema create privilege detected on platform schema");
  }

  return { ok: true };
}
