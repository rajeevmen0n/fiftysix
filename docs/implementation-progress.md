# Implementation progress

This is the durable handoff for new chats. Keep it short. Detailed requirements live in specs and
implementation plans.

## Current state

| Track | Plan | Status | Current unit | Next action |
|---|---|---|---|---|
| Repository skeleton | `docs/repository-skeleton-implementation-plan.md` | Complete | S009 | Complete |
| Pure engine | `docs/game-engine-implementation-plan.md` | In progress | E006 | Await user approval before E007 |
| Rooms subsystem | `docs/rooms-subsystem-implementation-plan.md` | Plan approved; engine prerequisite missing | — | Execute R001 after engine is complete |
| UI and visual design | `docs/ui-visual-implementation-plan.md` | Plan approved; prerequisites missing | — | Execute U001 after skeleton, engine and rooms are complete |

## Last completed unit

E006 — Implement scoring, host resolutions, and session transitions — implementation commit
`feat(engine): score matches and sessions`.

- Added `scoring.ts` (`scoreMatch`, `matchSummary`, `summaryContract`) and `host-actions.ts`
  (`decideHostAction`); `session.ts` gained `decideSessionAction` and the `matchEnded`,
  `sessionEnded`, `nextMatchStarted` and `sessionRestarted` evolvers.
- Payer selection follows design §10.3 for all five scored outcomes. `outcome.surrendered.team`
  is the **surrendering (losing)** team; `outcome.awarded.team` is the **winning** team named by
  the host — opposite polarities on identically shaped variants, now documented in `state.ts` and
  `events.ts` so E008's surrender producer can't invert one. Stake is the tier's win/loss stake
  times `contract.multiplier`; `transferTokens` caps a payment at what the payer owns, and the
  summary records actual movement plus running balances.
- `matchSummary` is the single construction site for every outcome, and always projects through
  `summaryContract`, which erases an unrevealed 28 trump to `{type:"hidden"}`. The earlier
  duplicate summary builders in `deal.ts`/`redeal.ts` were deleted. A `summaryLeaksHiddenTrump`
  invariant plus tests guard the erasure.
- `matchLog` gets scored outcomes, every host restart, and 28 redeals; 56 automatic redeals are
  not appended. `matchEnded` is emitted for every result so transient presentation stays possible.
- Session flow: scored match → `sessionOver` + `sessionEnded` when either team hits 0, else
  `matchOver`; `startNextMatch` only from `matchOver` with the dealer rotating counter-clockwise;
  `restartSession(firstDealer)` only from `sessionOver`, archiving winner and final tokens into
  `pastSessions` and resetting balances and log.
- Review (Opus, full diff against the specs) returned **no blocking findings**. Three of its nits
  were applied: a missing phase guard on the `matchEnded(redealt)` evolver (§13.1 — it was the
  only branch that could silently rewrite the phase), the team-polarity doc comments above, and
  phase-mismatch throw tests for the three session evolvers. Fixing the guard exposed an existing
  test that applied `matchEnded(redealt)` from `awaitingDeal`, an unreachable sequence; it now
  deals first (56 in one stage, 28 in two) and a companion test pins the throw.
- Non-blocking nits left for later: `checkFinishedMatchSummary` (`invariants.ts` ~147) compares
  the phase summary to the last log entry with key-order-sensitive `JSON.stringify`, safe only
  while both are the same object; the per-action replay assertion in `scoring.test.ts` `run()` is
  tautological (real replay coverage is the `E006 replay and immutability` block).
- **E005 carry-overs still open:** `invariants.ts` (~404) doesn't detect an empty face-down slot
  in `28-second` after a non-pass call, and `deal.ts` (~272) and `invariants.ts` (~367) express
  the 28 bid limit two different ways.
- This unit was implemented in a session that was interrupted before review; a later session
  re-ran verification, obtained the review, applied the nits, and committed.
- 141 tests (35 new): every payer row × ×1/×2/×4, extra tiers, capped payment, both session
  winners, hidden-trump erasure, restart in each eligible phase, award availability, dealer
  rotation for 4/6/8 players, session archival across two sessions, invalid system phase,
  evolver phase mismatches, invariants, and JSON replay.
- Verification on 2026-09-15: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (141/141),
  `git diff --check`, and the zero-dependency manifest check all passed.
- Next unit: E007, Implement card play, hidden-trump reveal, and disqualification, after user
  approval.

## Previously completed unit

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
