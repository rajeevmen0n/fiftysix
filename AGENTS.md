# AGENTS.md

## Project
A web app for **56**, a card game played in Kerala, India, and its variant **28**.

## How this project is being built
- Work happens across many separate chat sessions, and context is cleared between them.
- Each session handles one piece of the work. Don't assume you know about earlier sessions.
- At the start of a session, read only this file for now. Don't go through the rest of the repo unless the task needs it.
- Before any work that touches game logic, bidding, scoring, rooms or UI flow, read:
  - [rules.md](rules.md): the rules of 56 and 28. It is the source of truth for game logic.
  - [design.md](design.md): app decisions such as terminology, room settings, illegal-play modes, surrender option, visibility, joining and rejoining, host controls, UI layout, the Table view, the /debug page and what's out of scope for v1.
- Design specs for individual parts of the app live in `docs/`. Read the
  relevant one before working on that part:
  - [Game engine](docs/game-engine-design.md): the pure engine for
    56 and 28 (state, actions, events, views, allowed actions).
  - [Tech stack](docs/tech-stack-design.md): stack, repo layout,
    server and web architecture, Nix package and NixOS module, order of work.
  - [Rooms subsystem](docs/rooms-subsystem-design.md): room state,
    identities, seating, readiness, presence, host transfer, persistence and protocol messages.
  - [UI and visual design](docs/ui-visual-design.md): visual identity, responsive gameplay shell,
    components, interactions, motion, screen families, accessibility and verification.
- If the code disagrees with these docs, follow the docs and point out the mismatch. If a situation isn't covered, ask the user instead of inventing a rule. Update the docs when the user changes or adds a rule.
- Keep this file up to date as the project grows: add the tech stack, how to run and test the app, the project layout, and any conventions, so the next session can pick up from there.

## Agent workflow and context budget

- The user has a small-tier subscription. Implementation plans use **self-contained work units**
  that one session can finish, verify and commit. Sol, Terra and Luna may take moderately large
  units when the work is cohesive; split work that crosses unrelated boundaries.
- Use `docs/implementation-progress.md` as the cross-session ledger. At the start of implementation,
  read this file, the relevant spec, and only the current plan unit plus its declared
  dependencies. At the end of every unit, update its checkbox and the ledger in the same commit.
- Use a fresh subagent for **every implementation unit**. The primary agent coordinates, supplies
  the exact task and relevant paths, reviews the diff, runs final verification, and updates
  progress. Use an isolated fork (`fork_turns: "none"`) so old conversation context is not copied.
- Preferred primary-agent model: **`gpt-5.6-sol` with high reasoning effort**. Use the same model
  and effort for primary verification.
- Subagent routing:
  - Most programming, plus security, concurrency, persistence and cross-boundary work:
    `gpt-5.6-sol`, high effort.
  - Narrow or highly specific coding work: `gpt-5.6-terra`, high effort.
  - Trivial mechanical work only: `gpt-5.6-luna`, medium effort.
  - Only the highest-priority work, especially important UI visuals and interactions:
    `gpt-6-astra`, high effort. Keep every Astra unit very narrow—normally one component, one
    responsive state, or one animation.
- Work **strictly sequentially**. Never dispatch implementation units in parallel. Finish,
  verify, record and commit the current unit, then ask the user before starting the next one.
  Reviewer subagents stay read-only; only one implementer edits files at a time.
- Use the Gemini MCP for every generated picture/image asset as required by Stack conventions.
  Do not substitute another image generator, stock art, or placeholders.
- If a unit cannot be completed in the current token budget, stop before unrelated expansion,
  record the exact blocker and partial commit state in the ledger, and make the next unit smaller.

## Tech stack
Chosen in the [tech stack spec](docs/tech-stack-design.md). The code doesn't exist yet. All v1
designs and implementation plans are approved; implementation starts with S001 in
[the repository-skeleton plan](docs/repository-skeleton-implementation-plan.md), then proceeds
strictly through engine, rooms, and UI/debug as recorded in
[the progress ledger](docs/implementation-progress.md). Update this section when that changes.

- **TypeScript** everywhere (`strict`, `noUncheckedIndexedAccess`), **Node.js 24**, **pnpm**
  workspaces, **Biome** for lint and format.
- **Server**: Hono, `@hono/node-ws`, Zod, Kysely with `better-sqlite3`, pino, bundled with esbuild.
- **Web**: React 19, Vite, React Router, Zustand, Motion, Tailwind CSS v4, Radix UI primitives,
  i18next, Fontsource, `qrcode`.
