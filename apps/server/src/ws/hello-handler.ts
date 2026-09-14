import type { ServerMessage } from "@fiftysix/protocol";

export interface SocketPeer {
  send(message: ServerMessage): void;
  close(code?: number): void;
}

export interface HelloHandler {
  handle(token: string, peer: SocketPeer): Promise<void>;
}
