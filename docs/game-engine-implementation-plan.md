# Game Engine Implementation Plan

> **Agent workflow:** Follow the lightweight develop-and-review loop in `AGENTS.md`; do not load
> an additional process skill. Use the checkboxes (`- [ ]`) for progress tracking.

**Goal:** Implement the dependency-free, deterministic game engine for complete sessions of 56
and 28, including auctions, hidden trump, play, redeals, scoring, surrender, host resolutions,
views, capabilities, and event redaction.

**Architecture:** `packages/engine` is a pure event-producing state machine. `decide` validates an
action and emits canonical events, `evolve` applies those events without policy checks, and `act`
composes the two; small rule modules own each decision boundary while one public engine module
routes actions and events. Full state stays server-only, while viewer-specific projections and
redacted events form the only read boundary used by rooms and protocol.

**Tech Stack:** TypeScript (`strict`, `noUncheckedIndexedAccess`), dependency-free
`packages/engine`, pnpm workspaces, Biome, Node.js 24 only as the development command runner.

**Spec:** `docs/game-engine-design.md`

**Status:** Approved on 2026-09-14 after rules coverage, downstream-interface, replay, type, and
completeness review.

## Global constraints

- Do not execute E001 until the repository skeleton is implemented and marked complete in
  `docs/implementation-progress.md`.
- Every unit reads `AGENTS.md`, `rules.md`, `design.md`, `docs/game-engine-design.md`,
  `docs/implementation-progress.md`, this header, the current unit, and its declared
  dependencies. The rules document wins over every other artifact.
- Work strictly sequentially. Use Claude Sonnet or GPT `gpt-5.6-terra` at high effort for the
  main agent. Dispatch one Claude Opus or GPT `gpt-5.6-sol` implementation agent at high effort
  for each engine unit, using an isolated initial fork (`fork_turns: "none"`), then dispatch one
  Claude Opus or GPT `gpt-5.6-sol` review agent at high effort.
- **Keep both agents available until the unit is completely finished.** Send every review finding
  back to the same implementer and every corrected diff back to the same reviewer; never replace
  either agent during correction and re-review rounds. After reviewer approval and main-agent
  verification, stop and ask the user before starting the next unit.
- Tests are not required solely for coverage, and no broad test framework is added preemptively.
  Use typecheck, lint, build, exhaustive-type checks, and direct inspection where sufficient. If
  verification requires deterministic scenarios, assertions, fakes, fixtures, replay code, or a
  custom harness, commit that code as focused automated tests instead of disposable `tsx`
  commands or temporary scripts.
- `packages/engine` has no package dependencies and imports nothing from Node, the browser,
  protocol, server, web, storage, network, clocks, random generators, or loggers.
- Engine inputs and outputs are plain JSON-safe data. Do not use classes, `Map`, `Set`, `Date`,
  functions, symbols, `bigint`, `undefined` fields, or mutated caller-owned arrays/objects in
  state, actions, events, views, or rejections.
- The engine knows only seats. Player identities, readiness, presence, host authorization,
  shuffling, persistence, and time remain outside it.
- The service supplies a complete shuffled deck and first dealer. The engine never creates
  randomness or repairs an invalid deck.
- `decide` never mutates state; `evolve` performs no policy validation; `act` applies emitted
  events in order. Replaying accepted events must reproduce byte-equivalent JSON state.
- Every action variant has an explicit seat, host, or system source. `ClientEngineAction` excludes
  source and system-only actions so protocol can reproduce and validate the client union.
- Treat every situation named in the rules/spec explicitly. If implementation exposes an
  uncovered game behavior, stop and ask the user rather than selecting a rule.

## Progress protocol

At unit start, set the engine row and unit to `In progress` in
`docs/implementation-progress.md`. At completion:

1. The retained review agent approves the entire diff, then the main agent reruns the unit's
   verification commands.
