import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import { FIXED_OPERATION } from "../src/constants.js";

describe("cli args", () => {
  it("accepts empty, --help and the fixed operation pair", () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--operation", FIXED_OPERATION])).toEqual({ help: false });
    expect(parseArgs([FIXED_OPERATION])).toEqual({ help: false });
  });

  it("rejects unknown flags WITHOUT echoing the raw value", () => {
    const evil = "--evil-flag-payload-SECRET123";
    let message = "";
    try {
      parseArgs([evil]);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(evil);
    expect(message).not.toContain("SECRET123");
  });

  it("rejects unknown operations WITHOUT echoing the raw value", () => {
    const evil = "cinevision.dropDatabase-SECRET123";
    let message = "";
    try {
      parseArgs([evil]);
    } catch (err) {
      message = err instanceof Error ? err.message : "";
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(evil);
    expect(message).not.toContain("SECRET123");
  });
});
