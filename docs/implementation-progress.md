# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E010 | Verify the complete engine and hand off to rooms |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E009 — Implement capabilities, views, and event redaction — implementation commit
`feat(engine): expose safe views and actions`.

- Added `views.ts` (`view`, `redactEvent`, allowed actions, `allowedHostActions`) and
  `views.test.ts`; `index.ts` exports the functions and view/redacted-event types. Interfaces
  match plan E009.
- Views: public data for everyone (Table view gets nothing private); a seat adds its own hand,
  face-down card, `allowedActions`, and `resultDecided` only when its team is the certain loser.
  Unrevealed 28 trump is `{type:"hidden", suit}` with `suit` only for the bidder. Round history
  (none/last/full) and live points follow settings. No host or debug viewer: the service adds
  `allowedHostActions`; /debug reads full state.
- `faceDown` is null after the reveal (settled by rules §10.3, spec §9.3/§11.2/§11.3: the card is
  shown once via the public `trumpRevealed` event, then is an ordinary hand card). **Optional
  user question:** keep a public "revealed card" marker until it is played (needs a new state
  field and spec §6.3/§11.3 edits). Reviewer recommends no.
- Redaction is stateless: `dealt` → own hand + card counts (never `undealt`); `cardPlaced`/
  `faceDownReturned` card only to owner; `auctionEnded` hidden suit only to bidder; `roundWon`
  points null without live points; `resultDecided` → `null` for non-losing viewers; `matchEnded`
  summary rebuilt from public fields. Caller must pass a seat valid for the event's table.
- Allowed actions duplicate `decide`'s conditions by hand; a seeded exploration test (6 configs ×
  2 seeds × 200 actions, ~5.4s) checks capabilities ↔ `decide` both ways for every seat, leak
  checks for every viewer, and coverage of every phase/event/capability/disqualification kind.
  E010's matrix should keep this agreement check.
- Rooms notes: deliver redacted events only to the current occupant at delivery time, never
  replay pre-occupancy per-seat events (rooms spec §7.3/§8.3); unseated viewers are `{type:"table"}`.
- One Opus implementer and one Opus reviewer; one correction round (vacuous assertion, comment,
  test runtime 18s → 6s, order-independent coverage test, doc comment); reviewer approved.
- 220 tests (22 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (220/220),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E010, Verify the complete engine and hand off to rooms.

## Previously completed unit

E008 — Implement result certainty and surrender voting — implementation commit
`feat(engine): implement result certainty and surrender voting`.

- Added `surrender.ts` (`losingTeamIfCertain`, `decideSurrenderAction`, internal helpers, and
  evolvers for the five surrender events); the certainty check runs in `play.ts` `completePlay`
  right after `roundWon`. `engine.ts` routes surrender actions/events; the `unsupportedAction` and
  `missingEvolver` placeholders were deleted.
- Certainty: defenders lost once bidding-team points reach the bid; bidding team lost once its
  points plus all uncollected points (56/28 minus collected) fall below the bid. `resultDecided`
  is emitted once, only with the surrender option on, and also after the final round (between
  `roundWon` and `matchEnded`, spec §9.6/§10.1; the UI may skip that notice).
- Votes: proposer counts as yes; passes at ⌊T/2⌋+1 (2/2, 2/3, 3/4); fails early when it can no
  longer pass. Orders: `surrenderVoted` → `[surrenderFailed]` or `surrendered`, `matchEnded`,
  `[sessionEnded]`. A failed vote sets `lastFailedRound`, lifted at the next round.
- No new rejection codes: `surrenderVoteRunning` for a losing-team proposal during a vote; other
  surrender rejections use `actionNotAllowed` with a `reason` (documented in spec §10.1). A
  winning-team proposal gets `resultNotDecided` (no vote) or `notOnLosingTeam` (vote running), so
  certainty never leaks.
- Invariant `invalidSurrender`: `decided === losingTeamIfCertain(state)`, vote well-formed,
  surrender state empty outside play or with the option off. Test fixtures that built impossible
  surrender states were rewritten to reach them legally (`scoring.test.ts` `buildRounds`/`withVote`).
- Still open: E007 note (round-winner/`trumpPlayed` invariants not added because `buildRounds`
  uses fake winners), E005/E006 nits.
- One Opus implementer and one Opus reviewer; one correction round (four non-blocking nits);
  reviewer approved.
- 198 tests (26 new).
- Verification on 2026-11-17: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (198/198),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E009, Implement capabilities, views, and event redaction (user authorized continuing
  without per-unit approval for this session).

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
