import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { IncomingMessage } from "node:http";
import { newId } from "@iptv/domain";
import { registerAttachmentUploadParser } from "./communications/attachment-upload-parser.js";

/**
 * Single request id established at the HTTP boundary: reuse an inbound
 * `x-request-id` when it is a valid UUID (v4 or v7), otherwise generate a
 * UUIDv7. Fastify logs `req.id` by default, so controller bodies and logs
 * share the same id.
 */
const REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

/** Fastify `genReqId`: prefer a valid inbound id, else generate UUIDv7. */
export function genRequestId(req: Pick<IncomingMessage, "headers">): string {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  if (isValidRequestId(candidate)) {
    return candidate;
  }
  return newId();
}

/** Shared Fastify adapter so `main.ts` and tests use the same id policy. */
export function createFastifyAdapter(loggerLevel?: string): FastifyAdapter {
  const adapter = new FastifyAdapter({
    logger: loggerLevel ? { level: loggerLevel } : false,
    genReqId: genRequestId,
  });
  // Vendor upload media type (scoped 48 MiB body limit; the global JSON
  // limit stays at the Fastify default). Registered here so every app
  // instance — production and tests — parses uploads identically.
  registerAttachmentUploadParser(adapter.getInstance());
  return adapter;
}

/** Mirror `request.id` on every response as `x-request-id`. */
export function registerRequestIdHook(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook("onRequest", (req, reply, done) => {
    reply.header("x-request-id", req.id);
    done();
  });
}
