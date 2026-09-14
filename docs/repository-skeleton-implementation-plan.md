# Repository Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible, deployable monorepo in which the pure engine and protocol
packages, Hono server, React client, SQLite adapter, WebSocket boundary, and NixOS service are
ready for the engine and rooms tracks.

**Architecture:** pnpm workspaces share one strict TypeScript baseline while preserving the
engine, protocol, server, and browser dependency boundaries. The server is assembled from
injected configuration, storage, transport, clock, random, and scheduler dependencies, then
bundled beside the Vite output so the same process serves HTTP, WebSocket, and the SPA. Nix pins
the toolchain, builds the lockfile-controlled dependency graph, packages the native SQLite
module, and exposes the hardened NixOS service.

**Tech Stack:** TypeScript (`strict`, `noUncheckedIndexedAccess`), Node.js 24, security-fixed pnpm
11 (at least 11.5.3), Biome,
Hono, `@hono/node-ws`, Zod, Kysely, `better-sqlite3`, pino, React 19, Vite, React Router,
Zustand, i18next, esbuild, Nixpkgs 26.05.

**Spec:** `docs/tech-stack-design.md`

**Status:** Approved on 2026-09-14 after scope, dependency, type-interface, and completeness review.

## Global constraints

- Read `AGENTS.md`, `docs/implementation-progress.md`, this header, the current unit, its
  `Depends on` entries, and `docs/tech-stack-design.md`. A unit that changes room or UI behavior
  also reads `rules.md`, `design.md`, and the relevant subsystem design before editing.
- Work strictly sequentially. Dispatch exactly one fresh implementation subagent for the current
  unit with `fork_turns: "none"`. After primary review and verification, stop and ask the user
  before starting the next unit.
- Use `gpt-5.6-sol` at high effort for the primary agent, server, persistence, Nix, and final
  verification. Use `gpt-5.6-terra` at high effort for a narrow protocol or browser unit. No unit
  in this plan needs Astra, generated imagery, or parallel implementation.
- Do not add a test framework or test files. `AGENTS.md` explicitly defers tests; use compiler,
  formatter/linter, build, evaluation, and focused process/browser/socket checks while preserving
  injectable seams.
- Run project commands through `nix develop -c`, except `nix build`, `nix run`, and
  `nix flake check`.
- Pin `nixpkgs` to the stable `nixos-26.05` branch in `flake.lock`. Use `nodejs_24` and a pnpm 11
  package bound to that Node version in both the shell and package build. The readiness audit on
  2026-09-14 observed Node 24.19.0 and pnpm 11.25.0 in that channel; fail S001 if the selected pin
  resolves pnpm below 11.5.3.
- `packages/engine` has no dependencies and compiles without Node or DOM types.
- `packages/protocol` owns network types and Zod schemas. `apps/web` may import protocol types
  only and never imports runtime code from protocol, engine, or server.
- Parse every incoming WebSocket message with a protocol schema before calling a handler. Do not
  put tokens in URLs or logs.
- Keep all ambient time, randomness, timers, storage, sockets, and process lifecycle calls in
  adapters or the composition root. Importing a service module must not open a database or socket.
- Every visible or accessible browser string comes from `locales/en.json` through i18next.
- Use fluid browser layout primitives; do not introduce fixed device-canvas widths or heights.
- Do not introduce final game UI, card art, theme work, room creation/joining, authenticated room
  views, or engine behavior in this plan.
- Whenever `pnpm-lock.yaml` changes, update the `fetchPnpmDeps` hash in `nix/package.nix` in the
  same unit and require `nix build` to succeed before committing.

## Progress protocol

Every numbered unit is intended to finish, verify, and commit within one session. At unit start,
set the repository-skeleton row and unit to `In progress` in `docs/implementation-progress.md`.
At completion:

