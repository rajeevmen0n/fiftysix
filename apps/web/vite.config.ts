import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverTarget = "http://127.0.0.1:8056";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": serverTarget,
      "/ws": {
        target: serverTarget,
        ws: true,
      },
    },
  },
});
