import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["better-sqlite3"],
  format: "esm",
  outfile: "../../dist/server/server.js",
  platform: "node",
  target: "node24",
});
