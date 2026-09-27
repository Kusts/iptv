import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { CommandBus, type DbPort } from "./command-bus.js";
import { KyselyCommandDb } from "./kysely-command-db.js";
import { registerHumanReviewCommands } from "../human-review/human-review.commands.js";
import { registerPolicyCommands } from "../policy/policy.commands.js";
import { registerCapabilityCommands } from "../capabilities/capability.commands.js";
import { registerCrmCommands } from "../crm/crm.commands.js";
import { registerCommunicationCommands } from "../communications/communications.commands.js";
import { registerTrialCommands } from "../trial/trial.commands.js";
import { registerProviderCommands } from "../provider/provider.commands.js";
import { registerCommerceCommands } from "../commerce/commerce.commands.js";
import { registerBillingCommands } from "../billing/billing.commands.js";
import { registerSubscriptionCommands } from "../subscription/subscription.commands.js";
import { registerRenewalCommands } from "../renewal/renewal.commands.js";
import { registerFulfillmentCommands } from "../fulfillment/fulfillment.commands.js";
import { registerSupportCommands } from "../support/support.commands.js";
import { registerKnowledgeCommands } from "../knowledge/knowledge.commands.js";
import { registerClaimCommands } from "../human-review/claim.commands.js";
import { refundReviewResolvedHook, refundTargetRevalidator } from "../billing/refund-review.js";
import { asaasAdapterNameFromEnv, resolveAsaasPort } from "../billing/asaas-port.js";
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
 *   Knowledge items + `human_review.claim` for the HITL center).
 * Explicit tokens everywhere — esbuild/vitest emits no `design:paramtypes`.
 *
 * Provider adapters are explicit: `PROVIDER_OPS_ADAPTER=echo|manual`
 * (default `manual`); the real CINEVISION integration stays Wave-0-gated
 * and has no implementation here. Billing uses `ASAAS_ADAPTER=echo|real`
 * (default `echo`); `real` requires `ASAAS_API_KEY` + `ASAAS_BASE_URL` and
 * maps transport uncertainty to UNKNOWN_EFFECT (never auto-retries).
 */
export const CommandsProvider = {
  provide: CommandBus,
  useFactory: (commandDb: DbPort | null) => {
    const bus = new CommandBus(commandDb);
    if (commandDb !== null) {
      registerHumanReviewCommands(bus, {
        revalidate: refundTargetRevalidator,
        onResolved: refundReviewResolvedHook,
      });
      registerPolicyCommands(bus);
      registerCapabilityCommands(bus);
      registerCrmCommands(bus);
      registerCommunicationCommands(bus);
      const opsPort = resolveOpsPort(adapterNameFromEnv());
      registerTrialCommands(bus, { opsPort });
      registerProviderCommands(bus, { opsPort, readbackPort: new StubProviderReadback() });
      registerCommerceCommands(bus);
      registerBillingCommands(bus, { asaasPort: resolveAsaasPort(asaasAdapterNameFromEnv()) });
      registerSubscriptionCommands(bus);
      registerRenewalCommands(bus);
      registerFulfillmentCommands(bus, { opsPort });
      registerSupportCommands(bus);
      registerKnowledgeCommands(bus);
      registerClaimCommands(bus);
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
