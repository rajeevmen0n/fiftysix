import type { SocketPeer } from "./hello-handler.js";

export interface ConnectionRegistry {
  add(peer: SocketPeer): void;
  delete(peer: SocketPeer): void;
  closeAll(code?: number): void;
}

export function createConnectionRegistry(): ConnectionRegistry {
  const peers = new Set<SocketPeer>();

  return {
    add(peer) {
      peers.add(peer);
    },
    delete(peer) {
      peers.delete(peer);
    },
    closeAll(code) {
      const openPeers = [...peers];
      peers.clear();

      for (const peer of openPeers) {
        try {
          peer.close(code);
        } catch {
          // One broken connection must not prevent the others from closing.
        }
      }
    },
  };
}