1. The primary agent inspects the complete diff and reruns the unit's verification commands.
2. Change the unit heading from `[ ]` to `[x]`.
3. Record the commit, verification evidence, and next unit in `docs/implementation-progress.md`.
4. Include the plan checkbox and progress update in the same unit commit.
5. Stop and ask the user before dispatching the next unit.

If blocked, leave the checkbox open and record the exact blocker, working-tree/commit state, and
smallest next action in the progress ledger.

## Planned files

```text
flake.nix
flake.lock
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
tsconfig.base.json
biome.json

packages/engine/
  package.json
  tsconfig.json
  src/index.ts
packages/protocol/
  package.json
  tsconfig.json
  src/connection.ts
  src/health.ts
  src/index.ts

apps/server/
  package.json
  tsconfig.json
  esbuild.config.ts
  src/app.ts
  src/config.ts
  src/logger.ts
  src/main.ts
  src/server.ts
  src/routes/health.ts
  src/runtime/{clock,random,scheduler,shutdown}.ts
  src/storage/storage.ts
  src/storage/migrations/001_initial.ts
  src/storage/sqlite/{database,sqlite-storage}.ts
  src/ws/{connection-registry,connection-socket,hello-handler}.ts
apps/web/
  package.json
  tsconfig.json
  index.html
  vite.config.ts
  src/App.tsx
  src/main.tsx
  src/i18n.ts
  src/net/websocket-client.ts
  src/store/connection-store.ts

locales/en.json
nix/package.nix
nix/module.nix
```

If a preceding unit chose a different path for an equivalent boundary, record the one-to-one
substitution in the progress ledger before dispatch and modify that boundary instead of creating
a duplicate.

---

