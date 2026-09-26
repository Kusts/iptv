import type { Kysely } from "kysely";
import type { Database } from "@iptv/database";
import { KyselyInboxStore } from "./inbox-processor.js";

export const InboxStoreProvider = {
  provide: "INBOX_STORE",
  useFactory: (db: Kysely<Database> | null) => new KyselyInboxStore(db),
  inject: ["DB"],
};