2. Change the unit heading from `[ ]` to `[x]`.
3. Record the commit, evidence, and next unit in `docs/implementation-progress.md`.
4. Commit the implementation, plan checkbox, and ledger update together.
5. Stop and ask the user before starting the next unit.

If blocked, keep the checkbox open and record the exact rule/interface blocker, current
working-tree/commit state, and smallest next action in the ledger.

## Planned files

```text
packages/engine/src/
  types.ts
  cards.ts
  config.ts
  seats.ts
  stakes.ts
  state.ts
  actions.ts
  events.ts
  result.ts
  invariants.ts
  session.ts
  deal.ts
  redeal.ts
  auction.ts
  hidden-trump.ts
  scoring.ts
  host-actions.ts
  play.ts
  surrender.ts
  views.ts
  engine.ts
  index.ts
```

Keep files focused on these responsibilities. If the skeleton established an equivalent export
or config path, modify it rather than creating a parallel boundary and record the substitution in
the progress ledger.

---

### [x] E001: Define cards, seats, configuration, and stakes

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/types.ts`
- Create: `packages/engine/src/cards.ts`
- Create: `packages/engine/src/config.ts`
- Create: `packages/engine/src/seats.ts`
- Create: `packages/engine/src/stakes.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** Completed repository skeleton.

**Interfaces produced:**

```ts
export type Seat = number;
export type Team = "A" | "B";
export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "J" | "9" | "A" | "10" | "K" | "Q" | "8" | "7";
export interface Card {suit: Suit; rank: Rank; copy: 1 | 2;}
export interface StakeTier {fromBid: number; toBid: number; winStake: number; lossStake: number;}
export interface EngineConfig {
  gameType: "56" | "28";
  playerCount: 4 | 6 | 8;
  includeEightsAndSevens: boolean;
  illegalPlayMode: "block" | "autoStop";
  startingTokens: number;
  stakeTiers: readonly StakeTier[];
  redealThreshold: number;
  surrenderOption: "off" | "on";
}
export interface ConfigRejection {ok: false; code: "invalidConfig"; details: Record<string, unknown>;}
export function buildDeck(config: EngineConfig): Card[];
export function validateConfig(config: EngineConfig): ConfigRejection | null;
export function nextSeat(seat: Seat, playerCount: number): Seat;
export function teamOf(seat: Seat): Team;
export function stakeFor(config: EngineConfig, amount: number): StakeTier;
```

- [x] Encode rank order and points exactly as J/3, 9/2, A/1, 10/1, K/Q/8/7/0. Build 56 decks
  with two distinguishable copies and either ranks J–Q or J–7; build 28 with one copy of all
  eight ranks. Card equality includes copy, while rank comparison does not.
- [x] Implement counter-clockwise seat helpers with even seats on Team A and odd seats on Team B.
  Reject out-of-range/non-integer seats at public boundaries rather than normalizing them.
- [x] Validate every config rule: game/player-count combinations; 28 requiring eights/sevens;
  56 card divisibility; starting tokens and every stake as whole numbers from 1–999; redeal
  threshold from zero through the game/player cap (56: 13/8/6 for 4/6/8 players; 28: 6); and
  ordered, gap-free, non-overlapping stake tiers covering exactly 28–56 or 14–28, whose win and
  loss stakes must each be non-decreasing as the bid rises.
- [x] Implement tier lookup, multiplier application, affordability predicates for bid/double/
  redouble, and capped token transfer that never produces a negative balance.
- [x] Run deterministic one-off checks for all valid deck sizes/configurations, total points,
  unique card identities, invalid player/card combinations, malformed tiers, alternating teams,
  seat wraparound, affordability, and capped transfers.
- [x] Run typecheck, lint, build, and `git diff --check`; require success. Inspect the engine's
  manifest/import graph for zero dependencies, update plan/progress, and commit
  `feat(engine): add cards configuration and stakes`.

---

