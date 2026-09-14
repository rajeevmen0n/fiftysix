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
- If the code disagrees with these docs, follow the docs and point out the mismatch. If a situation isn't covered, ask the user instead of inventing a rule. Update the docs when the user changes or adds a rule.
- Keep this file up to date as the project grows: add the tech stack, how to run and test the app, the project layout, and any conventions, so the next session can pick up from there.

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
  Avoid SQLite-only features. The exact library is chosen along with the tech stack.
- Keep the storage interfaces small enough that an in-memory version is easy to write for
  future tests.
