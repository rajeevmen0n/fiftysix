import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import App from "./App.js";
import i18n from "./i18n.js";
import { createWebSocketClient } from "./net/websocket-client.js";
import { createConnectionStore } from "./store/connection-store.js";

function webSocketUrl(location: Location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

const connectionClient = createWebSocketClient({
  createSocket(url) {
    return new WebSocket(url);
  },
  scheduler: {
    schedule(delayMs, callback) {
      const timeout = window.setTimeout(callback, delayMs);
      return {
        cancel() {
          window.clearTimeout(timeout);
        },
      };
    },
  },
  url: webSocketUrl(window.location),
});

const connectionStore = createConnectionStore(connectionClient);
const rootElement = document.getElementById("root");

document.title = i18n.t("app.identity");

if (rootElement === null) {
  throw new Error("Missing application root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App connectionStore={connectionStore} />
    </BrowserRouter>
  </StrictMode>,
);