### [x] E002: Establish actions, events, state, and the transition kernel

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/actions.ts`
- Create: `packages/engine/src/events.ts`
- Create: `packages/engine/src/state.ts`
- Create: `packages/engine/src/result.ts`
- Create: `packages/engine/src/invariants.ts`
- Create: `packages/engine/src/session.ts`
- Create: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E001.

**Interfaces produced:**

```ts
export type ClientSeatAction =
  | {type: "bid"; amount: number; suit?: Suit | "noTrump"; style?: "numberFirst" | "suitFirst"}
  | {type: "pass"}
  | {type: "double"}
  | {type: "redouble"}
  | {type: "placeCard"; card: Card}
  | {type: "askReveal"}
  | {type: "playCard"; card: Card}
  | {type: "proposeSurrender"}
  | {type: "voteSurrender"; vote: "yes" | "no"};
export type ClientHostAction =
  | {type: "endMatch"; resolution: {type: "restart"} | {type: "award"; team: Team}};
export type ClientEngineAction = ClientSeatAction | ClientHostAction;
export type EngineAction =
  | (ClientSeatAction & {source: {type: "seat"; seat: Seat}})
  | (ClientHostAction & {source: {type: "host"}})
  | {type: "deal"; source: {type: "system"}; deck: readonly Card[]}
  | {type: "startNextMatch"; source: {type: "system"}}
  | {type: "restartSession"; source: {type: "system"}; firstDealer: Seat};
export type EngineRejectionCode =
  | "invalidConfig" | "invalidSeat" | "actionNotAllowed" | "invalidDeck"
  | "notYourTurn" | "invalidBid" | "bidTooLow" | "bidOutOfRange" | "cannotAfford"
  | "doubleNotAllowed" | "noDoubleActive" | "cardNotInHand"
  | "faceDownNotPlayable" | "surrenderVoteRunning" | "revealNotAllowed" | "illegalPlay";
export type IllegalPlayKind =
  | "didNotFollowSuit" | "ledTrumpEarly" | "didNotPlayFaceDown"
  | "revealWhileAbleToFollow";
export interface EngineRejection {ok: false; code: EngineRejectionCode; details?: Record<string, unknown>;}
export type Decision = {ok: true; events: EngineEvent[]} | EngineRejection;
export type ActionResult = {ok: true; state: EngineState; events: EngineEvent[]} | EngineRejection;
export function newSession(config: EngineConfig, firstDealer: Seat): ActionResult;
export function decide(state: EngineState, action: EngineAction): Decision;
export function evolve(state: EngineState, event: EngineEvent): EngineState;
export function act(state: EngineState, action: EngineAction): ActionResult;
```

- [x] Define JSON-safe session, phase, match, auction, contract, hand, round, surrender,
  match-summary, and past-session types matching design §6. Match-summary contracts are nullable
  for pre-contract restarts/redeals and use a distinct summary-contract type whose hidden-trump
  variant contains no suit/card. Use discriminated unions for every phase and outcome; use arrays
  indexed by validated seat and explicit `{A, B}` token/point records.
- [x] Define the complete action, event, rejection, redeal-reason, disqualification, and outcome
  unions from design §§7–11. Rejection details may contain safe expected ranges/seats/kinds but
  never hidden cards or full state.
- [x] Implement `newSession` as config/first-dealer validation followed by the single
  `sessionStarted` event, producing equal starting token balances and `awaitingDeal(firstDeal)`.
- [x] Implement immutable `act = decide + ordered evolve`. Route by action/event discriminator
  through registered pure module functions; unsupported phase/action combinations return
  `actionNotAllowed`. Ensure input references are never mutated.
- [x] Add `assertEngineInvariants` for valid dealer/seat ranges, alternating teams, nonnegative
  tokens, phase/match consistency, unique card locations, and valid turn ownership. Extend it in
  later units as new state becomes reachable; failures identify invariant code without dumping
  private state.
- [x] Add and run focused automated tests for valid/invalid session creation, source/action
  mismatches, immutable inputs, JSON round-trip, initial event evolution, and deterministic
  duplicate calls.
- [x] Run typecheck, lint, build, and `git diff --check`; require success. Confirm exhaustive
  switches fail compilation when a temporary variant is unhandled, update plan/progress, and
  commit `feat(engine): add transition kernel`.

---

### [x] E003: Implement dealing and automatic redeals

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/deal.ts`
- Create: `packages/engine/src/redeal.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E001–E002.

**Interfaces produced:**

```ts
export function validateDeck(config: EngineConfig, deck: readonly Card[]): EngineRejection | null;
export function dealCards(deck: readonly Card[], dealer: Seat, playerCount: number): Card[][];
export type RedealReason =
  | {type: "teamWithoutJack"; team: Team}
  | {type: "lowHand"; seat: Seat; points: number};
