import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST,
  __resetCspReportBudgetForTests,
} from "../app/api/csp-report/route";

// Regressão do FIX-CSP-REPORT-20261020: a rota continua 204 sempre, mas
// - descarta corpo gigante sem carregar tudo (cap durante a leitura);
// - aplica orçamento de logs (rajada além de N/min não loga);
// - descarta formato inválido (só JSON com violated-directive conhecido);
// - nunca loga URLs/query integrais.

function validBody(): string {
  return JSON.stringify({
    "csp-report": {
      "violated-directive": "img-src",
      "effective-directive": "img-src",
      "document-uri": "https://example.com/page?token=secret&x=1",
      "blocked-uri": "https://evil.example/pixel?x=1",
    },
  });
}

function postRequest(body: string): Request {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body,
  });
}

describe("csp-report route (FIX-CSP-REPORT-20261020)", () => {
  beforeEach(() => {
    __resetCspReportBudgetForTests();
    vi.restoreAllMocks();
  });

  it("loga report válido com só campos permitidos (sem URLs)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await POST(postRequest(validBody()));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[1] ?? "");
    expect(logged).toContain("img-src");
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain("token=secret");
  });

  it("descarta corpo gigante sem logar (cap durante a leitura)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const big = JSON.stringify({
      "csp-report": {
        "violated-directive": "img-src",
        padding: "x".repeat(64 * 1024),
      },
    });
    expect(big.length).toBeGreaterThan(8 * 1024);
    const res = await POST(postRequest(big));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rajada além do orçamento não loga (drop silencioso, segue 204)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let lastStatus = 0;
    for (let i = 0; i < 15; i++) {
      const res = await POST(postRequest(validBody()));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(204);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(10);
    expect(warn.mock.calls.length).toBeLessThan(15);
  });

  it("descarta formato inválido sem logar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cases = [
      "não é json {{{",
      JSON.stringify({ hello: "world" }),
      JSON.stringify({ "csp-report": { "document-uri": "https://x/" } }),
      JSON.stringify({
        "csp-report": { "violated-directive": "https://evil/?x=1" },
      }),
      "",
    ];
    for (const body of cases) {
      const res = await POST(postRequest(body));
      expect(res.status).toBe(204);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
