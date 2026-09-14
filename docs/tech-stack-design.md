# Tech stack design

The tech stack, repo layout, server and web architecture, and Nix packaging for the app. It
builds on [AGENTS.md](../AGENTS.md) (engineering conventions),
[design.md](../design.md) (app decisions) and the
[game engine spec](game-engine-design.md).

## 1. Goals and constraints

- **Users**: a small group (family and friends). A handful of rooms at once, one server process.
- **Priorities**, in order:
  1. A visually polished app with rich animations
  2. Correctness caught by the compiler, especially at the client–server boundary
  3. Simple to build, run and maintain without over-engineering
  4. Low token cost when building with agents
- **Deployment**: any machine with Nix. The repo is **generic**: it provides a package and a
  NixOS module, and nothing specific to one server, domain or reverse proxy.
- **Fixed by existing docs**: a pure engine that runs only on the server; server-side room
  state that survives restarts; a swappable database with SQLite as the default; a Nix flake for
  development, builds and deployment; phones up to TVs; translation files.

## 2. Stack summary

| Area | Choice |
|---|---|
| Language | TypeScript everywhere, `strict` plus `noUncheckedIndexedAccess` |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm workspaces |
| Lint and format | Biome |
| Server HTTP | Hono on `@hono/node-server` |
| WebSocket | `@hono/node-ws` (`ws`) |
| Validation | Zod |
| Database | Kysely with `better-sqlite3`; Kysely migrator |
| Logging | pino (JSON to stdout) |
| Server bundling | esbuild |
| Frontend | React 19, Vite |
| Routing | React Router |
| Client state | Zustand |
| Animation | Motion (`motion/react`), CSS 3D transforms |
| Styling | Tailwind CSS v4 |
| UI primitives | Radix UI primitives (unstyled) |
| Translations | i18next, react-i18next |
| Fonts | Fontsource (bundled) |
| QR codes | `qrcode` |
| Build and deploy | Nix flake: dev shell, package, NixOS module |
| Tests (later, not set up now) | Vitest |

### 2.1 Alternatives considered
- **Go server with a TypeScript frontend**: simple single-binary packaging, but Go has no tagged
  unions, which makes the engine's many phases, actions and events verbose, and protocol types
  would have to be kept in sync across two languages.
- **Elixir with Phoenix LiveView**: strong real-time support, but less agent fluency, and a
  server-rendered model fights the client-side animation queue and feels slow on weak phone
  networks.
- **Svelte 5**: less code per component, but Motion's shared layout animations in React are the
  best fit for cards moving between hand, table and winner's pile.
- **Canvas or WebGL (PixiJS)**: more effects possible, but text, translations, responsive layout
  and accessibility become much harder.
- **Rust**: more ceremony than this app needs.

## 3. Repo layout

```
flake.nix, flake.lock
package.json, pnpm-workspace.yaml, pnpm-lock.yaml
tsconfig.base.json, biome.json
packages/
  engine/       pure game engine (engine spec). No dependencies, no I/O.
  protocol/     client↔server message types and Zod schemas
apps/
  server/       Node server: HTTP, WebSocket, services, storage, config
  web/          React app (Vite)
nix/
  package.nix   the app package
  module.nix    the NixOS module
locales/
  en.json       all UI strings (ml.json later)
```

### 3.1 Package rules
- **`packages/engine`** has no dependencies and imports nothing from other packages, Node or the
  browser. The compiler setup (no Node or DOM types) enforces this.
- **`packages/protocol`** defines every message and view type once, with a Zod schema for every
  message sent from client to server. It may import types from `engine`.
- **`apps/server`** imports `engine` and `protocol`.
- **`apps/web`** imports **only types** from `protocol`. It never imports code from `engine` or
  `server`, so rule logic stays on the server.
- Workspace packages are consumed as **TypeScript source**. There is no separate build step for
  `engine` or `protocol`: esbuild bundles them into the server, and Vite into the web app.

## 4. Server

