import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./schema.js";

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
}

/**
 * Create a Kysely instance over `pg`. No CamelCasePlugin: the schema is
 * snake_case and is mapped explicitly via the typed interfaces in schema.ts.
 */
export function createDb(config: DbConfig): Kysely<Database> {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
