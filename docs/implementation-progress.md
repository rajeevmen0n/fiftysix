# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | Complete | E010 | Complete |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | In progress | R003 | Implement presence, replacement, and host succession policy |
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
8. Rooms spec §3.1 (provisional, R002): names reject bidi embedding/override/isolate controls
   (U+202A–202E, U+2066–2069) and must contain at least one visible character; ZWJ/ZWNJ kept.
   Still accepted: U+2800 (Braille blank) and LRM/RLM/ALM marks.

## Last completed unit

R002 — Implement the pure room aggregate and seating/readiness policy — commit
`feat(server): add room seating and readiness policy`.

- Added pure modules under `apps/server/src/rooms/` (`types`, `snapshot`, `names`, `invariants`,
  `seating`, `readiness`, `index`) with tests; `apps/server` gained a `test` script. Plan R002
  now lists the produced signatures and implementation notes.
- Stages: `arranging`, `matchActive` (engine `awaitingDeal`…`play`), `betweenMatches`
  (`matchOver`), `sessionOver`. Transitions are immutable, never bump `revision`, and reject
  no-ops so every acceptance carries an event.
- Seating: free self-seating while arranging; after the first match only unseated identities
  (newcomers/replacements) may sit; no seating at `sessionOver`. Host (player host or Table with
  host controls; functions take `PrincipalScope`) may move/swap while arranging or between
  matches; `setFirstDealer` only while arranging. Own-seat host move → `action_not_allowed`.
- Readiness: seat/dealer changes outside a match clear all Ready; a replacement claiming a seat
  mid-match keeps others' Ready; `replacementReady` = replacement's "Ready to resume".
  `readinessGate` returns protocol `RoomGate` (`readiness`/`stalled`/`playing` + missing lists).
- Names: display = trim, NFKC, trim; key = NFKC, upper→lower, NFKC; 1–24 graphemes
  (`Intl.Segmenter("und")`); provisional rule (pending item 8). Invariants check stored names
  only for canonical form, so a Node Unicode update can't invalidate a room.
- Handoffs written into the plan: R003 (no vacancy marker; `transferHost` takes the actor), R007
  (never offer no-op capabilities), R009 (`clearAllReady` at every match end). Host-null
  invariant tightening belongs to R003.
- One Opus implementer and one Opus reviewer; one correction round; reviewer approved.
  `pnpm-lock.yaml` unchanged.
- 330 tests (server 56 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (330/330),
  and `git diff --check` passed.
- Next unit: R003, Implement presence, replacement, and host succession policy.

## Previously completed unit

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