export function redealReason(holdings: readonly (readonly Card[])[], threshold: number): RedealReason | null;
```

- [x] Validate exact multiset equality with `buildDeck(config)`: reject missing, duplicate,
  foreign, wrong-copy, or extra cards as `invalidDeck` without exposing deck contents in details.
- [x] Deal one card at a time starting at `dealer + 1`, wrapping counter-clockwise. For 56, deal
  the complete deck; for 28, put the first four cards per seat in hands and the remaining four per
  seat in ordered `undealt` storage.
- [x] After a 56 deal, check team-without-Jack first and then low hands in seat order for a stable
  redeal reason. Emit `dealt`, then `redealt(reason)` and `matchEnded(redealt)` when applicable;
  keep the same dealer, move no tokens, return to `awaitingDeal(redeal)`, and do not append the
  transient 56 redeal to `matchLog`.
- [x] When 56 does not redeal, create the match state and emit `auctionStarted(56, dealer + 1,
  28)`. For 28, emit the first-stage deal and `auctionStarted(28-first, dealer + 1, 14)` without a
  redeal check until the second four cards are dealt.
- [x] Extend card-location invariants to cover hands, `undealt`, current/finished rounds, and
  face-down storage with each configured card in exactly one place.
- [x] Add and run deterministic automated tests for every supported player/deck size, first/last
  card seat, invalid multisets, each redeal reason, reason precedence, same-dealer redeal, and 28
  first-deal deferral.
- [x] Run typecheck, lint, build, replay checks for every scenario, and `git diff --check`; require
  success. Update plan/progress and commit `feat(engine): deal cards and detect redeals`.

---

### [x] E004: Implement the shared auction and complete 56 contracts

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/auction.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E001–E003.

**Interfaces produced:**

```ts
export interface BidRange {minimum: number; maximum: number;}
export function bidRange(state: EngineState, seat: Seat): BidRange | null;
export function decideAuctionAction(state: EngineState, action: EngineAction): Decision;
export function contractMultiplier(auction: AuctionState): 1 | 2 | 4;
```

- [x] Implement turn advancement, call history, highest bid, consecutive passes, double state,
  carried-bid slot, and out-of-turn redouble in one shared auction model. A pass affects only its
  turn; partners and the same bidder may overbid.
- [x] Validate 56 bids at 28–56, strictly above the current amount, with required suit/no-trump
  and required style only for suit bids. Enforce the bidding team's loss-stake affordability.
- [x] Allow a turn-bound defender double at any amount, including 56, only with an unforced high
  bid and funds for twice its win stake. Allow any doubled-team member to redouble out of turn
  with funds for four times the loss stake. Any new bid cancels the double.
- [x] End a normal auction after N−1 passes following a bid, a doubled auction before the turn
  returns to the doubler, and a redouble immediately. After N opening passes create the exempt,
  undoubleable forced 28 no-trump contract for the first bidder.
- [x] Emit the exact ordered public auction events and fix the contract bidder/team, amount,
  trump, style, multiplier, and forced marker. Emit `playStarted(dealer + 1)` for completed 56
  auctions.
- [x] Add and run automated tests for 4/6/8-player turn cycles, pass-then-later-bid, partner/self
  overbids, minimum/maximum bids, affordability edges, double cancellation, doubled pass
  termination, out-of-turn redouble, forced bid, and every named rejection.
- [x] Run typecheck, lint, build, state/event replay checks, and `git diff --check`; require
  success. Update plan/progress and commit `feat(engine): implement auction rules`.

---

### [x] E005: Implement 28 auctions, face-down placement, and second deal

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/hidden-trump.ts`
- Modify: `packages/engine/src/auction.ts`
- Modify: `packages/engine/src/deal.ts`
- Modify: `packages/engine/src/redeal.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`

