# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E002 | Await user approval before E003 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E002 — Establish actions, events, state, and the transition kernel — implementation commit
`feat(engine): add transition kernel`.

- Added JSON-safe state, action, event, rejection, outcome and redeal-reason unions
  (`state.ts`, `actions.ts`, `events.ts`, `result.ts`), `newSession`, the `decide`/`evolve`/`act`
  kernel (`engine.ts`) and `assertEngineInvariants`. `decide` checks known type → source →
  seat range → phase table, then `routeAction`. Later units plug in by replacing the placeholder
  in their `case` of the exhaustive `routeAction`/`evolve` switches (actions currently return
  `actionNotAllowed`; unimplemented events throw). `RedealReason`, `ScoredOutcome`,
  `IllegalPlayKind` live in `state.ts`; E003/E006 should reuse them rather than redefine.
- Test runner added: `pnpm test` → `node:test` via root `tsx`; test files are excluded from the
  engine tsconfig and typechecked by `tsconfig.test.json` (Node types there only). 14 tests cover
  session creation (including non-object config), source/seat/phase rejections with full details,
  immutability, JSON round-trip, replay equivalence, determinism, and each invariant code.
- Independent review found vacuous source-mismatch tests and a tautological team invariant. Fix
  round 1 asserted full rejection details (verified failing with the source check bypassed),
  removed the tautology, added match/session token invariants and non-object config rejection.
- Primary verification on 2026-09-14: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`,
  `git diff --check`, and the dependency/import audit passed. Temporarily unhandled action, event
  and phase variants failed `tsc` in all five exhaustive sites.
- Representation choices (spec silent): `dealt` carries `undealt` for replay (E009 must redact);
  deal stages `full`/`first`/`second`; `revealedInRound`/`lastFailedRound` are zero-based round
  indexes; summaries use `tokensMoved: {payer, amount} | null`; the contract carries bid `style`.
- Settle before E005: design §8.3 emits `auctionEnded(contract)` after each 28 auction, but after
  the first auction no card is placed yet, so `ContractTrump` (`hidden` requires a suit) cannot
  represent a not-yet-chosen trump; decide whether to add a pending trump variant or emit the 28
  contract after `cardPlaced`, and whether a contract exists during `placingCard`/second auction.
  For E007, `roundWinner(round, contract)` implies `trumpRevealed` rewrites `hidden(suit)` to
  `suit`.
- Deferred minors: exported card lookup constants are not frozen at runtime (E001); missing-card
  completeness invariant arrives with dealing in E003; unused `Disqualification` type.
- Next unit: E003, Implement dealing and automatic redeals, after user approval.

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
5. Dispatch the unit to the plan's suggested fresh subagent.
6. Review the diff and run the unit's verification commands in the primary session.
7. Mark the unit complete here and in its plan, record the commit, and name the next unit.
