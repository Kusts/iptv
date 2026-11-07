import { describe, expect, it } from "vitest";
import {
  buildIntegrationSecretRef,
  deriveIntegrationSecretRef,
  parseIntegrationSecretRef,
  type IntegrationProvider,
} from "../src/index.js";

/**
 * SIMPLIFY-01: backend-owned secondary keys (`CINEVISION_PASS`,
 * `ASAAS_WEBHOOK_TOKEN`) must be derived from the principal binding ref so a
 * legacy `infisical://` binding keeps resolving both credentials after the
 * PostgreSQL migration, while freshly configured bindings stay `pgsecret://`.
 */
const TENANT = "11111111-1111-4111-8111-111111111111";

function legacyRef(provider: IntegrationProvider, key: string, environment = "SANDBOX"): string {
  return `infisical://${environment}/integrations/${TENANT}/${provider}/${key}`;
}

function pgRef(provider: IntegrationProvider, key: string, environment = "SANDBOX"): string {
  return buildIntegrationSecretRef({ tenantId: TENANT, provider, environment, key });
}

function codeOf(err: unknown): string | null {
  return err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : null;
}

describe("deriveIntegrationSecretRef", () => {
  it("preserves the legacy infisical:// scheme of the principal binding ref", () => {
    const bindingRef = legacyRef("cinevision", "CINEVISION_USER");
    const passRef = deriveIntegrationSecretRef(bindingRef, "CINEVISION_PASS");
    expect(passRef).toBe(legacyRef("cinevision", "CINEVISION_PASS"));
    expect(passRef.startsWith("infisical://")).toBe(true);
    // Same tenant/provider/environment scope as the binding.
    expect(parseIntegrationSecretRef(passRef)).toMatchObject({
      tenantId: TENANT,
      provider: "cinevision",
      environment: "SANDBOX",
      key: "CINEVISION_PASS",
    });
  });

  it("keeps the current pgsecret:// scheme for new bindings", () => {
    const bindingRef = pgRef("asaas", "ASAAS_API_KEY");
    expect(deriveIntegrationSecretRef(bindingRef, "ASAAS_WEBHOOK_TOKEN")).toBe(
      pgRef("asaas", "ASAAS_WEBHOOK_TOKEN"),
    );
  });

  it("preserves the exact principal prefix (environment spelling included)", () => {
    const bindingRef = "infisical://sandbox/integrations/acme/asaas/ASAAS_API_KEY";
    expect(deriveIntegrationSecretRef(bindingRef, "ASAAS_WEBHOOK_TOKEN")).toBe(
      "infisical://sandbox/integrations/acme/asaas/ASAAS_WEBHOOK_TOKEN",
    );
  });

  it("rejects a key that is not allowlisted for the principal provider", () => {
    const err = (() => {
      try {
        deriveIntegrationSecretRef(legacyRef("asaas", "ASAAS_API_KEY"), "CINEVISION_PASS");
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(codeOf(err)).toBe("MALFORMED_REF");
  });

  it("rejects a principal ref outside the integrations namespace", () => {
    for (const ref of [
      `infisical://SANDBOX/${TENANT}/asaas/ASAAS_API_KEY`,
      `pgsecret://SANDBOX/integrations/${TENANT}/unknown/ASAAS_API_KEY`,
      "http://example.test/x",
    ]) {
      const err = (() => {
        try {
          deriveIntegrationSecretRef(ref, "ASAAS_API_KEY");
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(codeOf(err)).toBe("MALFORMED_REF");
    }
  });
});