**Depends on:** E003–E004.

**Interfaces produced:**

```ts
export function decidePlaceCard(state: EngineState, action: EngineAction): Decision;
export function dealSecondStage(state: EngineState): EngineEvent[];
export function faceDownIsForced(state: EngineState, seat: Seat): boolean;
```

- [x] Run the first 28 auction at 14–28 with number-only bids and the shared pass/double/redouble
  rules. A non-forced winner enters `placingCard`; forced 14 no trump skips placement.
- [x] Accept `placeCard` only from the winner and only for a card in that seat's hand. Remove it,
  store owner/card with hidden trump, emit `cardPlaced`, then emit the automatic second-stage deal
  from `undealt` in the original order; no second system action exists.
- [x] After all eight cards per seat are present, run the same stable redeal check over complete
  holdings: include the face-down card in its owner's points and team-Jack membership. A redeal
  returns the face-down card, cancels both auction histories/contract state, logs the public
  first-auction facts with no token movement, and keeps the dealer.
- [x] Unless the first auction was redoubled or its bid was 28, begin `28-second` at dealer + 1 with minimum 21 or
  carried amount + 1. Give every seat a turn. Preserve a carried double, allow its redouble, and
  cancel it on any new bid.
- [x] Give all four seats one call in the initial second-auction circuit even when a double
  carried over; reaching the original doubler does not end that circuit. After N passes with no
  new second-auction bid, keep the bidder, amount, multiplier, and face-down card. A carried
  forced 14 becomes no trump. When there is a new winner—including a
  self-raise—emit `faceDownReturned`, restore the old card, and require the new winner to place
  any card before play.
- [x] If the first auction was redoubled or its bid was 28, skip the second auction after deal/redeal checking and
  start play immediately with the placed hidden trump. Start all completed 28 contracts with the
  dealer's right leading.
- [x] Add and run automated tests for forced 14, normal/redoubled first auctions, every
  second-auction minimum, all-pass carry, carried double/redouble, cancellation by raise,
  same-holder replacement, different winner, second-deal redeal, and illegal placement.
- [x] Run typecheck, lint, build, event replay/card-conservation checks, and `git diff --check`;
  require success. Update plan/progress and commit `feat(engine): implement 28 auction flow`.

---

### [ ] E006: Implement scoring, host resolutions, and session transitions

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/scoring.ts`
- Create: `packages/engine/src/host-actions.ts`
- Modify: `packages/engine/src/session.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E001–E005.

**Interfaces produced:**

```ts
export type ScoredOutcome =
  | {type: "made"} | {type: "failed"}
  | {type: "disqualified"; seat: Seat; kind: IllegalPlayKind}
  | {type: "surrendered"; team: Team}
  | {type: "awarded"; team: Team};
export function scoreMatch(state: EngineState, outcome: ScoredOutcome): EngineEvent[];
export function decideHostAction(state: EngineState, action: EngineAction): Decision;
export function decideSessionAction(state: EngineState, action: EngineAction): Decision;
```

- [ ] Calculate win/loss tier stake times multiplier and choose the payer exactly from design
  §10.3 for made, failed, disqualified, surrendered, and awarded outcomes. Transfer no more than
  the payer owns and record actual movement plus running balances.
- [ ] Build complete match summaries with dealer, nullable summary contract, points, token
  movement, balances, and the tagged outcome. Before emitting or storing a summary, replace an
  unrevealed 28 trump with `hidden` and retain neither its suit nor card. Append scored outcomes,
  every host restart, and 28 redeals to `matchLog`; do not append 56 automatic redeals. Emit
  `matchEnded` for every result so transient presentation remains possible.
