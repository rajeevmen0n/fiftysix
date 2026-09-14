import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer, Http2Server } from "node:http2";
import { helloMessageSchema, serverMessageSchema } from "@fiftysix/protocol";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { type Context, Hono } from "hono";
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
  webRoot?: string;
}

type NodeServer = HttpServer | Http2Server | Http2SecureServer;
type WebSocketInjector = (server: NodeServer) => void;

const websocketInjectors = new WeakMap<Hono, WebSocketInjector>();

const permissionsPolicy = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "publickey-credentials-get=()",
  "usb=()",
].join(", ");

const hashedAssetPattern = /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/;

function contentSecurityPolicy(requestUrl: string): string {
  const host = new URL(requestUrl).host;

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function setSecurityHeaders(context: Context, requestUrl: string): void {
  context.header("Content-Security-Policy", contentSecurityPolicy(requestUrl));
  context.header("Permissions-Policy", permissionsPolicy);
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
}

function isReservedServerPath(path: string): boolean {
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/healthz" ||
    path.startsWith("/healthz/") ||
    path === "/ws" ||
    path.startsWith("/ws/") ||
    path === "/debug" ||
    path.startsWith("/debug/")
  );
}

function canServeWeb(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && !isReservedServerPath(path);
}

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

  app.use("*", async (context, next) => {
    setSecurityHeaders(context, context.req.url);
    await next();
  });

  registerHealthRoute(app, dependencies);

  app.get("/ws", (context) => {
    if (context.req.method !== "GET") {
      return context.notFound();
    }

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

  if (dependencies.webRoot !== undefined) {
    const staticFiles = serveStatic({
      root: dependencies.webRoot,
      onFound(path, context) {
        context.header(
          "Cache-Control",
          hashedAssetPattern.test(path)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
    const spaShell = serveStatic({
      root: dependencies.webRoot,
      path: "index.html",
      onFound(_path, context) {
        context.header("Cache-Control", "no-cache");
      },
    });

    app.use("*", async (context, next) => {
      if (!canServeWeb(context.req.method, context.req.path)) {
        return next();
      }

      return staticFiles(context, next);
    });

    app.on(["GET", "HEAD"], "*", async (context) => {
      if (!canServeWeb(context.req.method, context.req.path)) {
        return context.notFound();
      }

      const response = await spaShell(context, async () => undefined);
      return response ?? context.notFound();
    });
  }

  return app;
}
