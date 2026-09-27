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
import { CommandDbProvider, CommandsProvider } from "./commands/commands.provider.js";
import { LocalTransport } from "./outbox/transport.js";
import { OutboxDrainer } from "./outbox/outbox-drainer.js";
import { OutboxController } from "./outbox/outbox.controller.js";
import { InboxProcessor } from "./inbox/inbox-processor.js";
import { InboxStoreProvider } from "./inbox/inbox.provider.js";
import { HumanReviewController } from "./human-review/human-review.controller.js";
import { CrmController } from "./crm/crm.controller.js";
import { TrialController } from "./trial/trial.controller.js";
import { CompatibilityController } from "./trial/compatibility.controller.js";
import { ProviderController } from "./provider/provider.controller.js";
import { CommunicationsController } from "./communications/communications.controller.js";
import { WahaWebhookController } from "./communications/waha-webhook.controller.js";
import { WahaWebhookService } from "./communications/waha-webhook.service.js";
import { CommerceController } from "./commerce/commerce.controller.js";
import { SubscriptionController } from "./subscription/subscription.controller.js";
import { RenewalController } from "./renewal/renewal.controller.js";
import { RecoveryController } from "./renewal/recovery.controller.js";
import { FulfillmentController } from "./fulfillment/fulfillment.controller.js";
import { BillingController } from "./billing/billing.controller.js";
import { AsaasWebhookController } from "./billing/asaas-webhook.controller.js";
import { AsaasWebhookService } from "./billing/asaas-webhook.service.js";
import { KyselyPolicyRepository, PolicyResolver } from "./policy/policy-resolver.js";
import { PolicyController } from "./policy/policy.controller.js";
import {
  ActionGate,
  KyselyCapabilityStore,
} from "./capabilities/capability-registry.js";
import { CapabilitiesController } from "./capabilities/capabilities.controller.js";
import { AgentController } from "./agent/agent.controller.js";
import { ContextBuilder } from "./agent/context-builder.js";
import { KyselyAgentReleaseStore } from "./agent/release-store.js";
import { AgentPipeline } from "./agent/pipeline.js";

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
  controllers: [
    HealthController,
    AuthController,
    TenantsController,
    HumanReviewController,
    CrmController,
    TrialController,
    CompatibilityController,
    ProviderController,
    CommunicationsController,
    WahaWebhookController,
    CommerceController,
    SubscriptionController,
    RenewalController,
    RecoveryController,
    FulfillmentController,
    BillingController,
    AsaasWebhookController,
    PolicyController,
    CapabilitiesController,
    OutboxController,
    AgentController,
  ],
  providers: [
    { provide: "DB", useFactory: dbFactory },
    { provide: "AUTH", useFactory: authFactory, inject: ["DB"] },
    AuditService,
    AuthGuard,
    PermissionsGuard,
    CommandDbProvider,
    CommandsProvider,
    { provide: "POLICY_REPOSITORY", useFactory: (db: Kysely<Database> | null) => new KyselyPolicyRepository(db), inject: ["DB"] },
    PolicyResolver,
    { provide: "CAPABILITY_STORE", useFactory: (db: Kysely<Database> | null) => new KyselyCapabilityStore(db), inject: ["DB"] },
    ActionGate,
    ContextBuilder,
    KyselyAgentReleaseStore,
    AgentPipeline,
    { provide: "TRANSPORT", useClass: LocalTransport },
    OutboxDrainer,
    InboxStoreProvider,
    InboxProcessor,
    WahaWebhookService,
    AsaasWebhookService,
  ],
})
export class AppModule {}
