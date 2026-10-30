import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealAsaasAdapter } from "../src/billing/asaas-port.js";

// G01A (#90 parte 4.1): qrCode deve ser SOMENTE o payload copia-e-cola.
// Quando o provider retorna só encodedImage (Base64), qrCode fica null.
describe("G01A pix payload only (mocked fetch, no network)", () => {
  const API_KEY = "test-key-not-a-secret";
  const BASE_URL = "https://sandbox.test";

  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    process.env["ASAAS_API_KEY"] = API_KEY;
    process.env["ASAAS_BASE_URL"] = BASE_URL;
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env["ASAAS_API_KEY"];
    delete process.env["ASAAS_BASE_URL"];
    globalThis.fetch = originalFetch as typeof fetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it("qrCode is null when provider returns only encodedImage (never the image)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_pix_img_only" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { payload: null, encodedImage: "aW1hZ2UtYmFzZTY0", expirationDate: null }),
    );
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-g01a-img-only",
      valueMinor: 1990n,
      currency: "BRL",
      payer: { personId: "person-1" },
      providerCustomerId: "cus_x",
    });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.providerChargeId).toBe("pay_pix_img_only");
    expect(created.qrCode).toBeNull();
    expect(created.qrCode).not.toBe("aW1hZ2UtYmFzZTY0");
  });

  it("qrCode is the payload when provider returns payload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: "pay_pix_payload" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        payload: "00020126580014br.gov.bcb.pix0136pay_pix_payload520400005303986540519.905802BR5913FULANO6009SAOPAULO62070503***6304ABCD",
        encodedImage: "aW1hZ2UtYmFzZTY0",
        expirationDate: null,
      }),
    );
    const port = new RealAsaasAdapter();
    const created = await port.createPixCharge({
      chargeId: "charge-g01a-payload",
      valueMinor: 1990n,
      currency: "BRL",
      payer: { personId: "person-1" },
      providerCustomerId: "cus_x",
    });
    expect(created.effect).toBe("KNOWN_APPLIED");
    expect(created.qrCode).toBe(
      "00020126580014br.gov.bcb.pix0136pay_pix_payload520400005303986540519.905802BR5913FULANO6009SAOPAULO62070503***6304ABCD",
    );
  });
});
