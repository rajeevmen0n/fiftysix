# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E003 | Await user approval before E004 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E003 — Implement dealing and automatic redeals — implementation commit
`feat(engine): deal cards and detect redeals`.

- Added `deal.ts` (`validateDeck`, `dealCards`, `decideDeal`, `evolveDealt`,
  `evolveAuctionStarted`) and `redeal.ts` (`redealReason`, `evolveRedealt`); wired `deal` in
  `routeAction` and `dealt`/`redealt`/`auctionStarted`/`matchEnded` in `evolve` (`engine.ts`).
  `validateDeck` checks exact multiset equality against `buildDeck(config)`; rejection `details`
  carry only counts/reason strings, never card contents. `dealCards` deals counter-clockwise from
  `dealer + 1`. `redealReason` checks team-without-Jack (team order) before any low hand (seat
  order), reusing `RedealReason` from `state.ts`.
- 56: full deal → redeal check → `redealt`+`matchEnded` (not appended to `matchLog`, per design
  §10.3) or `auctionStarted(56, dealer+1, 28)`. 28: first-stage deal only (4/seat to hands, 4/seat
  to `undealt`) → `auctionStarted(28-first, dealer+1, 14)`, no redeal check yet. The 28 second
  deal/redeal trigger (design §8.4) is explicitly out of scope — it depends on the auction and
  hidden-trump machinery E004/E005 have not built yet.
- `evolveMatchEnded` (new, in `engine.ts`) only implements the `redealt` outcome (appended to
  `matchLog` for 28, not for 56, per design §10.3); every other `MatchOutcome` throws via
  `outcomeNotYetImplemented` rather than being half-built ahead of the scoring/surrender/`endMatch`
  units that will actually produce them and must also wire the paired `sessionEnded` event (design
  §10.4) — an independent review flagged the first draft's premature `matchOver`/`sessionOver`
  handling as both non-compliant (56/28 `matchLog` rule was backwards for 28) and a latent
  collision with the unimplemented `sessionEnded` evolver.
- `evolveAuctionStarted` throws (design §13.1 "throw instead of recover") on an unexpected phase
  rather than silently returning state unchanged — the review's first pass had a silent no-op
  here. `evolveDealt` throws for `stage: "second"` rather than silently rebuilding (and thereby
  discarding) live match state; the actual second-deal merge is a later unit's job.
- `evolveDealt` parks a freshly dealt match under phase `auction` with `auction: null` as a
  transient shape that only exists between the `dealt` and `auctionStarted`/`redealt` events of
  one `act()` call; this is documented in-line since it technically fails `checkMatch`'s
  `phaseMatchMismatch` check if inspected in isolation (confirmed by direct test) —
  `assertEngineInvariants` is only guaranteed to hold after a full action, never mid-action.
- `invariants.ts` gained `missingCardLocation`: `checkCardLocations` now checks completeness
  (every configured card appears somewhere), not just absence of duplicates/unknowns.
- 37 tests total (23 new): every dealable player/deck-size combination, first/last-seat dealing,
  every invalid-deck shape, each redeal reason and their precedence, same-dealer redeal, 28
  first-deal deferral, the 56/28 `matchLog` split, and each of the three throw-instead-of-recover
  cases above.
- Primary verification on 2026-09-14: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`
  (37/37 passing), `git diff --check`, and a zero-dependency manifest check all passed.
- Deferred/settle-later items carried over from E002 remain open (see prior entries in git
  history for §8.3 pending-trump representation and E001's unfrozen lookup constants); the 28
  second-deal merge into live match state is now also an explicit E004/E005-era decision point.
- Next unit: E004, Implement the shared auction and complete 56 contracts, after user approval.

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
