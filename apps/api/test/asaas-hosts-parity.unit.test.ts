import { describe, expect, it } from "vitest";
import { ASAAS_TENANT_HOSTS } from "../src/billing/asaas-port.js";
import { ASAAS_HOSTS } from "../src/integrations/integrations.commands.js";

/**
 * S2C hosts parity: `ASAAS_TENANT_HOSTS` (billing read path) MUST mirror
 * `ASAAS_HOSTS` (integrations write/probe path). A change to one map
 * without the other fails this test — update both on purpose.
 */
describe("asaas hosts parity", () => {
  it("ASAAS_TENANT_HOSTS mirrors ASAAS_HOSTS (no silent drift)", () => {
    expect({ ...ASAAS_TENANT_HOSTS }).toEqual({ ...ASAAS_HOSTS });
  });
});
