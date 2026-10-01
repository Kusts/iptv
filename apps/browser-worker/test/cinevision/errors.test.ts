import { describe, expect, it } from "vitest";
import {
  classifyHttpFailure,
  isChallengeBody,
  isChallengeSignals,
  isJsonContentType,
  transportError,
} from "../../src/providers/cinevision/errors.js";

describe("isJsonContentType", () => {
  it("accepts application/json with charset suffix and case variance", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("Application/JSON")).toBe(true);
  });

  it("rejects html and empty content types", () => {
    expect(isJsonContentType("text/html; charset=utf-8")).toBe(false);
    expect(isJsonContentType("")).toBe(false);
  });
});

describe("isChallengeBody", () => {
  it("detects interstitial evidence (title in <title>, or script plus structural markers)", () => {
    expect(isChallengeBody("<html><title>Um momento…</title>cf-mitigated</html>")).toBe(true);
    expect(
      isChallengeBody(
        "<html><head><title>Just a moment</title></head><body>checking your browser</body></html>",
      ),
    ).toBe(true);
    expect(
      isChallengeBody(
        '<html><head><script src="/turnstile.js"></script></head><body><form action="/x">verify you are human</form></body></html>',
      ),
    ).toBe(true);
  });

  it("requires the challenge phrase inside <title> (body text alone is not enough)", () => {
    expect(isChallengeBody("Just a moment, checking your browser")).toBe(false);
    expect(isChallengeBody("<html><body>Just a moment, checking your browser</body></html>")).toBe(
      false,
    );
    expect(isChallengeBody("turnstile challenge-platform")).toBe(false);
  });

  it("does not flag plain error pages or an isolated challenge script", () => {
    expect(isChallengeBody("<html><title>NOT_FOUND</title>oops</html>")).toBe(false);
    expect(isChallengeBody("")).toBe(false);
    for (const family of ["challenge-platform", "turnstile", "cf-challenge"]) {
      expect(
        isChallengeBody(
          `<html><head><script src="/cdn-cgi/${family}/h/b/scripts.js"></script></head></html>`,
        ),
      ).toBe(false);
    }
  });

  it("F1: ignores structural markers born inside script tags/attributes", () => {
    // Exact false-positive shape: "<form" lives in a script attribute only.
    expect(
      isChallengeBody('<html><head><script src="/turnstile.js" data-info="<form"></script></head></html>'),
    ).toBe(false);
    // Same shape for every script family: attribute marker is not evidence.
    for (const family of ["challenge-platform", "turnstile", "cf-challenge"]) {
      expect(
        isChallengeBody(
          `<html><head><script src="/cdn-cgi/${family}/x.js" data-info="<form"></script></head><body>deny</body></html>`,
        ),
        family,
      ).toBe(false);
    }
    // Phrase marker inside a script attribute is not evidence either.
    expect(
      isChallengeBody(
        '<html><head><script src="/app.js" data-info="checking your browser"></script></head><body>deny</body></html>',
      ),
    ).toBe(false);
    // Marker inside an inline JS string is not a real element/phrase.
    expect(
      isChallengeBody('<html><head><script>var s="<form>";</script></head><body>deny</body></html>'),
    ).toBe(false);
    expect(
      isChallengeBody(
        '<html><head><script src="/cdn-cgi/challenge-platform/x.js"></script><script>var s="verify you are human";</script></head><body>deny</body></html>',
      ),
    ).toBe(false);
  });

  it("F2: inspects inline script content and requires a real form outside scripts", () => {
    // Positive: inline family code + a real <form> opening tag -> challenge.
    expect(
      isChallengeBody('<script>turnstile.render("#challenge")</script><form id="challenge"></form>'),
    ).toBe(true);
    for (const family of ["challenge-platform", "turnstile", "cf-challenge"]) {
      expect(
        isChallengeBody(`<script>init("${family}")</script><form action="/x"></form>`),
        family,
      ).toBe(true);
    }
    // Negative: inline family code with NO real form/title -> not a challenge.
    expect(isChallengeBody('<script>turnstile.render("#x")</script><p>deny</p>')).toBe(false);
    for (const family of ["challenge-platform", "turnstile", "cf-challenge"]) {
      expect(isChallengeBody(`<script>init("${family}")</script><p>deny</p>`), family).toBe(false);
    }
  });
});