### [ ] S001: Establish the reproducible workspace and package graph

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Modify: `.gitignore`
- Create: `flake.nix`
- Create: `flake.lock`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/src/index.ts`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/esbuild.config.ts`
- Create: `apps/server/src/main.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `nix/package.nix`

**Depends on:** None.

**Interfaces produced:**

```json
{
  "scripts": {
    "dev": "concurrently --kill-others-on-fail --names server,web 'pnpm --filter @fiftysix/server dev' 'pnpm --filter @fiftysix/web dev'",
    "build": "pnpm --filter @fiftysix/server build && pnpm --filter @fiftysix/web build",
    "start": "node dist/server/server.js",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "biome check .",
    "format": "biome format --write ."
  }
}
```

- [ ] Pin the flake's only input to `github:NixOS/nixpkgs/nixos-26.05`; enumerate
  `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin` with a local helper rather than
  flake-utils. Expose the initial `packages.default` from `nix/package.nix` and create a default
  shell containing Node 24, pnpm 11 bound to Node 24, SQLite, Biome, Python, a C/C++ toolchain,
  `pkg-config`, and `nixfmt`.
- [ ] Define a private pnpm workspace for `packages/*` and `apps/*`. Set `packageManager` to the
  exact pnpm 11 version supplied by the pinned nixpkgs, require that version to be at least
  11.5.3, require Node `>=24 <25`, and add only the
  dependencies selected for skeleton work: TypeScript/build tooling at the root; no engine
  dependency; Zod in protocol; Hono/Node WebSocket/Kysely/SQLite/pino/Zod in server; and
  React/React DOM/React Router/Zustand/i18next/react-i18next in web.
- [ ] Configure TypeScript with `strict`, `noUncheckedIndexedAccess`, `noEmit`, modern ESM,
  `verbatimModuleSyntax`, and package-specific libraries/types. Give engine only ES library types;
  protocol receives ES types; server receives ES and Node types; web receives ES and DOM types.
- [ ] Add package exports and workspace references so server can import engine and protocol,
  protocol can type-import engine, and web can type-import protocol. Add empty typed exports for
  engine/protocol and minimal compile-only server/web entries without application behavior.
- [ ] Configure esbuild to emit `dist/server/server.js` and Vite to emit `dist/web`. Configure
  Vite's development proxy for `/api` and WebSocket `/ws` to `http://127.0.0.1:8056`.
- [ ] Configure Biome for the repository and ignore generated output, dependency directories,
  SQLite files, and local environment artifacts in both Biome and `.gitignore` as appropriate.
- [ ] Create `nix/package.nix` with `fetchPnpmDeps`, `pnpmConfigHook`, pnpm 11, Node 24, SQLite,
  and native compilation inputs. Force `better-sqlite3` to build from source against nixpkgs'
  SQLite, run `pnpm build`, and install the current server bundle, web tree, required native
  runtime dependency, and `$out/bin/fiftysix` wrapper. Use `lib.fakeHash` only to obtain the
  dependency hash, replace it with the reported hash before review, and require no `fakeHash` in
  `nix/package.nix` when committing.
- [ ] Generate the lockfiles from inside the dev shell. Run `nix develop -c pnpm typecheck`,
  `nix develop -c pnpm lint`, `nix develop -c pnpm build`, and `nix build`; require exit 0.
- [ ] Inspect `pnpm why` output to confirm engine has no dependencies, inspect emitted bundles to
  confirm the server does not bundle `better-sqlite3`, run `git diff --check`, update plan/progress,
  and commit `build: establish reproducible workspace`.

---

### [ ] S002: Define the bootstrap connection protocol

**Suggested implementer:** `gpt-5.6-terra`, high effort

**Files:**
- Create: `packages/protocol/src/connection.ts`
- Create: `packages/protocol/src/health.ts`
- Modify: `packages/protocol/src/index.ts`

**Depends on:** S001.

**Interfaces produced:**

```ts
export const helloMessageSchema: z.ZodType<HelloMessage>;
export interface HelloMessage {
  type: "hello";
  token: string;
}
export type ProtocolErrorCode =
  | "hello_required"
  | "invalid_message"
  | "message_too_large"
  | "origin_not_allowed"
  | "invalid_token";
export interface ProtocolErrorMessage {
  type: "error";
  code: ProtocolErrorCode;
}
export const clientMessageSchema: z.ZodType<HelloMessage>;
export const serverMessageSchema: z.ZodType<ProtocolErrorMessage>;
export type ClientMessage = HelloMessage;
export type ServerMessage = ProtocolErrorMessage;
export type HealthResponse = {status: "ok"} | {status: "unavailable"};
export const healthResponseSchema: z.ZodType<HealthResponse>;
```

- [ ] Define strict Zod objects for `hello` and the protocol-error envelope. Require a nonempty
  bounded token and prohibit unknown properties. Keep protocol error details free of submitted
  values.
- [ ] Define the two-variant `/healthz` response schema and export runtime schemas for server
  parsing/serialization plus inferred/static types for consumers. Do not add room commands,
  views, credentials, or an accepted-room snapshot; the rooms protocol unit will extend this
  union once those types exist.
- [ ] Use a `tsx` one-off command to parse a valid hello and reject missing token, empty token,
  extra property, unknown type, and malformed error-code samples. Run typecheck, lint, build, and
  `git diff --check`; require success.
- [ ] Inspect web imports and require that no web source imports these runtime schemas. Update
  plan/progress and commit `feat(protocol): define connection handshake`.

---

### [ ] S003: Add configuration and injected runtime primitives

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/logger.ts`
- Create: `apps/server/src/runtime/clock.ts`
- Create: `apps/server/src/runtime/random.ts`
- Create: `apps/server/src/runtime/scheduler.ts`

**Depends on:** S001.

**Interfaces produced:**

```ts
export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  debugPasswordFile: string | null;
  allowedOrigins: readonly string[] | null;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}
export function parseConfig(environment: Readonly<Record<string, string | undefined>>): AppConfig;

export interface Clock { now(): number; }
export interface RandomSource {
  bytes(length: number): Uint8Array;
  integer(maxExclusive: number): number;
}
export interface ScheduledTask { cancel(): void; }
export interface Scheduler {
  at(deadline: number, callback: () => void | Promise<void>): ScheduledTask;
  close(): void;
}
```

- [ ] Parse the six documented variables with Zod from an explicit environment object. Apply
  exact defaults `127.0.0.1`, `8056`, `sqlite://./fiftysix.db`, unset, unset, and `info`; validate
  port range, nonempty host/database URL, absolute-or-relative secret-file path, comma-separated
  HTTP(S) origins without empty entries, and pino log level. Format invalid startup errors without
  including secret-file contents.
- [ ] Add a pino factory that receives `AppConfig`, writes JSON to stdout, and exposes no module
  singleton.
- [ ] Implement production adapters around `Date.now`, `node:crypto` byte/random-integer APIs,
  and cancellable `setTimeout`. Keep those ambient APIs out of the interfaces and all future
  domain services.
- [ ] Use `tsx` one-off commands to demonstrate defaults, complete overrides, and failures for an
  invalid port/origin/log level. Exercise scheduler cancellation and bounded random integers
  without adding test files.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Confirm with `rg` that
  ambient time/random calls occur only in runtime adapters, then update plan/progress and commit
  `feat(server): add runtime configuration`.

---

### [ ] S004: Establish the swappable storage boundary and migration baseline

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/storage/storage.ts`
- Create: `apps/server/src/storage/migrations/001_initial.ts`
- Create: `apps/server/src/storage/sqlite/database.ts`
- Create: `apps/server/src/storage/sqlite/sqlite-storage.ts`

**Depends on:** S001 and S003.

**Interfaces produced:**

```ts
export interface ApplicationStorage {
  migrate(): Promise<void>;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}
export interface StorageFactory {
  open(databaseUrl: string): Promise<ApplicationStorage>;
}
export function createStorageFactory(): StorageFactory;
```

- [ ] Keep the app-facing contract free of Kysely, SQL, and `better-sqlite3` types. Select the
  SQLite adapter from the `sqlite:` URL scheme in the factory and reject unsupported schemes with
  a clear configuration error so a future adapter can be added without changing callers.
- [ ] Convert `sqlite://./relative.db`, `sqlite:///absolute/path.db`, and `sqlite://:memory:` into
  explicit SQLite targets without using the current directory implicitly outside the adapter.
- [ ] Build the Kysely/`better-sqlite3` database only when `open` is called. Configure foreign
  keys, implement `checkHealth` as a driver-level constant select, make `close` idempotent, and
  keep every Kysely/SQLite import under `storage/`.
- [ ] Add `001_initial` as an intentional no-domain-table baseline migration. Its `up` and `down`
  are portable no-ops; Kysely's own migration tables prove that migration discovery and locking
  work while reserving `002_rooms` for the already-planned rooms schema.
- [ ] With a temporary database path, run migration twice, call `checkHealth`, inspect the SQLite
  schema for Kysely's migration records, close the adapter, and remove only that explicit
  temporary database. Do not create or edit the default project database during verification.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Inspect imports to
  confirm no file outside `storage/` imports Kysely or `better-sqlite3`, then update plan/progress
  and commit `feat(server): add storage foundation`.

---

### [ ] S005: Implement the HTTP and WebSocket server edge

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/routes/health.ts`
- Create: `apps/server/src/ws/connection-registry.ts`
- Create: `apps/server/src/ws/hello-handler.ts`
- Create: `apps/server/src/ws/connection-socket.ts`

**Depends on:** S002–S004.

**Interfaces produced:**

```ts
export interface HelloHandler {
  handle(token: string, peer: SocketPeer): Promise<void>;
}
export interface SocketPeer {
  send(message: ServerMessage): void;
  close(code?: number): void;
}
export interface ConnectionRegistry {
  add(peer: SocketPeer): void;
  delete(peer: SocketPeer): void;
  closeAll(code?: number): void;
}
export interface AppDependencies {
  config: AppConfig;
  storage: ApplicationStorage;
  logger: Logger;
  helloHandler: HelloHandler;
  connections: ConnectionRegistry;
}
export function createApp(dependencies: AppDependencies): Hono;
```

- [ ] Add `GET /healthz` returning schema-backed JSON `{status: "ok"}` with status 200 after
  `storage.checkHealth()` succeeds and `{status: "unavailable"}` with status 503 if it fails. Log
  the failure without leaking database URLs or filesystem paths.
- [ ] Create the `/ws` edge with `@hono/node-ws`. Enforce configured origins before upgrade,
  limit each message to 65,536 UTF-8 bytes, require the first message to be `hello`, parse it with
  `helloMessageSchema`, and map malformed/order/size failures to the stable protocol error before
  closing with an appropriate WebSocket close code.
- [ ] Route a valid token to the injected `HelloHandler`. Supply a bootstrap handler in the later
  composition root that always returns `error(invalid_token)` and closes; no token can authenticate
  until the rooms subsystem replaces this handler with `AccessService` integration.
- [ ] Track open peers in an injected registry for later shutdown. Make close/error cleanup
  identity-safe and isolate send failures. Keep HTTP and socket handlers limited to parse, call,
  serialize, and close operations.
- [ ] Start the app from a one-off `tsx` harness with in-memory fake dependencies. Verify
  `/healthz`, disallowed origin, oversize message, message-before-hello, malformed hello, and
  valid-but-unknown token behavior using `curl` and a WebSocket CLI available through nixpkgs or
  a short Node client command; do not add a permanent test tool or file.
- [ ] Run typecheck, lint, build, and `git diff --check`; require success. Inspect logs from known
  tokens and require no token value, then update plan/progress and commit
  `feat(server): add HTTP and WebSocket edge`.

---

### [ ] S006: Add the browser connection client and localized status screen

**Suggested implementer:** `gpt-5.6-terra`, high effort

**Files:**
- Create: `apps/web/src/net/websocket-client.ts`
- Create: `apps/web/src/store/connection-store.ts`
- Create: `apps/web/src/i18n.ts`
- Create: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Create: `locales/en.json`

**Depends on:** S002 and S005.

**Interfaces produced:**

```ts
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
export interface ReconnectScheduler {
  schedule(delayMs: number, callback: () => void): {cancel(): void};
}
export interface WebSocketClient {
  connect(): void;
  authenticate(token: string): void;
  disconnect(): void;
  subscribe(listener: (status: ConnectionStatus) => void): () => void;
}
export function createWebSocketClient(dependencies: {
  createSocket(url: string): WebSocket;
  scheduler: ReconnectScheduler;
  url: string;
}): WebSocketClient;
```

- [ ] Implement a transport client with explicit socket and scheduler dependencies, one active
  socket, idempotent `connect`/`disconnect`, and capped exponential reconnect delays of 500,
  1,000, 2,000, 4,000, 8,000, then 10,000 ms. Reset the attempt after a successful open and do
  not reconnect after intentional disconnect.
- [ ] Keep transport connection separate from room authentication. `connect()` opens `/ws` and
  reports status; `authenticate(token)` sends typed `hello` only on an open socket. The initial
  status screen has no token and therefore does not fabricate a room session.
- [ ] Adapt the client into a small Zustand store created through a factory, not a global socket
  singleton. Compose the production browser WebSocket and timeout adapters in `main.tsx`.
- [ ] Initialize React 19, React Router, and i18next. Render one root route with the app identity
  and an accessible live connection-status label; source every visible/accessibility string from
  `locales/en.json`. Keep styling structural and minimal because the approved UI plan owns final
  theme and components; add no image asset.
- [ ] Run `pnpm dev`, open the page at narrow phone and desktop widths, stop/restart the server,
  and confirm connected/reconnecting/disconnected transitions without layout overflow. Confirm
  no authentication message is sent without a token.
- [ ] Run typecheck, lint, build, `rg` checks for hard-coded JSX strings and forbidden runtime
  imports, and `git diff --check`; require success. Update plan/progress and commit
  `feat(web): show connection status`.

---

### [ ] S007: Compose production serving and graceful shutdown

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Create: `apps/server/src/runtime/shutdown.ts`
- Create: `apps/server/src/server.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/esbuild.config.ts`

**Depends on:** S003–S006.

**Interfaces produced:**

```ts
export interface RunningServer {
  address: string;
  close(): Promise<void>;
}
export interface ShutdownParticipant {
  close(): void | Promise<void>;
}
export interface ShutdownCoordinator {
  add(participant: ShutdownParticipant): () => void;
  close(): Promise<void>;
}
export async function startServer(config: AppConfig): Promise<RunningServer>;
```

- [ ] Compose logger, production clock/random/scheduler, SQLite storage, migrations, connection
  registry, rejecting bootstrap hello handler, Hono app, and Node WebSocket adapter only inside
  `startServer`. Keep `main.ts` as the thin process entry that parses `process.env`, starts once,
  and maps startup failure to a nonzero exit without logging secrets.
- [ ] In production, serve hashed/static files from the web directory placed beside the server
  bundle. Return `index.html` as the fallback only for non-API, non-WebSocket `GET`/`HEAD` routes;
  preserve real 404/method responses for `/api/*`, `/healthz`, `/ws`, and the reserved `/debug`
  path. U026 conditionally enables the `/debug` SPA fallback with the debug service.
- [ ] Add the production security headers from the tech-stack spec: same-origin CSP with no inline
  script, inline style attributes allowed only for Motion/CSS variables, no object/embed target,
  frame denial, `nosniff`, `no-referrer`, and restrictive browser permissions. Do not set HSTS in
  the app. Revalidate the SPA shell and cache content-hashed assets as immutable.
- [ ] Implement a shutdown coordinator that is idempotent and closes in order: stop accepting
  HTTP/upgrades, close registered sockets, stop schedulers, wait for registered future service
  drains, then close storage. Have both `SIGTERM` and `SIGINT` await the same path; a second signal
  may force process exit.
- [ ] Run the built server against an explicit temporary SQLite file. Verify `/`, one asset, an
  arbitrary client route, `/healthz`, an unknown `/api` route, the reserved `/debug` 404, and
  `/ws`. Send SIGTERM during an open WebSocket, require the socket and process to close cleanly,
  and confirm the migration record persists.
- [ ] Inspect production responses to require the security headers, shell/asset cache policy, and
  a CSP that still permits same-origin WebSocket use, generated QR images, Motion transforms, and
  calculated CSS-variable styles.
- [ ] Run typecheck, lint, build, `nix build`, and `git diff --check`; require success. Verify
  `node dist/server/server.js` and the current Nix wrapper serve identical web/health behavior,
  then update plan/progress and commit `feat(server): serve and shut down application`.

---

### [ ] S008: Complete the Nix package, app, checks, and NixOS module

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Modify: `flake.nix`
- Modify: `nix/package.nix`
- Create: `nix/module.nix`

**Depends on:** S001 and S007.

**Interfaces produced:**

```nix
{
  packages.default = fiftysix;
  apps.default = { type = "app"; program = "${fiftysix}/bin/fiftysix"; };
  devShells.default = devShell;
  checks = { inherit fiftysix typecheck biome; };
  formatter = pkgs.nixfmt;
  nixosModules.default = {pkgs, lib, ...}: {
    imports = [./nix/module.nix];
    services.fiftysix.package = lib.mkDefault self.packages.${pkgs.system}.default;
  };
}
```

```nix
services.fiftysix = {
  enable = false;
  host = "127.0.0.1";
  port = 8056;
  openFirewall = false;
  databaseUrl = "sqlite:///var/lib/fiftysix/fiftysix.db";
  debugPasswordFile = null;
  allowedOrigins = [];
  logLevel = "info";
};
```

- [ ] Finalize `nix/package.nix` so `$out/lib/fiftysix/server.js`, `$out/lib/fiftysix/web/`, the
  native runtime dependency closure, and `$out/bin/fiftysix` match the tech-stack spec. Inspect
  the native module with `ldd` on Linux or `otool -L` on Darwin and require nixpkgs SQLite rather
  than a bundled library.
- [ ] Expose the default package/app, dev shell, formatter, and checks for TypeScript, Biome, and
  package build on all three declared systems. Export only the NixOS module independent of the
  per-system output, set its package default through the flake wrapper as shown above, and keep it
  evaluable on Linux.
- [ ] Implement every documented `services.fiftysix` option with the exact defaults and types.
  Map values to environment variables, join allowed origins with commas, configure
  `DynamicUser`, `StateDirectory=fiftysix`, `Restart=on-failure`, the documented hardening, and
  optional firewall opening.
- [ ] When `debugPasswordFile` is non-null, use
  `LoadCredential=debug-password:<path>` and set `DEBUG_PASSWORD_FILE` to the systemd credential
  path. Do not copy the secret to the Nix store or place its contents in the environment. Omit
  both settings when the option is null.
- [ ] Evaluate disabled, default-enabled, customized, firewall, and credential-enabled module
  configurations with `nixosSystem`; inspect the resulting unit/environment and require the
  documented values, hardening, and absence of secret content.
- [ ] Run `nixfmt --check flake.nix nix/package.nix nix/module.nix`, `nix build`, a bounded
  `nix run` health smoke check, and `nix flake check`; require success. Run `git diff --check`,
  update plan/progress, and commit `build(nix): package and deploy fiftysix`.

---

### [ ] S009: Verify the integrated skeleton and hand off to engine implementation

**Suggested implementer:** `gpt-5.6-sol`, high effort

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/repository-skeleton-implementation-plan.md`
- Modify: `docs/implementation-progress.md`

**Depends on:** S001–S008 complete.

**Interfaces produced:** No new runtime interface. This unit produces verified application and
deployment foundations plus the durable handoff to the already-approved pure-engine plan.

```text
Required smoke matrix:
workspace dependency boundaries; config defaults and invalid startup; migration first run and
idempotent rerun; healthy and failed storage health checks; WebSocket origin/size/order/schema/
unknown-token handling; browser connect and reconnect; production static asset and SPA fallback;
reserved /debug 404; SIGTERM with an open socket; nix build/run/check; NixOS defaults, overrides,
firewall, credentials, and hardening.
```

- [ ] Run `nix develop -c pnpm typecheck`, `nix develop -c pnpm lint`, and
  `nix develop -c pnpm build`; require exit 0 for each.
- [ ] Run `nix build` and `nix flake check`; require exit 0. Run the result with an explicit
  temporary database URL, verify `/`, `/healthz`, SPA fallback, and the WebSocket rejection path,
  then terminate it with SIGTERM and require exit 0.
- [ ] Exercise every required smoke-matrix item. Record concise commands/results in the progress
  ledger, including the three evaluated flake systems and the host system's native SQLite link.
- [ ] Inspect the complete tree with `rg`: require no direct engine dependencies; no web runtime
  imports from protocol/engine/server; no ambient time/random use outside adapters; no visible
  hard-coded JSX strings; no usable tokens, secret contents, dummy domain tables, fake hash in
  Nix source, or generated database/build artifacts.
- [ ] Update `AGENTS.md` from planned to actual layout and run behavior without duplicating
  detailed specs. Mark this unit and the repository-skeleton track complete, set E001 as the next
  action, and leave rooms blocked on the still-missing engine only.
- [ ] Run `git status --short` and `git diff --check`, review every final documentation change,
  and commit `docs: complete repository skeleton`. Stop and ask the user before implementing
  E001.
