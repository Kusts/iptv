import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { loadConfig } from "@iptv/config";
import { initObservability } from "@iptv/observability";
import { AppModule } from "./app.module.js";
import { createFastifyAdapter, registerRequestIdHook } from "./request-id.js";
import { registerObservabilityHook } from "./observability-hook.js";
import { SchedulerService } from "./scheduler/scheduler.service.js";

async function bootstrap(): Promise<void> {
  // W1-12 observability first (fail-safe: a throw here never breaks boot).
  try {
    await initObservability();
  } catch {
    // Noop path — boot proceeds without telemetry.
  }
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(config.LOG_LEVEL),
  );
  registerRequestIdHook(app);
  registerObservabilityHook(app);
  app.enableShutdownHooks();
  await app.listen(config.PORT, "0.0.0.0");
  // W1-08 in-process scheduler: opt-in via API_SCHEDULER_ENABLED=1
  // (default off). Runs in this process on an interval loop with per-task
  // failure isolation; stopping it never affects the API critical path.
  try {
    app.get(SchedulerService).start();
  } catch {
    // Scheduler is advisory; boot proceeds without background work.
  }
}

void bootstrap();