- [ ] Accept host `endMatch(restart)` during auction, placement, play, or a vote; cancel match
  state/vote, move no tokens, log `restarted`, keep dealer, and enter `awaitingDeal(restart)`.
  Accept award only after play starts, including during a vote, and score the named winner.
- [ ] After a scored match, enter `sessionOver` and emit `sessionEnded` if either team is zero;
  otherwise enter `matchOver`. Implement system `startNextMatch` only from `matchOver`, rotate
  dealer counter-clockwise, emit `nextMatchStarted`, and await a new deal.
- [ ] Implement system `restartSession(firstDealer)` only from `sessionOver`: archive winner/final
  tokens in `pastSessions`, reset balances/log, validate the supplied dealer, emit
  `sessionRestarted`, and enter `awaitingDeal(firstDeal)`.
- [ ] Add and run automated tests for every scoring row and multiplier, capped payment, both
  session winners, next-dealer rotation, restart during each eligible phase, award availability,
  session archival, invalid system phase, and JSON replay.
- [ ] Run typecheck, lint, build, invariants, and `git diff --check`; require success. Update
  plan/progress and commit `feat(engine): score matches and sessions`.

---

### [ ] E007: Implement card play, hidden-trump reveal, and disqualification

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/play.ts`
- Modify: `packages/engine/src/hidden-trump.ts`
- Modify: `packages/engine/src/scoring.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E005–E006.

**Interfaces produced:**

```ts
export function legalCards(state: EngineState, seat: Seat): Card[];
export function roundWinner(round: CurrentRound, contract: Contract): Seat;
export function decidePlayAction(state: EngineState, action: EngineAction): Decision;
```

- [ ] Accept card/reveal actions only during play, on the seat's turn, and outside a surrender
  vote. Require cards to be in the acting hand except the precisely forced face-down case.
- [ ] Enforce following lead suit and the trump-lead restriction. Hidden trump is plain until
  reveal; no-trump permits every lead; holding only trump permits the early lead and marks trump
  played after that round.
- [ ] Implement `askReveal` only after a lead, while hidden, once on that turn, and while not in a
  forced bidder case. Emit `revealAsked` then `trumpRevealed`, return the card to the bidder's
  hand, and allow that asker any card for the current turn.
- [ ] Force the face-down card when trump is led and the bidder has no other trump in hand, or
  when it is the bidder's last card. Emit reveal before play. Reject every other direct
  face-down play in both modes.
- [ ] In Block mode reject each of the four disqualifying kinds. In Auto-stop accept the submitted
  play/reveal events, emit `disqualified`, stop before round completion, and invoke the correct
  immediate scoring path using already-collected points.
- [ ] Determine round winner by highest counting trump, otherwise highest lead suit; preserve
  first-play precedence for identical cards. Emit `roundWon`, add points, mark prior-round trump,
  clear reveal-turn flags, and lead from the winner. Score made/failed after the final round.
- [ ] Add and run automated tests for follow-suit, free discard, early trump exceptions, no
  trump, identical copies, reveal-before-earlier-plays counting as trump, forced face-down
  variants, each illegal mode/kind, winner-led next round, total points, and last-round scoring.
- [ ] Run typecheck, lint, build, card-conservation/points/event-replay checks, and
  `git diff --check`; require success. Update plan/progress and commit
  `feat(engine): implement card play and trump reveal`.

---

### [ ] E008: Implement result certainty and surrender voting

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/surrender.ts`
- Modify: `packages/engine/src/play.ts`
- Modify: `packages/engine/src/events.ts`
- Modify: `packages/engine/src/invariants.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E006–E007.

**Interfaces produced:**

```ts
export function losingTeamIfCertain(state: EngineState): Team | null;
export function decideSurrenderAction(state: EngineState, action: EngineAction): Decision;
```

