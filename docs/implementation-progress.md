# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E004 | Await user approval before E005 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E004 — Implement the shared auction and complete 56 contracts — implementation commit
`feat(engine): implement auction rules`.

- Added `auction.ts` (`bidRange`, `decideAuctionAction`, `contractMultiplier`, and the
  `bidMade`/`passed`/`doubled`/`doubleCancelled`/`redoubled`/`forcedBid`/`auctionEnded`/
  `playStarted` evolvers) and wired them in `engine.ts`. 56 bids 28–56 strictly above the high
  bid; loss-stake affordability for bids, 2× win stake for doubles, 4× loss stake for
  out-of-turn redoubles by either doubled-team member. A double resets the pass count; a new bid
  emits `bidMade` then `doubleCancelled`. N−1 passes end the auction (also after a double);
  redouble ends it at once; N opening passes give dealer+1 the exempt, undoubleable forced
  28 no-trump contract. Completed 56 auctions emit `playStarted(dealer + 1)`.
- `decideAuctionAction` accepts any `EngineAction` and returns `actionNotAllowed` for the wrong
  phase/action type. It does not repeat `decide()`'s source/seat-range checks, so direct callers
  must pass seat-validated actions.
- User decisions on 2026-09-14: (1) stake tiers' win **and** loss stakes must be non-decreasing
  as the bid rises (rules.md §7.1, design.md, engine spec §4, E001 plan text, `config.ts`
  validation + `config.test.ts`); `bidRange` relies on it to return one contiguous range.
  (2) Malformed bids use the new `invalidBid` rejection code with `reason`
  `missingSuit`/`invalidSuit`/`missingStyle`/`invalidStyle`/`unexpectedStyle` (spec §8.2).
  (3) Bid-cancels-double order is `bidMade` then `doubleCancelled` (spec §11.1).
- `invariants.ts` gained `invalidAuctionState` (double only against the other team's unforced
  bid, redouble implies double) and a stage-aware consecutive-pass limit.
- `style` is checked for presence, not nullness: `style: null` is rejected. The protocol Zod
  schema (rooms track) must omit a null style or reject it the same way.
- `src/test-helpers.ts` holds the shared `deepFreeze` (excluded from the production tsconfig).
- Deferred to E005: `auction.ts` hard-codes 56 min/max/forced values and rejects 28 stages;
  `carriedBid` is not read; `evolveAuctionEnded`/`evolvePlayStarted` require phase `auction`;
  the invariant `doubledBy ⇒ highBid` must be revisited for the carried-bid representation.
  Redouble by the wrong team returns `doubleNotAllowed` (`notDoubledTeam`); the spec names no code.
- The interrupted first session's work was resumed on 2026-09-14: one Opus review, one
  correction round, and an Opus re-review approved the diff.
- 82 tests (45 new): 4/6/8-player cycles for normal and doubled ends, leader vs bidder, double
  resetting passes, exact ordered end-of-auction events, affordability edges, partner/self
  overbids, forced bid, every named rejection, and a frozen-input full-log replay compared as
  `JSON.stringify` from `newSession`.
- Verification on 2026-09-14: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (82/82),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E005, Implement 28 auctions, face-down placement, and second deal, after user
  approval.

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
