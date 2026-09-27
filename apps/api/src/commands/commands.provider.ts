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
import {
  StubProviderReadback,
  adapterNameFromEnv,
  resolveOpsPort,
} from "../provider/provider-port.js";

/**
 * CommandBus provider: builds the bus over the `COMMAND_DB` port and
 * registers the Wave 1 command catalog (HumanReview substrate + Policy and
 * Capability foundations), the Wave 2 slice (CRM + Communications) and the
 * Wave 4 slice (Trials + Compatibility + Provider Operations).
 * Explicit tokens everywhere — esbuild/vitest emits no `design:paramtypes`.
 *
 * Provider adapters are explicit: `PROVIDER_OPS_ADAPTER=echo|manual`
 * (default `manual`); the real CINEVISION integration stays Wave-0-gated
 * and has no implementation here.
 */
export const CommandsProvider = {
  provide: CommandBus,
  useFactory: (commandDb: DbPort | null) => {
    const bus = new CommandBus(commandDb);
    if (commandDb !== null) {
      registerHumanReviewCommands(bus);
      registerPolicyCommands(bus);
      registerCapabilityCommands(bus);
      registerCrmCommands(bus);
      registerCommunicationCommands(bus);
      const opsPort = resolveOpsPort(adapterNameFromEnv());
      registerTrialCommands(bus, { opsPort });
      registerProviderCommands(bus, { opsPort, readbackPort: new StubProviderReadback() });
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