- [ ] After every completed round, when surrender is on, set certainty once if the bidding team
  has made the bid or cannot reach it with uncollected points. Emit `resultDecided` once and keep
  it for the match; do not expose it to the winning team later in redaction.
- [ ] Allow any losing-team seat to propose outside turn when certainty exists, no vote runs, and
  no vote failed in the current round. Count the proposer as yes and pause card/reveal actions.
- [ ] Accept one yes/no vote from each other losing-team member. Pass strictly above half of team
  size (2/2, 2/3, 3/4), emit `surrendered`, and score the certain losing side. Fail immediately
  when remaining votes cannot reach that threshold, emit `surrenderFailed`, remember the round,
  and resume play.
- [ ] Reject winners, duplicate votes, proposals before certainty, repeated same-round proposals,
  and all surrender actions when the option is off. Preserve host restart/award during a vote.
- [ ] Add and run automated tests for certainty in both result directions and all team sizes, plus
  proposal/vote ordering, pass/fail thresholds, duplicate/opponent votes, same-round lockout,
  next-round reset, play pause, host resolution, scoring, and replay.
- [ ] Run typecheck, lint, build, invariants, and `git diff --check`; require success. Update
  plan/progress and commit `feat(engine): add surrender voting`.

---

### [ ] E009: Implement capabilities, views, and event redaction

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Create: `packages/engine/src/views.ts`
- Modify: `packages/engine/src/index.ts`

**Depends on:** E001–E008.

**Interfaces produced:**

```ts
export type Viewer = {type: "seat"; seat: Seat} | {type: "table"};
export interface ViewSettings {roundHistory: "none" | "last" | "full"; livePoints: boolean;}
export interface AllowedHostActions {restart: boolean; awardTeams: Team[];}
export type PublicMatchSummary = MatchSummary;
export type AllowedEngineAction =
  | {type: "bid"; range: BidRange; suits: readonly (Suit | "noTrump")[]; styles: readonly ("numberFirst" | "suitFirst")[]}
  | {type: "pass"} | {type: "double"} | {type: "redouble"}
  | {type: "placeCard"; cards: readonly Card[]}
  | {type: "askReveal"}
  | {type: "playCard"; cards: readonly Card[]}
  | {type: "proposeSurrender"}
  | {type: "voteSurrender"; votes: readonly ("yes" | "no")[]};
export interface EngineView {
  phase: PublicEnginePhase;
  seatCount: number;
  teams: readonly Team[];
  tokens: Readonly<Record<Team, number>>;
  dealer: Seat;
  turn: Seat | null;
  auction: PublicAuction | null;
  contract: PublicContract | null;
  faceDown:
    | {owner: Seat; visibility: "hidden"}
    | {owner: Seat; visibility: "visible"; card: Card}
    | null;
  cardCounts: readonly number[];
  currentRound: PublicRound | null;
  rounds: readonly PublicRound[];
  points: Readonly<Record<Team, number>> | null;
  surrender: PublicSurrender | null;
  matchLog: readonly PublicMatchSummary[];
  pastSessions: readonly PastSessionSummary[];
  viewer:
    | {type: "table"}
    | {type: "seat"; seat: Seat; hand: readonly Card[]; faceDownCard: Card | null; allowedActions: readonly AllowedEngineAction[]; resultDecided: Team | null};
}
export type RedactedEngineEvent =
  | PublicSessionEvent | RedactedDealEvent | PublicAuctionEvent | RedactedTrumpEvent
  | PublicPlayEvent | RedactedSurrenderEvent | PublicMatchEvent;
export function allowedActions(state: EngineState, seat: Seat): AllowedEngineAction[];
export function allowedHostActions(state: EngineState): AllowedHostActions;
export function view(state: EngineState, viewer: Viewer, settings: ViewSettings): EngineView;
export function redactEvent(
  event: EngineEvent,
  viewer: Viewer,
  settings: ViewSettings,
): RedactedEngineEvent | null;
```