### 4.1 HTTP and WebSocket
- **One process, one port.** It serves:
  - `GET /healthz`
  - HTTP routes under `/api/…` for actions before a player is in a room: create room, join,
    open Table view, /debug login. Each returns a session token.
  - the WebSocket at `/ws`
  - the built web app, with a fallback to the app's page for client routes such as `/` and
    `/debug`
- **WebSocket connection**:
  - The first message is `hello(token)`. The token is never put in a URL, so it doesn't appear
    in proxy logs.
  - If `ALLOWED_ORIGINS` is set, connections from other origins are refused. If unset, any
    origin is accepted.
  - Messages have a size limit.
- **Validation**: every incoming HTTP body and WebSocket message is parsed with its `protocol`
  Zod schema. An invalid message gets an error reply and never reaches a service.
- **Handlers are thin** (AGENTS.md): parse, call a service, send the result.
- **Message envelope**:
  - client → server: `{type, …}`, for example `{type: "hello", token}`,
    `{type: "action", action}`
  - server → client: `{type: "update", events, view, hostActions}`,
    `{type: "rejected", code, details}`, `{type: "error", code}`
  - The full room message list is designed with the rooms subsystem.
- **No CORS setup** is needed: the web app is served from the same origin as the API.

### 4.2 Rooms at runtime
- Active rooms are held **in memory** and loaded from the database when first used.
- Each room has a **serial queue**: its messages are processed one at a time, so near-
  simultaneous calls (for example a pass and a Redouble) can't race.
- **Save before send**: after each action, the room's state and new events are written in **one
  database transaction**, then updates are sent to connections. A restart loses nothing.

### 4.3 Services and dependencies
- Services (rooms, joining, host transfer, debug, …) receive their dependencies through
  constructors or parameters (AGENTS.md):
  - `storage`
  - `clock`
  - `random`: `node:crypto` in production; a seeded generator for /debug deal seeds. Shuffling
    (Fisher–Yates) lives in the server and uses this source.
  - `sender`: sends messages to connections
  - `scheduler`: timers for host transfer wait, PIN lockout and the room expiry sweep
- /debug matches run the engine on **in-memory state only**, separate from real rooms.

### 4.4 Storage
- **Storage interfaces** are written in app terms, for example `saveRoom`, `loadRoomByCode`,
  `deleteRoomsInactiveSince`.
- The **SQLite adapter** uses Kysely with `better-sqlite3`. Only adapters import Kysely.
- **Migrations** use Kysely's migrator with its schema builder, not raw SQL, so they stay
  portable. They run automatically at startup.
- The adapter is chosen from `DATABASE_URL` (for example `sqlite:///var/lib/fiftysix/fiftysix.db`).
  Adding Postgres or MySQL means a new adapter and URL scheme, with nothing else touched.
- `better-sqlite3` is built against **nixpkgs' SQLite**, not its bundled copy.

### 4.5 Configuration
Environment variables, parsed with Zod at startup. An invalid value stops the server with a clear
message.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on |
| `PORT` | `8056` | Port to listen on |
| `DATABASE_URL` | `sqlite://./fiftysix.db` | Database to use |
| `DEBUG_PASSWORD_FILE` | unset | File holding the /debug password. Unset disables /debug. |
| `ALLOWED_ORIGINS` | unset | Comma-separated origins allowed for WebSocket. Unset allows any. |
| `LOG_LEVEL` | `info` | pino log level |

- **Secrets are always passed as files**, never as values. Any secret added later follows the
  same `…_FILE` pattern.
- **Rejoin tokens** are random values stored in the database, so no signing key is needed.

### 4.6 Logging and shutdown
- pino writes JSON to stdout, which systemd's journal collects. The engine never logs.
- On `SIGTERM`: stop accepting connections, finish queued room work, close connections, exit.

## 5. Web app

### 5.1 Core
- **React 19**, **Vite**, TypeScript.
- **React Router** for `/`, `/debug` and in-room routes (defined with the rooms subsystem).
- **Zustand** store holding connection status, the current view, host actions and the animation
  queue. No server-cache library; all game data arrives over the WebSocket.
