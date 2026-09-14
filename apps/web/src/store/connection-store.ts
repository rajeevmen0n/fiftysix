import type { StoreApi, UseBoundStore } from "zustand";
import { create } from "zustand";

import type {
  ConnectionStatus,
  WebSocketClient,
} from "../net/websocket-client.js";

export interface ConnectionStoreState {
  connectionStatus: ConnectionStatus;
  authenticate(token: string): void;
  connect(): void;
  disconnect(): void;
}

export type ConnectionStore = UseBoundStore<StoreApi<ConnectionStoreState>>;

export function createConnectionStore(
  client: WebSocketClient,
): ConnectionStore {
  let unsubscribe: (() => void) | null = null;

  return create<ConnectionStoreState>((set) => ({
    connectionStatus: "disconnected",
    authenticate(token) {
      client.authenticate(token);
    },
    connect() {
      if (unsubscribe === null) {
        unsubscribe = client.subscribe((connectionStatus) => {
          set({ connectionStatus });
        });
      }

      client.connect();
    },
    disconnect() {
      client.disconnect();
      unsubscribe?.();
      unsubscribe = null;
    },
  }));
}
