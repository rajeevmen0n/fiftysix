# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E005 | Await user approval before E006 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E005 — Implement 28 auctions, face-down placement, and second deal — implementation commit
`feat(engine): implement 28 auction flow`.

- Added `hidden-trump.ts` (`decidePlaceCard`, `faceDownIsForced`, placement evolvers) and
  `dealSecondStage` in `deal.ts`. Auction bid limits per stage live in `AUCTION_BID_LIMITS`
  (`config.ts`), replacing E004's hard-coded 56 values. 28 first auction bids 14–28, number only;
  the winner enters `placingCard`; forced 14 no trump skips placement.
- Event orders (spec §8.3/§8.4): first auction end → `placingCardStarted(seat)`; `placeCard` →
  `cardPlaced`, `auctionEnded(hidden)`, `dealt(second)`, then `auctionStarted(28-second)` or
  `playStarted(dealer + 1)`. Second auction new winner → `[faceDownReturned]`,
  `placingCardStarted`, then `cardPlaced`, `auctionEnded`, `playStarted`. All-pass carry →
  `auctionEnded(carried)`, `playStarted`. Second-deal redeal → `dealt(second)`, `redealt`,
  `[faceDownReturned]`, `matchEnded` with the public first-auction contract.
- Carried bid is copied into `highBid`/`doubledBy` plus an untouched `carriedBid`; the second
  auction's initial circuit ends after N passes while every call is a pass, otherwise N−1.
- User decisions on 2026-09-14: (1) new public `placingCardStarted(seat)` event; a 28 match may
  emit `auctionEnded` twice (spec §8.3, §8.4, §11.1, §11.2). (2) A 28 bid carrying `suit`
  (including `null`) is rejected as `invalidBid`/`unexpectedSuit`; this is only a server-side
  guard — the client never sends a suit for 28 and the protocol schema must reject it (§8.2).
  (3) **Rule change:** a first-auction bid of 28 (doubled or not) skips the second auction, like a
  redouble: second deal → redeal check → play (rules.md §10.2, spec §8.4, plan E005 text).
  (4) `match.contract` keeps the first-auction contract through the second auction and its
  placement, replaced only at the second `auctionEnded`; a restart in that window logs the public
  first-auction contract (spec §6.3, §10.3). An invariant ties it to `carriedBid`.
- Placement with the wrong seat returns `notYourTurn`; a card not in hand returns `cardNotInHand`.
- Non-blocking review nits left for later: `invariants.ts` (~326–330) doesn't detect an empty
  face-down slot in `28-second` after a non-pass call; `deal.ts` (~279) and `invariants.ts` (~302)
  express the 28 limit two different ways.
- One Opus implementer and one Opus reviewer; two correction rounds; reviewer approved.
- 106 tests (24 new): forced 14, normal/redoubled/28 first auctions, every second-auction
  minimum, all-pass carry, carried double/redouble, cancellation by raise, same-holder and
  different winners, second-deal redeals (incl. redoubled), 28 affordability, illegal
  placement, frozen-input replay, and card conservation after every action.
- Verification on 2026-09-14: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (106/106),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E006, Implement scoring, host resolutions, and session transitions, after user
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
