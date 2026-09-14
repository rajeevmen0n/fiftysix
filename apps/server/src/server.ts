import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAdaptorServer } from "@hono/node-server";
import type { Logger } from "pino";

import { createApp, injectAppWebSocket } from "./app.js";
import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createSystemClock } from "./runtime/clock.js";
import { createCryptoRandomSource } from "./runtime/random.js";
import { createSystemScheduler } from "./runtime/scheduler.js";
import { createShutdownCoordinator } from "./runtime/shutdown.js";
import {
  type ApplicationStorage,
  createStorageFactory,
} from "./storage/storage.js";
import { createConnectionRegistry } from "./ws/connection-registry.js";
import type { HelloHandler } from "./ws/hello-handler.js";

export interface RunningServer {
  address: string;
  close(): Promise<void>;
}

function createRejectingHelloHandler(): HelloHandler {
  return {
    async handle(_token, peer) {
      peer.send({ type: "error", code: "invalid_token" });
      peer.close(1_008);
    },
  };
}

function resolveWebRoot(): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "web"),
    resolve(moduleDirectory, "../web"),
    resolve(moduleDirectory, "../../../dist/web"),
  ];

  const webDirectory = candidates.find((candidate) => existsSync(candidate));
  if (webDirectory === undefined) {
    return undefined;
  }

  return relative(process.cwd(), webDirectory) || ".";
}

function listen(server: HttpServer, config: AppConfig): Promise<AddressInfo> {
  return new Promise((resolveListening, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Server did not report a TCP listening address"));
        return;
      }
      resolveListening(address);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

function beginServerClose(server: HttpServer): {
  begin(): void;
  finished(): Promise<void>;
} {
  let begun = false;
  let resolveFinished: (() => void) | undefined;
  let rejectFinished: ((error: Error) => void) | undefined;
  const closeFinished = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveFinished = resolvePromise;
    rejectFinished = rejectPromise;
  });

  return {
    begin() {
      if (begun) {
        return;
      }
      begun = true;
      server.close((error) => {
        if (error === undefined) {
          resolveFinished?.();
        } else {
          rejectFinished?.(error);
        }
      });
    },
    finished() {
      return closeFinished;
    },
  };
}

function serverUrl(host: string, port: number): string {
  const displayedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${displayedHost}:${port}`;
}

function logStartupFailure(logger: Logger, error: unknown): void {
  logger.error(
    {
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      errorType: error instanceof Error ? error.name : "UnknownError",
    },
    "Server startup failed",
  );
}

export async function startServer(config: AppConfig): Promise<RunningServer> {
  const logger = createLogger(config);
  const clock = createSystemClock();
  const runtime = {
    clock,
    random: createCryptoRandomSource(),
    scheduler: createSystemScheduler(clock),
  };
  let storage: ApplicationStorage | undefined;

  try {
    storage = await createStorageFactory().open(config.databaseUrl);
    await storage.migrate();

    const connections = createConnectionRegistry();
    const app = createApp({
      config,
      storage,
      logger,
      helloHandler: createRejectingHelloHandler(),
      connections,
      webRoot: resolveWebRoot(),
    });
    const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;
    injectAppWebSocket(app, server);

    const listeningAddress = await listen(server, config);
    const closeServer = beginServerClose(server);
    const shutdown = createShutdownCoordinator();

    shutdown.add({ close: closeServer.begin });
    shutdown.add({ close: () => connections.closeAll(1_001) });
    shutdown.add(runtime.scheduler);
    shutdown.add({ close: closeServer.finished });
    shutdown.add(storage);

    const address = serverUrl(config.host, listeningAddress.port);
    logger.info({ address }, "Server listening");

    return {
      address,
      async close() {
        try {
          await shutdown.close();
          logger.info("Server stopped");
        } catch (error) {
          logger.error(
            {
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
            "Server shutdown failed",
          );
          throw error;
        }
      },
    };
  } catch (error) {
    runtime.scheduler.close();
    await storage?.close().catch(() => undefined);
    logStartupFailure(logger, error);
    throw error;
  }
}