- **WebSocket client** (`net/`):
  - reconnects automatically with backoff
  - keeps the rejoin token in localStorage
  - sends `hello` on every connect; the server answers with a full view, so the screen always
    resyncs

### 5.2 Visuals
- **Motion**:
  - shared `layoutId`s so a card animates between hand, table and winner's pile, and between the
    face-down spot and the hand
  - `AnimatePresence` for things entering and leaving
  - springs for card lift and press
  - drag gestures to play a card
  - `MotionConfig reducedMotion="user"` so the device's reduced-motion setting is respected
- **Card flips** use CSS 3D transforms.
- **Tailwind CSS v4**:
  - colours, spacing, radii and fonts defined once with `@theme`
  - container queries with `@container`
  - fluid sizes with `clamp()` and `dvh`
  - sizes calculated at runtime (card width, seat positions) passed in as CSS variables
  - no fixed pixel layout (design §12.7)
- **Radix UI primitives** for dialogs, menus, popovers and toasts: correct focus and keyboard
  handling, with a fully custom look.
- **Cards** are SVG React components, crisp at any size.
- **Fonts** are bundled through Fontsource, with no requests to Google.
- **Pictures and image assets** (for example backgrounds, table textures, card backs, face-card
  artwork, illustrations, logo and app icons) are generated with the **Gemini MCP**. No stock
  or placeholder images.
  - Every prompt to the Gemini MCP must explicitly ask for **high-quality, polished, visually
    appealing** output that matches the app's visual style.
  - Generated files are committed under `apps/web/src/assets/`, with the prompt used recorded
    next to them so an asset can be regenerated in the same style.
- The card art, fonts, colours and screen designs are decided in the UI brainstorm.

### 5.3 Animation queue (design §12.6)
- A plain TypeScript module in `animation/`, outside components.
- Each `update` from the server adds its redacted events and resulting view to the queue.
- The UI renders a **displayed view** that advances **one event at a time**. For each event, the
  queue runs that event's animation step and waits for it to finish (Motion animations return a
  promise) before applying the next.
- **Catch-up**: after a reconnect, while the tab is hidden, or when the queue grows long, the
  queue skips to the latest view.
- Game logic never waits on animation. A richer animation for one event replaces only that
  event's step.

### 5.4 Other
- **i18next** with **react-i18next**. Strings live in `locales/en.json`. Translation keys are
  typed, so a missing or misspelled key fails to compile.
- **QR codes** with `qrcode`, rendered as SVG.

### 5.5 Code layout (`apps/web/src/`)
| Folder | Contents |
|---|---|
| `logic/` | Pure functions: card sizing, seat positions relative to the viewer, which controls to show |
| `net/` | WebSocket client |
| `store/` | Zustand store |
| `animation/` | Event queue and per-event animation steps |
| `components/` | Card, hand, seat, table, bubbles and other shared components |
| `screens/` | Home, create, waiting room, game, couch mode, Table view, debug |

## 6. Nix flake

### 6.1 Inputs and systems
- One input: `nixpkgs`, on a stable release branch, pinned in `flake.lock`.
- Systems: `x86_64-linux`, `aarch64-linux`, `aarch64-darwin`, using a small helper function
  instead of flake-utils. The NixOS module is Linux only.

### 6.2 Outputs
| Output | Contents |
|---|---|
| `devShells.default` | Node.js 24, pnpm, SQLite, Biome (from nixpkgs), Python and a C compiler for building `better-sqlite3`, `nixfmt` |
| `packages.default` | The app (`nix/package.nix`) |
| `apps.default` | `nix run` starts the server |
| `nixosModules.default` | `services.fiftysix` (`nix/module.nix`) |
| `checks` | Typecheck, Biome and the package build, run by `nix flake check` |
| `formatter` | `nixfmt` |

### 6.3 Package
- Dependencies are fetched from `pnpm-lock.yaml` using nixpkgs' pnpm support into a
  hash-pinned store path.
