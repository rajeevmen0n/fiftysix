import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { build } from "esbuild";

const outputDirectory = "../../dist/server";

await build({
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["better-sqlite3"],
  format: "esm",
  outfile: join(outputDirectory, "server.js"),
  platform: "node",
  target: "node24",
});

const require = createRequire(import.meta.url);
const betterSqliteDirectory = dirname(
  require.resolve("better-sqlite3/package.json"),
);
const requireFromBetterSqlite = createRequire(
  join(betterSqliteDirectory, "package.json"),
);
const bindingsDirectory = dirname(
  requireFromBetterSqlite.resolve("bindings/package.json"),
);
const requireFromBindings = createRequire(
  join(bindingsDirectory, "package.json"),
);
const fileUriToPathDirectory = dirname(
  requireFromBindings.resolve("file-uri-to-path/package.json"),
);
const runtimeModulesDirectory = join(outputDirectory, "node_modules");

await rm(runtimeModulesDirectory, { force: true, recursive: true });
await mkdir(runtimeModulesDirectory, { recursive: true });
await Promise.all([
  cp(betterSqliteDirectory, join(runtimeModulesDirectory, "better-sqlite3"), {
    dereference: true,
    recursive: true,
  }),
  cp(bindingsDirectory, join(runtimeModulesDirectory, "bindings"), {
    dereference: true,
    recursive: true,
  }),
  cp(
    fileUriToPathDirectory,
    join(runtimeModulesDirectory, "file-uri-to-path"),
    { dereference: true, recursive: true },
  ),
]);
