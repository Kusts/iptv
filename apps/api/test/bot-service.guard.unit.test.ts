import { describe, expect, it, vi } from "vitest";
import { BotServiceGuard } from "../src/bot/bot-service.guard.js";
import { botServiceActor } from "../src/bot/bot-service-actor.js";

vi.mock("../src/bot/bot-credential-resolver.js", () => ({
  resolveBotCredential: vi.fn(async () => ({ credentialId: "cred-1", tenantId: "tenant-1", scopes: ["bot.streammax.execute"] })),
}));

function ctx(headers: Record<string, string> = {}, url = "/v1/bot/streammax/get-fulfillment") {
  const req = { headers, url } as never;
  return { switchToHttp: () => ({ getRequest: () => req }), req } as never;
}
const db = {} as never;
const config = { STREAMMAX_BOT_API_ENABLED: "true", BOT_SERVICE_TOKEN_PEPPER: "pepper" } as never;

describe("BotServiceGuard", () => {
  it("rejects missing bearer and cookie-only credentials uniformly", async () => {
    for (const headers of [{}, { cookie: "iptv_session=secret" }] as Record<string, string>[]) {
      await expect(new BotServiceGuard(db, config).canActivate(ctx(headers))).rejects.toMatchObject({ status: 401 });
    }
  });
  it("hides disabled routes", async () => {
    await expect(new BotServiceGuard(db, { STREAMMAX_BOT_API_ENABLED: "false", BOT_SERVICE_TOKEN_PEPPER: "pepper" } as never).canActivate(ctx())).rejects.toMatchObject({ status: 404 });
  });
  it("fails closed without pepper", async () => {
    await expect(new BotServiceGuard(db, { STREAMMAX_BOT_API_ENABLED: "true", BOT_SERVICE_TOKEN_PEPPER: undefined } as never).canActivate(ctx())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects missing execute scope", async () => {
    const resolver = await import("../src/bot/bot-credential-resolver.js");
    vi.mocked(resolver.resolveBotCredential).mockResolvedValueOnce({ credentialId: "c", tenantId: "t", scopes: [] });
    await expect(new BotServiceGuard(db, config).canActivate(ctx({ authorization: "Bearer abc" }))).rejects.toMatchObject({ status: 403 });
  });
  it("get-fulfillment inherits the execute-scope gate (403)", async () => {
    const resolver = await import("../src/bot/bot-credential-resolver.js");
    vi.mocked(resolver.resolveBotCredential).mockResolvedValueOnce({ credentialId: "c", tenantId: "t", scopes: [] });
    await expect(new BotServiceGuard(db, config).canActivate(ctx({ authorization: "Bearer abc" }, "/v1/bot/streammax/get-fulfillment")))
      .rejects.toMatchObject({ status: 403 });
  });
  it("builds an actor from the resolved credential tenant", () => {
    expect(botServiceActor({ credentialId: "c", tenantId: "tenant-credential", scopes: [], tokenPrefix: "12345678" }))
      .toMatchObject({ userId: "streammax-bot:c", tenantId: "tenant-credential", actorType: "external", isPlatformAdmin: false, roleKeys: [] });
  });
});