- `pnpm build` bundles the server with esbuild and builds the web app with Vite.
- Output:
  - `$out/lib/fiftysix/server.js`
  - `$out/lib/fiftysix/web/`: static files
  - `$out/lib/fiftysix/node_modules/`: only what can't be bundled (`better-sqlite3`)
  - `$out/bin/fiftysix`: runs the server with nixpkgs' Node
- `better-sqlite3` is compiled against nixpkgs' SQLite.
- When `pnpm-lock.yaml` changes, the dependency hash in `nix/package.nix` must be updated.

### 6.4 NixOS module
`services.fiftysix`:

| Option | Type | Default | Notes |
|---|---|---|---|
| `enable` | bool | `false` | |
| `package` | package | this flake's package | |
| `host` | string | `"127.0.0.1"` | |
| `port` | port | `8056` | |
| `openFirewall` | bool | `false` | Opens `port` in the firewall |
| `databaseUrl` | string | SQLite file in the state directory | |
| `debugPasswordFile` | null or path | `null` | `null` disables /debug. Works with sops-nix, agenix or a plain file. |
| `allowedOrigins` | list of strings | `[]` | Empty allows any origin |
| `logLevel` | string | `"info"` | |

systemd service:
- `DynamicUser=true`
- `StateDirectory=fiftysix` (data in `/var/lib/fiftysix`)
- `LoadCredential=debug-password:<debugPasswordFile>`, with `DEBUG_PASSWORD_FILE` pointing into
  the credentials directory. Root-owned secrets work, and the secret never enters the Nix store
  or an environment variable.
- `Restart=on-failure`
- Hardening: `ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges=true`,
  `PrivateTmp=true`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`

Example:
```nix
services.fiftysix = {
  enable = true;
  host = "0.0.0.0";
  port = 8056;
  debugPasswordFile = config.sops.secrets."fiftysix/debug-password".path;
};
```

No reverse proxy, TLS or domain configuration is included. The proxy in front must pass
WebSocket upgrades through for `/ws`.

## 7. Development workflow

Root scripts, run inside the dev shell (`nix develop -c pnpm <script>`):

| Script | Does |
|---|---|
| `pnpm dev` | Server with auto-restart (tsx watch) plus the Vite dev server. Vite proxies `/api` and `/ws` to the server, so development is same-origin like production. |
| `pnpm build` | Bundle the server and build the web app |
| `pnpm start` | Run the built server |
| `pnpm typecheck` | `tsc` across all packages |
| `pnpm lint` | Biome check |
| `pnpm format` | Biome format |

## 8. Conventions (added to AGENTS.md)

- `packages/engine`: no dependencies, no imports from other packages, Node or the browser.
- `apps/web`: imports only types from `protocol`; never code from `engine` or `server`.
- Every message crossing the network has a Zod schema in `protocol`, checked by the server
  before anything else.
- Every UI string goes through i18next. No hard-coded text in components.
- No fixed pixel layout: Tailwind fluid and container-query utilities, with calculated sizes
  passed as CSS variables.
- Animations go through the animation queue and Motion, and respect `reducedMotion="user"`.
- Pictures and image assets are generated with the Gemini MCP, with prompts that explicitly ask
  for high-quality, polished, visually appealing output (§5.2).
- Secrets are passed as files (`…_FILE` variables, `…File` module options).
- After changing `pnpm-lock.yaml`, update the dependency hash in `nix/package.nix`.

## 9. Order of work

Each step gets its own implementation plan.

1. **Skeleton** (this spec):
   - flake, pnpm workspace, TypeScript and Biome config, empty `engine` and `protocol` packages
   - server: config parsing, `/healthz`, WebSocket `hello`, storage interface with the first
     migration, serving the built web app, graceful shutdown
   - web app that connects over WebSocket and shows the connection status
   - `nix build`, `nix run` and the NixOS module working
2. **Engine** (engine spec).
3. **Rooms subsystem** ([design](rooms-subsystem-design.md)): joining, rejoining,
   seats, readiness, host, stalls, Table view PIN, persistence and the full message list.
4. **UI and visual design**: brainstorm, then plan. Card art, fonts, colours, every screen and
   animation.
