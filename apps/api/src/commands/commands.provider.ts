import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { currentOutboundAttachmentStore, setOutboundAttachmentStore } from "../communications/waha-outbound-attachments.js";
import { PgOutboundAttachmentStore } from "../communications/pg-outbound-attachment-store.js";
import { currentInboundAttachmentStore, setInboundAttachmentStore } from "../communications/waha-inbound-attachments.js";
import { PgInboundAttachmentStore } from "../communications/pg-inbound-attachment-store.js";
import { CommandBus, type DbPort } from "./command-bus.js";
import { KyselyCommandDb } from "./kysely-command-db.js";
import { registerHumanReviewCommands } from "../human-review/human-review.commands.js";
import { registerIntegrationCommands } from "../integrations/integrations.commands.js";
import { registerWhatsappSessionCommands } from "../integrations/whatsapp-sessions.commands.js";
import { registerPolicyCommands } from "../policy/policy.commands.js";
import { registerCapabilityCommands } from "../capabilities/capability.commands.js";
import { registerCrmCommands } from "../crm/crm.commands.js";
import { registerCommunicationCommands } from "../communications/communications.commands.js";
import { registerTrialCommands } from "../trial/trial.commands.js";
import { registerProviderCommands } from "../provider/provider.commands.js";
import { registerCommerceCommands } from "../commerce/commerce.commands.js";
import { registerBillingCommands } from "../billing/billing.commands.js";
import { registerFinanceCommands } from "../finance/finance.commands.js";
import { registerSubscriptionCommands } from "../subscription/subscription.commands.js";
import { registerRenewalCommands } from "../renewal/renewal.commands.js";
import { registerReferralCommands } from "../referral/referral.commands.js";
import { registerGrowthCommands } from "../growth/growth.commands.js";
import { registerFulfillmentCommands } from "../fulfillment/fulfillment.commands.js";
import { registerSupportCommands } from "../support/support.commands.js";
import { registerKnowledgeCommands } from "../knowledge/knowledge.commands.js";
import { registerExperimentCommands } from "../experiments/experiments.commands.js";
import { registerClaimCommands } from "../human-review/claim.commands.js";
import { registerAppTrialCommands } from "../inventory/app-trial.commands.js";
import { registerSupplierCreditCommands } from "../inventory/supplier-credit.commands.js";
import { registerLicenseCommands } from "../inventory/license.commands.js";
import { registerPartnersCommands } from "../partners/partners.commands.js";
import { resolveSupplierBalancePort, supplierBalanceAdapterFromEnv } from "../inventory/supplier-balance.port.js";
import { refundReviewResolvedHook, refundTargetRevalidator } from "../billing/refund-review.js";
import { copilotTargetRevalidator } from "../agent/copilot-review.js";
import type { CommandHandlerContext, StoredReviewRequest } from "./command-bus.js";
import {
  StubProviderReadback,
  adapterNameFromEnv,
  resolveOpsPort,
} from "../provider/provider-port.js";

/**
 * CommandBus provider: builds the bus over the `COMMAND_DB` port and
 * registers the Wave 1 command catalog (HumanReview substrate + Policy and
 * Capability foundations), the Wave 2 slice (CRM + Communications), the
 * Wave 4 slice (Trials + Compatibility + Provider Operations) and the
 * Wave 5 slice (Commerce + Billing over the Asaas port) and the Wave 6
 *   slice (Subscriptions + Fulfillment over the ProviderOpsPort) and the
 *   Wave 9 slice (Renewal + Retention: quote/renew/reminders/trust/expiry +
 *   recovery queue, reusing the Wave 5 billing and Wave 6 subscription
 *   primitives) and the Wave 8 slice (Support tickets/incidents/problems +
 *   Knowledge items + `human_review.claim` for the HITL center) and the
  *   Wave 12 slice (Referral attribution/qualification + Rewards
  *   issue/redeem + gift passes over the Wave 5 order/billing primitives).
  *   Explicit tokens everywhere — esbuild/vitest emits no `design:paramtypes`.
  *   Wave 11 slice (Campaigns/Attribution: campaign lifecycle + versioning,
  *   audiences, MessageIntent scheduling behind the manual gateway, first-
  *   touch attribution and version-resolving conversions over the Wave 2
  *   preference/suppression primitives).
 *
 *   Wave 7 slice (Apps/MK over ports/fakes only): AppTrial lifecycle,
 *   MK supplier-balance snapshots + atomic credit reservations, and the
 *   orchestrated LicenseAsset purchase/activation/reconciliation. The real
 *   MK Browser Worker adapter stays out of scope and has no implementation
 *   here.
 *
 * Provider adapters are explicit: `PROVIDER_OPS_ADAPTER=echo|manual`
 * (default `manual`); the real CINEVISION integration stays Wave-0-gated
 * and has no implementation here. Billing uses `ASAAS_ADAPTER=echo|real`
 * (default `echo`); `real` requires `ASAAS_API_KEY` + `ASAAS_BASE_URL` and
 * maps transport uncertainty to UNKNOWN_EFFECT (never auto-retries).
 */
