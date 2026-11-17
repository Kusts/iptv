import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pg;
try {
  pg = require("pg");
} catch {
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const pnpmDir = join(scriptDir, "..", "node_modules", ".pnpm");
    const pgPackage = readdirSync(pnpmDir).find((entry) => entry.startsWith("pg@"));
    if (!pgPackage) throw new Error("No pg package found in node_modules/.pnpm.");
    pg = require(join(pnpmDir, pgPackage, "node_modules", "pg"));
  } catch (error) {
    console.error(`Unable to load the pg package: ${error instanceof Error ? error.message : "module resolution failed"}`);
    process.exit(1);
  }
}

const [action, ...args] = process.argv.slice(2);
const pepper = process.env.BOT_SERVICE_TOKEN_PEPPER;
if (!pepper?.trim() || pepper.length < 32) {
  console.error("BOT_SERVICE_TOKEN_PEPPER must be set and contain at least 32 characters (read from the local process environment).");
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required for owner-only local credential management.");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  if (action === "revoke") {
    const [credentialId] = args;
    if (!credentialId) throw new Error("Usage: node scripts/emit-bot-credential.mjs revoke <credentialId>");
    const result = await client.query(
      "update platform.bot_service_credentials set revoked_at = now() where id = $1::uuid and revoked_at is null",
      [credentialId],
    );
    console.log(result.rowCount === 1 ? "Credential revoked." : "Credential not found or already revoked.");
  } else if (action === "issue") {
    const [tenantId, label, daysRaw] = args;
    const days = Number(daysRaw);
    if (!tenantId || !label || !Number.isInteger(days) || days < 1) {
      throw new Error("Usage: node scripts/emit-bot-credential.mjs issue <tenantId> <label> <expiry-days>");
    }
    if (days > 365) throw new Error("Credential validity cannot exceed 365 days.");
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(`${pepper}:${token}`).digest("hex");
    const prefix = token.slice(0, 8);
    const result = await client.query(
      `insert into platform.bot_service_credentials
        (tenant_id, label, token_hash, token_prefix, scopes, expires_at)
       values ($1::uuid, $2, $3, $4, ARRAY['bot.streammax.execute'], now() + ($5::int * interval '1 day'))
       returning id`,
      [tenantId, label, hash, prefix, days],
    );
    console.log(`Credential ID: ${result.rows[0].id}`);
    console.log(`Token (shown once; store securely): ${token}`);
  } else {
    throw new Error("Usage: node scripts/emit-bot-credential.mjs <issue|revoke> ...");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Credential operation failed.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
