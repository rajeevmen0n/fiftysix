import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import { helloMessageSchema, serverMessageSchema } from "@fiftysix/protocol";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSMessageReceive } from "hono/ws";
import type { Logger } from "pino";

import type { AppConfig } from "./config.js";
import { registerHealthRoute } from "./routes/health.js";
import type { ApplicationStorage } from "./storage/storage.js";
import type { ConnectionRegistry } from "./ws/connection-registry.js";
import {
  closeWithProtocolError,
  createSocketPeer,
  maximumMessageSizeBytes,
} from "./ws/connection-socket.js";
import type { HelloHandler, SocketPeer } from "./ws/hello-handler.js";

export interface AppDependencies {
  config: AppConfig;
  storage: ApplicationStorage;
  logger: Logger;
  helloHandler: HelloHandler;
  connections: ConnectionRegistry;
}

type NodeServer = HttpServer | Http2Server | Http2SecureServer;
type WebSocketInjector = (server: NodeServer) => void;

const websocketInjectors = new WeakMap<Hono, WebSocketInjector>();

function originIsAllowed(
  allowedOrigins: readonly string[] | null,
  origin: string | undefined,
): boolean {
  return (
    allowedOrigins === null ||
    (origin !== undefined && allowedOrigins.includes(origin))
  );
}

function messageText(data: WSMessageReceive): string | null {
  return typeof data === "string" ? data : null;
}

function messageSizeBytes(data: WSMessageReceive): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8");
  }

  return data instanceof Blob ? data.size : data.byteLength;
}

function isHelloEnvelope(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "hello"
  );
}

function handleFirstMessage(
  data: WSMessageReceive,
  peer: SocketPeer,
  dependencies: AppDependencies,
): void {
  if (messageSizeBytes(data) > maximumMessageSizeBytes) {
    closeWithProtocolError(peer, "message_too_large");
    return;
  }

  const text = messageText(data);
  if (text === null) {
    closeWithProtocolError(peer, "invalid_message");
    return;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    closeWithProtocolError(peer, "invalid_message");
    return;
  }

  if (!isHelloEnvelope(decoded)) {
    closeWithProtocolError(peer, "hello_required");
    return;
  }

  const parsed = helloMessageSchema.safeParse(decoded);
  if (!parsed.success) {
    closeWithProtocolError(peer, "invalid_message");
    return;
  }

  void Promise.resolve()
    .then(() => dependencies.helloHandler.handle(parsed.data.token, peer))
    .catch(() => {
      dependencies.logger.error("WebSocket hello handler failed");
      peer.close(1_011);
    });
}

export function injectAppWebSocket(app: Hono, server: NodeServer): void {
  const injectWebSocket = websocketInjectors.get(app);
  if (injectWebSocket === undefined) {
    throw new Error("The Hono app was not created by createApp");
  }

  injectWebSocket(server);
}

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  websocketInjectors.set(app, injectWebSocket);

  registerHealthRoute(app, dependencies);

  app.get("/ws", (context) => {
    if (
      !originIsAllowed(
        dependencies.config.allowedOrigins,
        context.req.header("origin"),
      )
    ) {
      const response = serverMessageSchema.parse({
        type: "error",
        code: "origin_not_allowed",
      });
      return context.json(response, 403);
    }

    let peer: SocketPeer | null = null;
    let firstMessageReceived = false;

    return upgradeWebSocket(
      context,
      {
        onOpen(_event, socket) {
          peer = createSocketPeer(socket, dependencies.logger, () => {
            if (peer !== null) {
              dependencies.connections.delete(peer);
              peer = null;
            }
          });
          dependencies.connections.add(peer);
        },
        onMessage(event) {
          if (peer === null) {
            return;
          }

          if (firstMessageReceived) {
            closeWithProtocolError(peer, "invalid_message");
            return;
          }

          firstMessageReceived = true;
          handleFirstMessage(event.data, peer, dependencies);
        },
        onClose() {
          if (peer !== null) {
            dependencies.connections.delete(peer);
            peer = null;
          }
        },
        onError() {
          if (peer !== null) {
            dependencies.connections.delete(peer);
            peer = null;
          }
        },
      },
      {
        onError() {
          dependencies.logger.error("WebSocket event handler failed");
        },
      },
    );
  });

  return app;
}
