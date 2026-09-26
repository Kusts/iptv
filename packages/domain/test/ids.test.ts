import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";

describe("ids", () => {
  it("generates UUIDv7-shaped ids (version nibble 7, RFC 4122 variant)", () => {
    const id = newId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique ids", () => {
    const seen = new Set(Array.from({ length: 100 }, () => newId()));
    expect(seen.size).toBe(100);
  });
});
