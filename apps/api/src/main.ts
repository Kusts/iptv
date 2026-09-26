import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { loadConfig } from "@iptv/config";
import { AppModule } from "./app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "./request-id.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(config.LOG_LEVEL),
  );
  registerRequestIdHook(app);
  app.enableShutdownHooks();
  await app.listen(config.PORT, "0.0.0.0");
}

void bootstrap();