- [ ] Represent allowed bids as explicit amount ranges plus valid suit/style choices and allowed
  placement/play actions as exact card lists. Include pass/double/redouble, reveal, surrender,
  and vote capabilities exactly when `decide` accepts them; in Auto-stop include disqualifying
  submissions as specified, never always-rejected face-down cards.
- [ ] Return host restart in auction/placement/play, and award targets only in play. Keep host
  authorization outside the engine; this function exposes phase capability only.
- [ ] Build public views with phase, seat/team metadata, token balances, dealer/turn, auction and
  contract, public trump/face-down marker, card counts, current round, vote, summaries, match log,
  and past sessions. Apply none/last/full round history and live-points settings.
- [ ] Add only the viewer seat's hand, face-down card, capabilities, and losing-team certainty.
  Table receives no hand, hidden trump, undealt cards, or allowed seat action. Hide 28 trump from
  every non-bidder until reveal. If the match ends first, omit it from every recipient's summary,
  including the bidder's, so later seat movement cannot expose historical private state.
- [ ] Redact deals to own cards plus other counts (counts only for Table), face-down placement/
  return to owner only, hidden contract trump to bidder only, round points when live points is
  off, and result certainty to losing seats only. Assert that canonical nested match summaries
  already contain no unrevealed 28 suit/card. Preserve order by allowing `null` redactions.
- [ ] Add and run automated tests using representative state in every phase: compare each listed
  capability with `decide`, inspect every seat/Table view and event variant for forbidden cards/
  trump, and confirm view/redaction never mutate full state.
- [ ] Run typecheck, lint, build, JSON checks, and `git diff --check`; require success. Update
  plan/progress and commit `feat(engine): expose safe views and actions`.

---

### [ ] E010: Verify the complete engine and hand off to rooms

**Suggested implementer:** Claude Opus or GPT `gpt-5.6-sol`, high effort

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/game-engine-implementation-plan.md`
- Modify: `docs/implementation-progress.md`

**Depends on:** E001–E009 complete.

**Interfaces produced:** No new runtime interface. This unit produces a verified public engine
surface and durable handoff to the rooms subsystem.

```text
Required deterministic matrix:
all valid/invalid configs and deck multisets; 56 at 4/6/8 seats with 48/64-card variants; 28
forced, normal, doubled and redoubled two-auction paths; every redeal reason; following suit;
trump lead/reveal/forced card; identical-card precedence; all Block/Auto-stop illegal kinds;
made/failed/capped/multiplied scoring; host restart/award; surrender pass/fail for all team sizes;
dealer rotation; session restart; every viewer/settings combination; full event replay.
```

- [ ] Run `nix develop -c pnpm typecheck`, `nix develop -c pnpm lint`, and
  `nix develop -c pnpm build`; require exit 0.
- [ ] Exercise every required matrix item with committed deterministic automated tests. For at
  least one complete 56 session and one complete 28 session, record actions/events, rebuild
  through `evolve`, and require JSON equality with each `act` state after every action.
- [ ] On every accepted action, require unchanged input JSON, passing invariants, card
  conservation, point totals, nonnegative tokens, deterministic duplicate results, and JSON
  round-trip. On every rejected action, require unchanged state and no events.
- [ ] Test all seat/Table views and redacted event streams from the full sessions. Search for
  another seat's card IDs, `undealt`, and unrevealed trump; require none outside the authorized
  owner/full-state test fixture.
- [ ] Inspect the dependency/import graph and emitted server bundle: require zero engine package
  dependencies and no Node/browser/protocol/server/storage/network/time/random/logger imports.
- [ ] Update `AGENTS.md` with the actual engine module/export layout, mark this plan and engine
  track complete, and update rooms to ready with R001 as next only after the skeleton is also
  complete.
- [ ] Run `git status --short` and `git diff --check`, review all final documentation changes,
  and commit `docs: complete game engine`. Stop and ask the user before starting rooms or UI
  implementation.
