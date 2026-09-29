import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // Session-token pepper (owns `control.auth_sessions.token_hash`).
  // Dev-only default so tests/boot work without env; override in production.
  BETTER_AUTH_SECRET: z
    .string()
    .min(16)
    .default("dev-only-better-auth-secret-0123456789"),
  BETTER_AUTH_URL: z.string().min(1).optional(),
  // W1-08 worker infrastructure: in-process scheduler is opt-in
  // (`API_SCHEDULER_ENABLED=1`); default off so boot never starts
  // background work unless the operator asks for it.
  API_SCHEDULER_ENABLED: z.enum(["0", "1"]).default("0"),
  API_SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  // W1-08 Hatchet adapter (Wave-0-gated): only read when set; absence
  // means the local in-process adapter (explicitly non-durable).
  HATCHET_API_TOKEN: z.string().min(1).optional(),
  HATCHET_SERVER_URL: z.string().min(1).optional(),
  // W1-12 observability: OTLP export only when an endpoint is set;
  // otherwise the SDK stays unconstructed (zero-overhead noop path).
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_SDK_DISABLED: z.enum(["true", "false"]).default("true"),
  // Browser CORS allowlist (explicit origins only — never a wildcard).
  // Comma-separated `scheme://host[:port]` entries with no path/query/hash.
  // Unset means: local default (`http://localhost:3000`) outside
  // production, empty allowlist (deny all cross-origin) in production.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, "CORS_ALLOWED_ORIGINS"> & {
  /** Explicit browser CORS allowlist (origin strings, never a wildcard). */
  CORS_ALLOWED_ORIGINS: string[];
};

/** Local web default so `localhost:3000` → API works out of the box. */
export const DEFAULT_LOCAL_CORS_ORIGIN = "http://localhost:3000";

/** True when `entry` is a bare `scheme://host[:port]` origin (no path/query/hash/wildcard). */
export function isValidCorsOrigin(entry: string): boolean {
  if (entry.includes("*")) return false;
  if (!/^https?:\/\//i.test(entry)) return false;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hash !== "" || url.search !== "") return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.host === "") return false;
  // Reject any path beyond the bare root (a trailing "/" normalizes to the origin).
  return entry === url.origin || entry === `${url.origin}/`;
}

/**
 * Parse the comma-separated `CORS_ALLOWED_ORIGINS` env value into an exact
 * origin allowlist. Trims entries, drops empties, dedupes, and normalizes a
 * trailing root "/" to the bare origin. Unset/empty means the local default
 * outside production and deny-all (`[]`) in production. Throws on any
 * wildcard or invalid origin.
 */
export function parseCorsAllowedOrigins(raw: string | undefined, nodeEnv: string): string[] {
  if (raw === undefined || raw.trim() === "") {
    return nodeEnv === "production" ? [] : [DEFAULT_LOCAL_CORS_ORIGIN];
  }
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) {
    return nodeEnv === "production" ? [] : [DEFAULT_LOCAL_CORS_ORIGIN];
  }
  const normalized: string[] = [];
  for (const entry of entries) {
    if (!isValidCorsOrigin(entry)) {
      throw new Error(
        `invalid environment configuration: CORS_ALLOWED_ORIGINS contains invalid origin ${JSON.stringify(entry)} (expected comma-separated scheme+host origins like "https://app.example.com", no path/query/hash, no wildcards)`,
      );
    }
    const canonical = new URL(entry).origin;
    if (!normalized.includes(canonical)) {
      normalized.push(canonical);
    }
  }
  return normalized;
}

/** Validate env (defaults to `process.env`) and return typed config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse({
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    DATABASE_URL: env.DATABASE_URL,
    LOG_LEVEL: env.LOG_LEVEL,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    API_SCHEDULER_ENABLED: env.API_SCHEDULER_ENABLED,
    API_SCHEDULER_TICK_SECONDS: env.API_SCHEDULER_TICK_SECONDS,
    HATCHET_API_TOKEN: env.HATCHET_API_TOKEN,
    HATCHET_SERVER_URL: env.HATCHET_SERVER_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_SDK_DISABLED: env.OTEL_SDK_DISABLED,
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration: ${details}`);
  }
  let corsAllowedOrigins: string[];
  try {
    corsAllowedOrigins = parseCorsAllowedOrigins(
      parsed.data.CORS_ALLOWED_ORIGINS,
      parsed.data.NODE_ENV,
    );
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.BETTER_AUTH_SECRET === "dev-only-better-auth-secret-0123456789"
  ) {
    throw new Error(
      "invalid environment configuration: BETTER_AUTH_SECRET must be overridden in production",
    );
  }
  return { ...parsed.data, CORS_ALLOWED_ORIGINS: corsAllowedOrigins };
}
