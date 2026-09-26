import { Module } from "@nestjs/common";
import { createDb } from "@iptv/database";
import type { Database } from "@iptv/database";
import { createAuth, type AuthInstance } from "@iptv/auth";
import type { Kysely } from "kysely";
import { HealthController } from "./health.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { PermissionsGuard } from "./auth/permissions.guard.js";
import { AuditService } from "./audit/audit.service.js";
import { TenantsController } from "./tenants/tenants.controller.js";

const DEV_AUTH_SECRET = "dev-only-better-auth-secret-0123456789";

function dbFactory(): Kysely<Database> | null {
  const connectionString = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    return null;
  }
  return createDb({ connectionString });
}

function authFactory(db: Kysely<Database> | null): AuthInstance | null {
  if (db === null) {
    return null;
  }
  return createAuth(db, {
    secret: process.env["BETTER_AUTH_SECRET"] ?? DEV_AUTH_SECRET,
    baseUrl: process.env["BETTER_AUTH_URL"],
  });
}

@Module({
  controllers: [HealthController, AuthController, TenantsController],
  providers: [
    { provide: "DB", useFactory: dbFactory },
    { provide: "AUTH", useFactory: authFactory, inject: ["DB"] },
    AuditService,
    AuthGuard,
    PermissionsGuard,
  ],
})
export class AppModule {}
