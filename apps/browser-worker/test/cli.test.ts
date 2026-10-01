import { describe, expect, it } from "vitest";
import { DomRequestError, parseArgs } from "../src/cli.js";
import { CINEVISION_READ_COMMANDS, FIXED_OPERATION } from "../src/constants.js";

function failsClosed(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    expect(message.length).toBeGreaterThan(0);
    return message;
  }
  throw new Error(`expected fail-closed for ${JSON.stringify(argv)}`);
}

describe("cli args", () => {
  it("accepts empty, --help and the fixed operation pair (legacy compat)", () => {
    expect(parseArgs([]).operation).toBe("cinevision.readIdentity");
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["--operation", FIXED_OPERATION]).operation).toBe("cinevision.readIdentity");
    expect(parseArgs([FIXED_OPERATION]).operation).toBe("cinevision.readIdentity");
  });

  it("exposes one subcommand per certified read capability", () => {
    expect(CINEVISION_READ_COMMANDS).toHaveLength(11);
    for (const entry of CINEVISION_READ_COMMANDS) {
      const argv: string[] = [entry.subcommand];
      if ((entry as { id?: boolean }).id === true) argv.push("--id", "test-id-1");
      if ((entry as { serverId?: boolean }).serverId === true) argv.push("--server-id", "srv-1");
      const parsed = parseArgs(argv);
      expect(parsed.operation).toBe(entry.operation);
    }
    // Dotted operations stay accepted as tokens (compat).
    expect(parseArgs(["cinevision.listServers"]).operation).toBe("cinevision.listServers");
    expect(parseArgs(["--operation", "cinevision.readCustomer", "--id", "cust-1"]).operation).toBe(
      "cinevision.readCustomer",
    );
  });

  it("accepts narrow id/pagination args where the command declares them", () => {
    expect(parseArgs(["read-customer", "--id", "cust-1"]).args).toEqual({ id: "cust-1" });
    expect(parseArgs(["read-customer-status", "--id", "cust-1"]).args).toEqual({ id: "cust-1" });
    expect(parseArgs(["read-connections", "--id", "cust-1"]).args).toEqual({ id: "cust-1" });
    expect(parseArgs(["list-customers", "--page", "2", "--per-page", "10"]).args).toEqual({
      page: 2,
      perPage: 10,
    });
    expect(
      parseArgs(["read-live-connections", "--server-id", "srv-1", "--page", "1"]).args,
    ).toEqual({ serverId: "srv-1", page: 1 });
    // `--flag=value` form works too.
    expect(parseArgs(["read-customer", "--id=cust-1"]).args).toEqual({ id: "cust-1" });
  });

  it("rejects missing required ids fail-closed", () => {
    expect(failsClosed(["read-customer"])).toMatch(/--id/);
    expect(failsClosed(["read-customer-status"])).toMatch(/--id/);
    expect(failsClosed(["read-connections"])).toMatch(/--id/);
    expect(failsClosed(["read-live-connections"])).toMatch(/--server-id/);
  });

  it("rejects mistyped ids and pagination WITHOUT echoing the raw value", () => {
    for (const argv of [
      ["read-customer", "--id", "../evil-SECRET123"],
      ["read-customer", "--id", ""],
      ["read-live-connections", "--server-id", "srv-1;DROP-SECRET123"],
      ["list-customers", "--page", "0"],
      ["list-customers", "--page", "101"],
      ["list-customers", "--page", "abc-SECRET123"],
      ["list-customers", "--per-page", "-1"],
      ["list-customers", "--per-page", "1.5"],
    ]) {
      const message = failsClosed(argv);
      expect(message, JSON.stringify(argv)).not.toContain("SECRET123");
      expect(message, JSON.stringify(argv)).not.toContain("evil");
    }
  });

  it("rejects irrelevant flags and unknown paths/urls/methods fail-closed", () => {
    // Pagination is not accepted where undeclared; ids only where declared.
    failsClosed(["list-servers", "--id", "srv-1"]);
    failsClosed(["list-servers", "--page", "1"]);
    failsClosed(["read-identity", "--id", "x"]);
    failsClosed(["read-customer", "--id", "cust-1", "--page", "1"]);
    // No path/URL/method configuration surface exists.
    failsClosed(["list-servers", "--url", "https://panel.example.test/api/servers"]);
    failsClosed(["list-servers", "--path", "/api/servers"]);
    failsClosed(["list-servers", "--method", "GET"]);
    failsClosed(["list-servers", "--origin", "https://panel.example.test"]);
  });

  it("rejects unknown flags WITHOUT echoing the raw value", () => {
    const evil = "--evil-flag-payload-SECRET123";
    const message = failsClosed([evil]);
    expect(message).not.toContain(evil);
    expect(message).not.toContain("SECRET123");
  });

  it("rejects unknown operations WITHOUT echoing the raw value", () => {
    const evil = "cinevision.dropDatabase-SECRET123";
    const message = failsClosed([evil]);
    expect(message).not.toContain(evil);
    expect(message).not.toContain("SECRET123");
  });

  it("rejects extra positionals and write-like subcommands fail-closed", () => {
    failsClosed(["list-servers", "extra"]);
    failsClosed(["cinevision.deleteCustomer"]);
    failsClosed(["cinevision.createCustomer"]);
    failsClosed(["--operation", "cinevision.deleteCustomer"]);
  });

  it("parses --operation=<value> without hanging (F1 infinite-loop regression)", () => {
    // The test itself is the proof: the old parser looped forever here
    // (no index increment), so the runner would hit its timeout and fail.
    const start = Date.now();
    expect(parseArgs(["--operation=cinevision.readIdentity"]).operation).toBe(
      "cinevision.readIdentity",
    );
    expect(parseArgs(["--operation=cinevision.listServers"]).operation).toBe(
      "cinevision.listServers",
    );
    // Flags after the `--operation=` form still parse (index advanced).
    expect(
      parseArgs(["--operation=read-customer", "--id", "cust-1"]).args,
    ).toEqual({ id: "cust-1" });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("rejects DOM selection attempts with an explicit fail-closed error", () => {
    for (const argv of [
      ["list-servers", "--selector", "form"],
      ["list-servers", "--dom"],
      ["list-servers", "--xpath", "//form"],
      ["list-servers", "--strategy", "dom"],
      ["list-servers", "--selector=.login"],
    ]) {
      try {
        parseArgs(argv);
      } catch (err) {
        expect(err, JSON.stringify(argv)).toBeInstanceOf(DomRequestError);
        continue;
      }
      throw new Error(`expected DomRequestError for ${JSON.stringify(argv)}`);
    }
  });
});
