import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Route, Routes } from "react-router";

import type { ConnectionStore } from "./store/connection-store.js";

interface AppProperties {
  connectionStore: ConnectionStore;
}

function ConnectionStatusScreen({ connectionStore }: AppProperties) {
  const { t } = useTranslation();
  const connectionStatus = connectionStore((state) => state.connectionStatus);

  useEffect(() => {
    const { connect, disconnect } = connectionStore.getState();
    connect();
    return disconnect;
  }, [connectionStore]);

  return (
    <main
      style={{
        boxSizing: "border-box",
        display: "grid",
        minBlockSize: "100dvh",
        padding: "clamp(1rem, 4vw, 3rem)",
        placeItems: "center",
      }}
    >
      <section style={{ inlineSize: "min(100%, 48rem)" }}>
        <h1>{t("app.identity")}</h1>
        <p role="status">
          {t("connection.statusLabel", {
            status: t(`connection.status.${connectionStatus}`),
          })}
        </p>
      </section>
    </main>
  );
}

export default function App(properties: AppProperties) {
  return (
    <Routes>
      <Route element={<ConnectionStatusScreen {...properties} />} path="/" />
    </Routes>
  );
}
