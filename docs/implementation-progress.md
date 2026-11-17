# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | Complete | E010 | Complete |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | In progress | R001 | Execute R002 |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Pending user confirmations

Decisions made while the user asked not to be interrupted (session of 2026-11-17). Each is
recorded in the docs; confirm or change them:

1. Rooms spec §10 (provisional): HTTP-only codes `room_not_found` (404) and `invalid_request` (400).
2. Rooms spec §3.1 (provisional): names reject every `\p{Cc}` (incl. C1 such as NEL) and
   ill-formed UTF-16 — stricter than design §9's literal list.
3. Rooms spec §7.3 (provisional): capability lists travel inside `view` (as the plan's `RoomView`).
4. Rooms spec §8.3 (provisional): revocation/expiry delivered only by terminal `accessRevoked`;
   bystanders see `playerLeft {left|removed}`.
5. Rooms plan R007 bullet changed: unseated identities get the public `{type:"table"}` engine view
   (session log, past sessions) whenever an engine exists, instead of "no engine view" (rooms spec
   §3.1/§8.1, design §11).
6. Optional (from E009): keep a public "revealed card" marker after a 28 reveal until it is played?
   Current behaviour: no (reviewer recommendation).
7. Open for R005: when the host-transfer wait elapses with nobody connected, is `hostId` the old
   disconnected host or `null` while the transfer is pending (rooms spec §5.3/§11)?

## Last completed unit

R001 — Define the complete rooms protocol — commit `feat(protocol): define rooms protocol`.

- Added `packages/protocol/src/rooms/` (`model`, `commands`, `events`, `views`, `http`,
  `messages`, `index`) with tests (`commands`, `http`, `messages`, `type-assertions`) and
  `tsconfig.test.json`. Removed the `EngineBoundary`/`ProtocolBoundary` placeholders; protocol
  re-exports engine types (type-only) so web never imports the engine.
- HTTP: create/join/Table endpoints returning `{roomCode, token}`; errors `{code}`. WebSocket:
  `hello`, `command {commandId, command}` (12 room commands); `helloAccepted`, `update`,
  `commandRejected {source: room|engine}`, `error`, `accessRevoked`. Room event names, `RoomGate`,
  `hostChanged` reasons, and allowed room/host action shapes were chosen (spec gives categories).
- All objects strict in both directions, so outbound parse rejects leaked fields; rejection
  details are flat primitives only (engine `invalidConfig {issues}` must never be forwarded over
  WebSocket — R007/R008 drop or flatten it). 28 commands parsed per game (`roomCommandSchemas[gameType]`)
  and reject `suit`/`style` (incl. `null`). Settings: per-field caps and redeal cap in protocol;
  deck divisibility and tier shape left to engine `validateConfig` (R010 consumes
  `ParsedCreateRoomRequest`). Player/command IDs are `[A-Za-z0-9_-]{1,64}` (R002/R006 must generate
  in that alphabet).
- Exact type-equality assertions (run under `pnpm typecheck`) tie schemas to engine and room types
  for both games; a real-engine test parses every view, redacted event, offered action, and
  random-probe rejection through the message envelopes.
- Note for R008/R009: `message.revision === view.revision` is enforced, so a duplicate `commandId`
  replay must answer with the current revision and view.
- One Opus implementer and one Opus reviewer; one correction round (one blocking comment that
  contradicted the spec, plan R010 signature, primitive rejection details, 28 type checks,
  AGENTS.md test line, provisional spec notes); reviewer approved. `pnpm-lock.yaml` unchanged.
- 274 tests (engine 235, protocol 39 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (274/274),
  and `git diff --check` passed.
- Next unit: R002, Implement the pure room aggregate and seating/readiness policy.

## Previously completed unit

E010 — Verify the complete engine and hand off to rooms — commit `docs: complete game engine`.
**The pure engine track is complete.**

- Verification found no engine rule defects; engine behaviour is unchanged. Added
  `verification.test.ts`: whole-session matrix (56 at 4/48, 4/64, 6/48, 8/48, 8/64; 28 Block and
  Auto-stop) with per-action purity, invariants, conservation, token, JSON-replay and leader-chain
  checks; rejected probes; an independent rules oracle written from rules.md; leak scans; a
  required-coverage list (every phase, contract multiplier, 28 second-auction path, redeal tag,
  disqualification kind in both modes, outcome, surrender pass/fail at 4/6/8); config/deck matrix;
  package-boundary checks. Its header maps each item to its tests.
- Carry-over nits resolved: `hasSecondAuction` in `config.ts` is the single 28 bid-limit
  expression; invariants now check the face-down slot in `28-second`, stored round winners and
  `trumpPlayed`; `checkFinishedMatchSummary` uses structural `jsonEqual`; `scoring.test.ts` `run()`
  replays from JSON copies and compares bytes. Left on purpose: `buildRounds` fixtures don't
  enforce follow-suit (winners and `trumpPlayed` still obey the rules; legal play is covered by
  the session matrix).
- AGENTS.md gained an "Engine" section: modules/exports, how a service drives the engine, view
  and redaction rules, the /debug full-state exception, and the rooms delivery rule (deliver
  redacted events only to the current occupant; never replay pre-occupancy per-seat events).
- For R001: `apps/server` does not import the engine yet, so the server-bundle inspection was
  vacuous; `index.ts` still exports placeholder `EngineBoundary = never`, imported by
  `packages/protocol/src/index.ts` — replace it.
- **Optional open user question (from E009):** keep a public "revealed card" marker after the
  28 reveal until the card is played? Reviewer recommends no; current behaviour shows it only via
  the public `trumpRevealed` event.
- One Opus implementer (resumed once after a usage-limit stop) and one Opus reviewer; one
  correction round (AGENTS.md wording, stricter coverage tags, header clarifications, byte replay,
  leader-chain check); reviewer approved.
- 235 tests (15 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (235/235),
  `git diff --check`, and the zero-dependency manifest check passed. `nix build`/`nix flake check`
  were not run (user runs Nix builds).
- Next unit: R001 (rooms subsystem).

## Implementation readiness

Full rules, product, architecture, engine, rooms, UI, security, responsive, accessibility,
deployment, and cross-plan review completed on 2026-09-14.

| Check | Result |
|---|---|
| Authoritative design coverage | Approved: `rules.md`, `design.md`, and all four subsystem designs |
| Sequential implementation plans | Approved: S001–S009, E001–E010, R001–R014, U001–U028 |
| Cross-track order | Skeleton → engine → rooms → UI/debug |
| First executable unit | S001 |
| Unresolved product or rules decisions | 0 |
| Placeholder/TBD requirements | 0 |
| Current stable toolchain probe | NixOS 26.05: Node 24.19.0, pnpm 11.25.0, Biome 2.4.15, SQLite 3.51.2 |

Implementation remains strictly unit-by-unit. A completed unit updates its plan checkbox and this
ledger in the same commit, then stops for user approval before the next unit.

## Handoff procedure

1. Read `AGENTS.md`.
2. Read this file.
3. Read the relevant design spec.
4. Read only the current plan unit and the units named in its `Depends on` field.
5. Dispatch the unit to its suggested implementation agent and keep that agent available.
6. Dispatch review to a Claude Opus or GPT Sol review agent; reuse both agents for every
   correction and re-review, then run the unit's verification commands in the main session.
7. Mark the unit complete here and in its plan, record the commit, and name the next unit.
