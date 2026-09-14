import type { HelloMessage } from "@fiftysix/protocol";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ReconnectScheduler {
  schedule(delayMs: number, callback: () => void): { cancel(): void };
}

export interface WebSocketClient {
  connect(): void;
  authenticate(token: string): void;
  disconnect(): void;
  subscribe(listener: (status: ConnectionStatus) => void): () => void;
}

export interface WebSocketClientDependencies {
  createSocket(url: string): WebSocket;
  scheduler: ReconnectScheduler;
  url: string;
}

const reconnectDelays = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const;
const openSocketState = 1;

export function createWebSocketClient(
  dependencies: WebSocketClientDependencies,
): WebSocketClient {
  let socket: WebSocket | null = null;
  let reconnectTask: { cancel(): void } | null = null;
  let reconnectTaskId = 0;
  let reconnectAttempt = 0;
  let intentionallyDisconnected = false;
  let status: ConnectionStatus = "disconnected";
  const listeners = new Set<(nextStatus: ConnectionStatus) => void>();

  function setStatus(nextStatus: ConnectionStatus): void {
    if (status === nextStatus) {
      return;
    }

    status = nextStatus;
    for (const listener of listeners) {
      listener(status);
    }
  }

  function cancelReconnect(): void {
    reconnectTaskId += 1;
    reconnectTask?.cancel();
    reconnectTask = null;
  }

  function scheduleReconnect(): void {
    if (
      intentionallyDisconnected ||
      reconnectTask !== null ||
      socket !== null
    ) {
      return;
    }

    setStatus("reconnecting");
    const delay =
      reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ??
      10_000;
    reconnectAttempt += 1;
    const taskId = reconnectTaskId + 1;
    reconnectTaskId = taskId;
    reconnectTask = dependencies.scheduler.schedule(delay, () => {
      if (
        taskId !== reconnectTaskId ||
        intentionallyDisconnected ||
        socket !== null
      ) {
        return;
      }

      reconnectTask = null;
      openSocket("reconnecting");
    });
  }

  function handleDisconnected(source: WebSocket): void {
    if (socket !== source) {
      return;
    }

    socket = null;
    if (intentionallyDisconnected) {
      setStatus("disconnected");
      return;
    }

    scheduleReconnect();
  }

  function openSocket(nextStatus: "connecting" | "reconnecting"): void {
    if (socket !== null) {
      return;
    }

    setStatus(nextStatus);
    let nextSocket: WebSocket;
    try {
      nextSocket = dependencies.createSocket(dependencies.url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || intentionallyDisconnected) {
        return;
      }

      reconnectAttempt = 0;
      setStatus("connected");
    });
    nextSocket.addEventListener("close", () => {
      handleDisconnected(nextSocket);
    });
    nextSocket.addEventListener("error", () => {
      if (socket !== nextSocket) {
        return;
      }

      handleDisconnected(nextSocket);
      try {
        nextSocket.close();
      } catch {
        // A failed socket is already being replaced through the reconnect path.
      }
    });
  }

  return {
    connect() {
      if (socket !== null || reconnectTask !== null) {
        return;
      }

      intentionallyDisconnected = false;
      openSocket("connecting");
    },
    authenticate(token) {
      if (socket?.readyState !== openSocketState) {
        return;
      }

      const message: HelloMessage = { type: "hello", token };
      socket.send(JSON.stringify(message));
    },
    disconnect() {
      intentionallyDisconnected = true;
      cancelReconnect();
      const activeSocket = socket;
      socket = null;
      reconnectAttempt = 0;
      setStatus("disconnected");

      try {
        activeSocket?.close();
      } catch {
        // Closing a socket is best-effort; stale events are ignored below.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(status);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
