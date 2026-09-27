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
});

export type AppConfig = z.infer<typeof envSchema>;

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
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration: ${details}`);
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.BETTER_AUTH_SECRET === "dev-only-better-auth-secret-0123456789"
  ) {
    throw new Error(
      "invalid environment configuration: BETTER_AUTH_SECRET must be overridden in production",
    );
  }
  return parsed.data;
}