/**
 * Combined HumanReview target revalidator: the Copilot guard owns
 * `copilot_command` reviews (no self-approval + command binding), the
 * refund guard owns linked `refund_request` reviews. Each passes through
 * reviews outside its resource type, so chaining is order-independent.
 */
async function combinedTargetRevalidator(
  ctx: CommandHandlerContext,
  request: StoredReviewRequest,
  decision?: "APPROVED" | "REJECTED",
): Promise<string | null> {
  return (
    (await copilotTargetRevalidator(ctx, request, decision)) ??
    (await refundTargetRevalidator(ctx, request, decision))
  );
}

export const CommandsProvider = {
  provide: CommandBus,
  useFactory: (commandDb: DbPort | null) => {
    const bus = new CommandBus(commandDb);
    if (commandDb !== null) {
      registerHumanReviewCommands(bus, {
        revalidate: combinedTargetRevalidator,
        onResolved: refundReviewResolvedHook,
      });
      registerIntegrationCommands(bus);
      registerWhatsappSessionCommands(bus);
      registerPolicyCommands(bus);
      registerCapabilityCommands(bus);
      registerCrmCommands(bus);
      registerCommunicationCommands(bus);
      const opsPort = resolveOpsPort(adapterNameFromEnv());
      registerTrialCommands(bus, { opsPort });
      registerProviderCommands(bus, { opsPort, readbackPort: new StubProviderReadback() });
      registerCommerceCommands(bus);
      // Billing resolves the Asaas port PER TENANT at handler time
      // (`resolveAsaasPortForTenant`): a CONNECTED_READ_ONLY binding +
      // readable vault yields a dedicated RealAsaasAdapter; without a binding
      // it falls back to the legacy env adapter (compat). Injecting a fixed
      // port here would pin every tenant to it and make vaulted billing
      // unreachable — so no `asaasPort` is passed (test doubles still win
      // when injected explicitly at the command layer).
      registerBillingCommands(bus);
      registerFinanceCommands(bus);
      registerSubscriptionCommands(bus);
      registerRenewalCommands(bus);
      registerReferralCommands(bus);
      registerGrowthCommands(bus);
      registerFulfillmentCommands(bus, { opsPort });
      registerSupportCommands(bus);
      registerKnowledgeCommands(bus);
      registerExperimentCommands(bus);
      registerClaimCommands(bus);
      registerAppTrialCommands(bus);
      registerSupplierCreditCommands(bus, {
        balancePort: resolveSupplierBalancePort(supplierBalanceAdapterFromEnv()),
      });
      registerLicenseCommands(bus, { opsPort, readbackPort: new StubProviderReadback() });
      registerPartnersCommands(bus);
    }
    return bus;
  },
  inject: ["COMMAND_DB"],
};

export const CommandDbProvider = {
  provide: "COMMAND_DB",
  useFactory: (db: Kysely<Database> | null) => {
    if (db === null) {
      return null;
    }
    return new KyselyCommandDb(db);
  },
  inject: ["DB"],
};

/**
 * Outbound attachment backing (EXEC-WAHA-BACKING-20261020): when a database
 * pool exists, the persistent Pg store (`platform.outbound_attachments`,
 * migration 061) becomes the default lane for BOTH the command resolver and
 * the gateway adapter (both read `currentOutboundAttachmentStore()` at call
 * time). Without a pool the fail-closed empty registry stays active and
 * every resolution refuses. Test doubles keep overriding per-test.
 */
export const OutboundAttachmentStoreProvider = {
  provide: "OUTBOUND_ATTACHMENT_STORE",
  useFactory: (db: Kysely<Database> | null) => {
    if (db !== null) {
      setOutboundAttachmentStore(new PgOutboundAttachmentStore(db));
    }
    return currentOutboundAttachmentStore();
  },
  inject: ["DB"],
};

/**
 * Inbound attachment backing (EXEC-WAHA-MEDIA-FETCH-20261020): when a database
 * pool exists, the persistent Pg store (`platform.inbound_attachments`,
 * migration 062) becomes the default lane for the webhook persist path (it
 * reads `currentInboundAttachmentStore()` at call time). Without a pool the
 * fail-closed empty registry stays active and verified downloads are queued
 * as ingest-pending exceptions instead of message rows. Test doubles keep
 * overriding it per-test.
 */
export const InboundAttachmentStoreProvider = {
  provide: "INBOUND_ATTACHMENT_STORE",
  useFactory: (db: Kysely<Database> | null) => {
    if (db !== null) {
      setInboundAttachmentStore(new PgInboundAttachmentStore(db));
    }
    return currentInboundAttachmentStore();
  },
  inject: ["DB"],
};
