import { type HealthResponse, healthResponseSchema } from "@fiftysix/protocol";
import type { Hono } from "hono";
import type { Logger } from "pino";

import type { ApplicationStorage } from "../storage/storage.js";

export interface HealthRouteDependencies {
  storage: ApplicationStorage;
  logger: Logger;
}

function healthResponse(status: HealthResponse["status"]): HealthResponse {
  return healthResponseSchema.parse({ status });
}

export function registerHealthRoute(
  app: Hono,
  dependencies: HealthRouteDependencies,
): void {
  app.get("/healthz", async (context) => {
    try {
      await dependencies.storage.checkHealth();
      return context.json(healthResponse("ok"), 200);
    } catch {
      dependencies.logger.error("Storage health check failed");
      return context.json(healthResponse("unavailable"), 503);
    }
  });
}