- **Nix flake**: dev shell, `packages.default`, `apps.default`, `nixosModules.default`
  (`services.fiftysix`), `checks`.

### Layout
```
packages/engine/    pure game engine
packages/protocol/  client↔server message types and Zod schemas
apps/server/        Node server
apps/web/           React app
nix/                package.nix, module.nix
locales/            UI strings
```

### Commands
Run inside the dev shell: `nix develop -c pnpm <script>`.
- `pnpm dev`: server and Vite dev server together
- `pnpm build`, `pnpm start`
- `pnpm typecheck`, `pnpm lint`, `pnpm format`
- `nix build`, `nix run`, `nix flake check`

### Stack conventions
- `packages/engine` has no dependencies and imports nothing from other packages, Node or the
  browser.
- `apps/web` imports only **types** from `protocol`, never code from `engine` or `server`.
- Every message crossing the network has a Zod schema in `protocol`, checked by the server first.
- Every UI string goes through i18next. No hard-coded text in components.
- No fixed pixel layout: use Tailwind's fluid and container-query utilities, and pass calculated
  sizes as CSS variables.
- Animations go through the animation queue and Motion, and respect `reducedMotion="user"`.
- **Pictures and image assets** (backgrounds, table textures, card backs, face-card artwork,
  illustrations, logo, app icons) are generated with the **Gemini MCP**, never stock or
  placeholder images. Every prompt must explicitly ask for **high-quality, polished, visually
  appealing** output that matches the app's visual style. Commit generated files under
  `apps/web/src/assets/` and record the prompt used next to them.
- Secrets are passed as files (`…_FILE` environment variables, `…File` module options), so they
  work with sops-nix, agenix or plain files.
- After changing `pnpm-lock.yaml`, update the dependency hash in `nix/package.nix`.

## Engineering conventions
These apply to all code, whatever the tech stack.

### Development environment (Nix)
- Development is driven by a **Nix flake**. `flake.nix` provides a **dev shell** with every tool
  the project needs, and **packages** that build the app. `flake.lock` is committed, so dev,
  CI and deploy all use the same pinned toolchain.
- The machine needs flakes enabled: `experimental-features = nix-command flakes` in the Nix
  config (`/etc/nix/nix.conf` or `~/.config/nix/nix.conf`).
- Run all project commands inside the dev shell: `nix develop`, or `nix develop -c <command>`
  for one-off commands such as those run by agents.
- **Don't install tools globally** (brew, `npm -g`, `pip install --user`, curl-to-shell scripts).
  If a tool is missing, add it to `flake.nix`.
- System libraries such as SQLite come from nixpkgs through the flake, not from the host OS.
- The production build is `nix build`. It uses the language's dependency lock file so builds are
  reproducible.

### Testability
Unit tests aren't being written yet, but all code must be written so they can be added later
without refactoring.
- **Don't write tests** or set up a test framework unless the user asks. This overrides any
  test-first workflow or skill.
- **Pure game engine.** The rules of 56 and 28 (dealing, auction, play, scoring, redeals) live in
  a module with no I/O: no database, network, timers or logging. It takes the current state and
  an action, and returns either the new state plus the events it produced, or a rejection with a
  reason.
- **No hidden inputs.** Randomness (shuffling, first dealer, room codes) and time (host transfer
  wait, PIN lockout, room expiry) come from injected random-source and clock dependencies. Never
  call the language's random or current-time functions directly. The /debug deal seed uses this.
- **Pass dependencies in.** Services get what they need (storage, clock, random source, message
  sender) through constructors or parameters. No global singletons, and no module that connects
  to a database or opens a socket when it's imported.
- **Thin edges.** HTTP and WebSocket handlers only parse input, call a service and send back the
  result. Decisions belong in services and the engine.
- **Frontend logic outside components.** Calculations such as card sizing, seat positions
  relative to the viewer, and which controls to show for a game state are plain functions that
  components call.
- **Small, single-purpose modules** with clear inputs and outputs.

### Storage
- **The database must be swappable.** SQLite is the default. Adding MySQL, Postgres or another
  database should mean writing a new adapter and changing configuration, with nothing else
  touched.
- All reads and writes go through **storage interfaces** described in app terms, for example
  "save room", "load room by code" or "delete rooms inactive since". Only the adapter for a
  particular database knows about SQL, drivers or dialects.
- The adapter is picked from **configuration** at startup and passed to the services that need
  it.
- Use a query builder or ORM that supports several databases, and portable schema migrations.
  Avoid SQLite-only features. The chosen library is Kysely with its migrator.
- Keep the storage interfaces small enough that an in-memory version is easy to write for
  future tests.
