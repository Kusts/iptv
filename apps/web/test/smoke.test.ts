import { describe, expect, it } from "vitest";
import { API_HEALTH_PATH, PROJECT_NAME } from "../app/lib";

describe("web bootstrap", () => {
  it("exposes the project name and API health placeholder", () => {
    expect(PROJECT_NAME).toBe("AI Revenue & Operations Platform");
    expect(API_HEALTH_PATH).toBe("/v1/health");
  });
});