describe("isChallengeSignals", () => {
  it("accepts a known localized title without any script", () => {
    expect(
      isChallengeSignals({ title: "Um momento…", hasChallengeScript: false, markers: [] }),
    ).toBe(true);
    expect(
      isChallengeSignals({ title: "Just a moment please", hasChallengeScript: false, markers: [] }),
    ).toBe(true);
  });

  it("requires structural interstitial markers alongside a challenge script", () => {
    expect(
      isChallengeSignals({ title: "Forbidden", hasChallengeScript: true, markers: ["<form"] }),
    ).toBe(true);
    expect(
      isChallengeSignals({
        title: "Forbidden",
        hasChallengeScript: true,
        markers: ["verify you are human"],
      }),
    ).toBe(true);
    expect(
      isChallengeSignals({ title: "Forbidden", hasChallengeScript: true, markers: [] }),
    ).toBe(false);
    expect(
      isChallengeSignals({ title: "Forbidden", hasChallengeScript: false, markers: ["<form"] }),
    ).toBe(false);
  });

  it("rejects script-family strings sitting in markers (disjoint families)", () => {
    for (const family of ["turnstile", "cf-challenge", "challenge-platform"]) {
      expect(
        isChallengeSignals({ title: "Forbidden", hasChallengeScript: true, markers: [family] }),
      ).toBe(false);
    }
  });

  it("rejects an isolated script of every recognized family", () => {
    // hasChallengeScript is computed in-page from <script> tags only;
    // markers come from the disjoint structural family, so a lone
    // script tag of any family has markers [] -> never a challenge.
    expect(
      isChallengeSignals({ title: "Forbidden", hasChallengeScript: true, markers: [] }),
    ).toBe(false);
  });
});

describe("classifyHttpFailure", () => {
  it("maps 401 to SESSION_EXPIRED and 402 to INTEGRATION_INACTIVE", () => {
    expect(classifyHttpFailure({ status: 401, contentType: "", bodyText: "" })).toBe(
      "SESSION_EXPIRED",
    );
    expect(
      classifyHttpFailure({
        status: 402,
        contentType: "application/json",
        bodyText: '{"error":"integration_inactive"}',
      }),
    ).toBe("INTEGRATION_INACTIVE");
  });

  it("maps 403 JSON to PERMISSION_DENIED without inspecting the body", () => {
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "application/json",
        bodyText: '{"message":"Proibido"}',
      }),
    ).toBe("PERMISSION_DENIED");
  });

  it("maps 403 HTML with challenge signals to CHALLENGE", () => {
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "text/html",
        html: { title: "Um momento…", hasChallengeScript: false, markers: [] },
      }),
    ).toBe("CHALLENGE");
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "text/html",
        html: { title: "Forbidden", hasChallengeScript: true, markers: ["<form"] },
      }),
    ).toBe("CHALLENGE");
  });

  it("maps 403 HTML with only an isolated script to HTTP_FAILURE", () => {
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "text/html",
        html: { title: "Forbidden", hasChallengeScript: true, markers: [] },
      }),
    ).toBe("HTTP_FAILURE");
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "text/html",
        bodyText:
          '<html><head><script src="/cdn-cgi/challenge-platform/h/b/scripts.js"></script></head></html>',
      }),
    ).toBe("HTTP_FAILURE");
    for (const family of ["turnstile", "cf-challenge"]) {
      expect(
        classifyHttpFailure({
          status: 403,
          contentType: "text/html",
          bodyText: `<html><head><script src="/cdn-cgi/${family}/x.js"></script></head></html>`,
        }),
      ).toBe("HTTP_FAILURE");
    }
  });

  it("maps 403 HTML without markers to HTTP_FAILURE (never assumed challenge)", () => {
    expect(
      classifyHttpFailure({
        status: 403,
        contentType: "text/html",
        bodyText: "<title>Forbidden</title>",
      }),
    ).toBe("HTTP_FAILURE");
  });

  it("maps 404 and 5xx to HTTP_FAILURE", () => {
    expect(
      classifyHttpFailure({ status: 404, contentType: "text/html", bodyText: "nope" }),
    ).toBe("HTTP_FAILURE");
    expect(
      classifyHttpFailure({
        status: 500,
        contentType: "application/json",
        bodyText: '{"message":"boom"}',
      }),
    ).toBe("HTTP_FAILURE");
  });

  it("maps 429 to RATE_LIMITED", () => {
    expect(classifyHttpFailure({ status: 429, contentType: "", bodyText: "" })).toBe(
      "RATE_LIMITED",
    );
  });
});

describe("transportError", () => {
  it("carries UNKNOWN effect certainty and no HTTP status", () => {
    const err = transportError("/api/customers", 12);
    expect(err.code).toBe("TRANSPORT");
    expect(err.effectCertainty).toBe("UNKNOWN");
    expect(err.evidence.status).toBeNull();
    expect(err.detail).not.toContain("token");
  });
});
