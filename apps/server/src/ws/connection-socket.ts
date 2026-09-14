import {
  type ProtocolErrorCode,
  type ServerMessage,
  serverMessageSchema,
} from "@fiftysix/protocol";
import type { Logger } from "pino";

import type { SocketPeer } from "./hello-handler.js";

export const maximumMessageSizeBytes = 65_536;

export const protocolCloseCodes = {
  hello_required: 1_008,
  invalid_message: 1_007,
  message_too_large: 1_009,
} as const satisfies Record<
  Exclude<ProtocolErrorCode, "invalid_token" | "origin_not_allowed">,
  number
>;

export interface WebSocketConnection {
  send(data: string): void;
  close(code?: number): void;
}

export function createSocketPeer(
  socket: WebSocketConnection,
  logger: Logger,
  onFailure: () => void,
): SocketPeer {
  let failed = false;

  const handleFailure = () => {
    if (failed) {
      return;
    }

    failed = true;
    logger.warn("WebSocket connection operation failed");
    onFailure();

    try {
      socket.close(1_011);
    } catch {
      // The connection is already unusable; cleanup ran before this attempt.
    }
  };

  return {
    send(message: ServerMessage) {
      if (failed) {
        return;
      }

      try {
        const validatedMessage = serverMessageSchema.parse(message);
        socket.send(JSON.stringify(validatedMessage));
      } catch {
        handleFailure();
      }
    },
    close(code) {
      if (failed) {
        return;
      }

      try {
        socket.close(code);
      } catch {
        handleFailure();
      }
    },
  };
}

export function closeWithProtocolError(
  peer: SocketPeer,
  code: keyof typeof protocolCloseCodes,
): void {
  peer.send({ type: "error", code });
  peer.close(protocolCloseCodes[code]);
}
