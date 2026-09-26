import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { CommandBus, type DbPort } from "./command-bus.js";
import { KyselyCommandDb } from "./kysely-command-db.js";
import { registerHumanReviewCommands } from "../human-review/human-review.commands.js";
import { registerPolicyCommands } from "../policy/policy.commands.js";
import { registerCapabilityCommands } from "../capabilities/capability.commands.js";
import { registerCrmCommands } from "../crm/crm.commands.js";
import { registerCommunicationCommands } from "../communications/communications.commands.js";

/**
 * CommandBus provider: builds the bus over the `COMMAND_DB` port and
 * registers the Wave 1 command catalog (HumanReview substrate + Policy and
 * Capability foundations) plus the Wave 2 slice (CRM + Communications).
 * Explicit tokens everywhere — esbuild/vitest emits no `design:paramtypes`.
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
