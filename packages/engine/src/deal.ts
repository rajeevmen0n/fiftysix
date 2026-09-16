import type { ActionOfType } from "./actions.js";
import { buildDeck } from "./cards.js";
import { AUCTION_BID_LIMITS } from "./config.js";
import type {
  AuctionStartedEvent,
  DealtEvent,
  EngineEvent,
  MatchEndedEvent,
  PlayStartedEvent,
  RedealtEvent,
} from "./events.js";
import { completeHoldings, redealReason } from "./redeal.js";
import {
  accept,
  type Decision,
  type EngineRejection,
  reject,
} from "./result.js";
import { matchSummary } from "./scoring.js";
import { assertSeat, nextSeat } from "./seats.js";
import type {
  AuctionState,
  EngineState,
  HighBid,
  MatchState,
} from "./state.js";
import type { Card, EngineConfig, Seat } from "./types.js";

function cloneCard(card: Card): Card {
  return { suit: card.suit, rank: card.rank, copy: card.copy };
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

function isPlainCard(value: unknown): value is Card {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const card = value as Partial<Card>;
  return (
    typeof card.suit === "string" &&
    typeof card.rank === "string" &&
    (card.copy === 1 || card.copy === 2)
  );
}

/**
 * Design §7: rejects a deck that is not an exact multiset match of
 * `buildDeck(config)` — missing, duplicate, foreign, wrong-copy, or extra
 * cards all reject as `invalidDeck`. Details carry only safe counts/flags,
 * never deck contents.
 */
export function validateDeck(
  config: EngineConfig,
  deck: readonly Card[],
): EngineRejection | null {
  if (!Array.isArray(deck)) {
    return reject("invalidDeck", { reason: "notAnArray" });
  }

  const expected = buildDeck(config);
  if (deck.length !== expected.length) {
    return reject("invalidDeck", {
      expectedCount: expected.length,
      actualCount: deck.length,
    });
  }

  const expectedCounts = new Map<string, number>();
  for (const card of expected) {
    const key = cardKey(card);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }

  const actualCounts = new Map<string, number>();
  for (const card of deck) {
    if (!isPlainCard(card)) {
      return reject("invalidDeck", { reason: "malformedCard" });
    }
    const key = cardKey(card);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }

  if (actualCounts.size !== expectedCounts.size) {
    return reject("invalidDeck", { reason: "deckMismatch" });
  }
  for (const [key, count] of expectedCounts) {
    if (actualCounts.get(key) !== count) {
      return reject("invalidDeck", { reason: "deckMismatch" });
    }
  }

  return null;
}

/**
 * Design §7: deals one card at a time counter-clockwise starting at the
 * dealer's right — card `k` goes to seat `(dealer + 1 + k) mod N`. The
 * caller passes whichever slice of the deck belongs to this deal (the whole
 * deck for 56, or one 4-per-seat portion for a 28 deal stage).
 */
export function dealCards(
  deck: readonly Card[],
  dealer: Seat,
  playerCount: number,
): Card[][] {
  assertSeat(dealer, playerCount);
  const hands: Card[][] = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, index) => {
    const seat = (dealer + 1 + index) % playerCount;
    hands[seat]?.push(cloneCard(card));
  });
  return hands;
}

/**
 * Design §7: the system `deal(deck)` action, valid only from `awaitingDeal`.
 * 56 deals the complete deck and runs the redeal check immediately; 28 deals
 * only the first four cards per seat and starts its first auction without a
 * redeal check (rules §9: 28 checks only after the automatic second deal, see
 * `dealSecondStage`).
 */
export function decideDeal(
  state: EngineState,
  action: ActionOfType<"deal">,
): Decision {
  const { config } = state;
  const deckRejection = validateDeck(config, action.deck);
  if (deckRejection !== null) {
    return deckRejection;
  }

  const firstTurn = nextSeat(state.dealer, config.playerCount);

  if (config.gameType === "56") {
    const hands = dealCards(action.deck, state.dealer, config.playerCount);
    const dealtEvent: DealtEvent = {
      type: "dealt",
      stage: "full",
      hands,
      undealt: null,
    };

    const reason = redealReason(hands, config.redealThreshold);
    if (reason !== null) {
      const redealtEvent: RedealtEvent = { type: "redealt", reason };
      const matchEndedEvent: MatchEndedEvent = {
        type: "matchEnded",
        summary: matchSummary(
          state,
          { type: "redealt", reason },
          null,
          state.tokens,
        ),
      };
      return accept([dealtEvent, redealtEvent, matchEndedEvent]);
    }

    const auctionStartedEvent: AuctionStartedEvent = {
      type: "auctionStarted",
      stage: "56",
      firstTurn,
      minBid: AUCTION_BID_LIMITS["56"].minimum,
    };
    return accept([dealtEvent, auctionStartedEvent]);
  }

  // 28: first deal only (rules §10.2 step 1). Four cards per seat go to
  // hands, the remaining four per seat go to `undealt`, dealt in the same
  // counter-clockwise order (design §7).
  const perSeatFirst = 4;
  const firstCount = perSeatFirst * config.playerCount;
  const firstPortion = action.deck.slice(0, firstCount);
  const secondPortion = action.deck.slice(firstCount);

  const hands = dealCards(firstPortion, state.dealer, config.playerCount);
  const undealt = dealCards(secondPortion, state.dealer, config.playerCount);
  const dealtEvent: DealtEvent = {
    type: "dealt",
    stage: "first",
    hands,
    undealt,
  };
  const auctionStartedEvent: AuctionStartedEvent = {
    type: "auctionStarted",
    stage: "28-first",
    firstTurn,
    minBid: AUCTION_BID_LIMITS["28-first"].minimum,
  };
  return accept([dealtEvent, auctionStartedEvent]);
}

/**
 * Design §8.4 steps 2–4 (rules §9, §10.2): the automatic 28 second deal that
 * follows the end of the first auction — no system action is involved.
 *
 * `state` must already reflect the end of the first auction: `contract` is
 * set, the winner's face-down card (if any) is placed, and the second-stage
 * cards are still in `undealt`. Callers (the forced-bid pass and
 * `placeCard`) build that state by applying their own earlier events with
 * the matching evolvers, so the redeal check sees exactly what `evolve` will.
 *
 * Emits `dealt(second)` with each seat's `undealt` cards in their original
 * order, then runs the redeal check over complete eight-card holdings
 * (including the face-down card). On a redeal: `redealt`, `faceDownReturned`
 * for a placed card, and `matchEnded(redealt)` with the public first-auction
 * contract and no token movement. Otherwise a first auction that was
 * redoubled or reached the maximum bid of 28 starts play at the dealer's
 * right with the first-auction contract; any other first auction starts the
 * second auction there with minimum 21 or the carried amount + 1.
 */
export function dealSecondStage(state: EngineState): EngineEvent[] {
  const { phase } = state;
  if (
    (phase.type !== "auction" && phase.type !== "placingCard") ||
    phase.match.undealt === null ||
    phase.match.auction?.stage !== "28-first" ||
    phase.match.contract === null
  ) {
    throw new Error(
      "dealSecondStage: expected a finished 28 first auction with undealt cards",
    );
  }
  const { match } = phase;
  const auction = match.auction as AuctionState;
  const contract = match.contract as NonNullable<MatchState["contract"]>;
  const undealt = match.undealt as NonNullable<MatchState["undealt"]>;

  const dealtEvent: DealtEvent = {
    type: "dealt",
    stage: "second",
    hands: undealt.map((cards) => cards.map(cloneCard)),
    undealt: null,
  };

  const fullHands = match.hands.map((hand, seat) => [
    ...hand,
    ...(undealt[seat] ?? []),
  ]);
  const reason = redealReason(
    completeHoldings(fullHands, match.faceDown),
    state.config.redealThreshold,
  );
  const firstTurn = nextSeat(state.dealer, state.config.playerCount);

  if (reason !== null) {
    const events: EngineEvent[] = [dealtEvent, { type: "redealt", reason }];
    if (match.faceDown !== null) {
      events.push({
        type: "faceDownReturned",
        seat: match.faceDown.owner,
        card: cloneCard(match.faceDown.card),
      });
    }
    const matchEndedEvent: MatchEndedEvent = {
      type: "matchEnded",
      summary: matchSummary(
        state,
        { type: "redealt", reason },
        null,
        state.tokens,
      ),
    };
    events.push(matchEndedEvent);
    return events;
  }

  if (
    auction.redoubled ||
    contract.amount >= AUCTION_BID_LIMITS["28-second"].maximum
  ) {
    // rules §10.2: a redoubled first auction, or one whose bid is already
    // 28 and can't be overbid, has no second auction.
    const playStarted: PlayStartedEvent = {
      type: "playStarted",
      leader: firstTurn,
    };
    return [dealtEvent, playStarted];
  }

  const auctionStartedEvent: AuctionStartedEvent = {
    type: "auctionStarted",
    stage: "28-second",
    firstTurn,
    minBid: Math.max(
      AUCTION_BID_LIMITS["28-second"].minimum,
      contract.amount + 1,
    ),
  };
  return [dealtEvent, auctionStartedEvent];
}

function emptyMatchState(event: DealtEvent): MatchState {
  return {
    hands: event.hands.map((hand) => hand.map(cloneCard)),
    undealt:
      event.undealt === null
        ? null
        : event.undealt.map((hand) => hand.map(cloneCard)),
    auction: null,
    contract: null,
    faceDown: null,
    revealedInRound: null,
    rounds: [],
    currentRound: null,
    trumpPlayed: false,
    points: { A: 0, B: 0 },
    surrender: { decided: null, vote: null, lastFailedRound: null },
  };
}

/**
 * A freshly dealt match has no auction yet: this evolver parks the new
 * `MatchState` under phase `auction` with `auction: null`, a shape that only
 * ever exists mid-action. The `deal` action always follows `dealt` with
 * either `auctionStarted` (which fills in `auction`) or `redealt` +
 * `matchEnded` (which discards this phase entirely), so the gap is never
 * observed between actions.
 *
 * IMPORTANT: this intermediate `{type: "auction", match, auction: null}`
 * shape technically violates `checkMatch`'s `phaseMatchMismatch` invariant
 * (phase `"auction"` requires `match.auction !== null`) if inspected in
 * isolation. That's expected here: `assertEngineInvariants` (see its doc
 * comment in `invariants.ts`) is only guaranteed to hold once every event of
 * a complete accepted `act()` call has been applied, never after only some
 * of that action's events — such as this transient state right after
 * `dealt` but before the paired `auctionStarted`/`redealt` event from the
 * same call. Do not call `assertEngineInvariants` (or build a replay tool
 * that does) after each individual event; only after a full action's
 * events.
 *
 * `stage: "second"` (28's second deal, design §8.4) instead merges into the
 * live match: each seat's second-stage cards are appended to its hand in
 * their original order and `undealt` is cleared. Auction, contract, and
 * face-down state from the first auction are kept, as is the phase.
 */
export function evolveDealt(
  state: EngineState,
  event: DealtEvent,
): EngineState {
  if (event.stage === "second") {
    return evolveSecondDeal(state, event);
  }

  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "auction", match: emptyMatchState(event) },
  };
}

function evolveSecondDeal(state: EngineState, event: DealtEvent): EngineState {
  const { phase } = state;
  if (
    (phase.type !== "auction" && phase.type !== "placingCard") ||
    phase.match.undealt === null ||
    event.hands.length !== phase.match.hands.length
  ) {
    throw new Error(
      "Cannot apply dealt(second) event: expected a 28 match with undealt cards",
    );
  }

  const hands = phase.match.hands.map((hand, seat) => [
    ...hand.map(cloneCard),
    ...(event.hands[seat] ?? []).map(cloneCard),
  ]);
  const match: MatchState = { ...phase.match, hands, undealt: null };
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: phase.type, match },
  };
}

function cloneHighBid(bid: HighBid): HighBid {
  return {
    seat: bid.seat,
    amount: bid.amount,
    suit: bid.suit,
    style: bid.style,
    forced: bid.forced,
  };
}

/**
 * Design §13.1: "evolve throws instead of trying to recover." An
 * `auctionStarted` event only ever follows `dealt` within the same action
 * (design §7, §8.4), so a mismatched phase here means the event log is
 * corrupted or misordered — an engine bug, not something to silently paper
 * over by returning `state` unchanged.
 *
 * A `28-second` auction (design §8.4) starts from the finished first
 * auction, in phase `auction` (forced 14) or `placingCard` (after the
 * face-down card was placed). Its carried bid and double status stand as
 * the second auction's `highBid`/`doubledBy` until a new call changes them,
 * and are also kept unchanged in `carriedBid`. The first auction's call
 * history is replaced by the new auction's. The first-auction contract
 * stays in `match.contract` as the standing contract; only the second
 * auction's `auctionEnded` replaces it (design §6.3).
 */
export function evolveAuctionStarted(
  state: EngineState,
  event: AuctionStartedEvent,
): EngineState {
  const { phase } = state;

  if (event.stage === "28-second") {
    const previous =
      phase.type === "auction" || phase.type === "placingCard"
        ? phase.match.auction
        : null;
    if (
      previous === null ||
      previous.stage !== "28-first" ||
      previous.highBid === null ||
      previous.redoubled ||
      previous.highBid.amount >= AUCTION_BID_LIMITS["28-second"].maximum
    ) {
      throw new Error(
        "Cannot apply auctionStarted(28-second) event: expected a finished 28 first auction that allows a second auction",
      );
    }
    const match = (phase as { match: MatchState }).match;
    const auction: AuctionState = {
      stage: event.stage,
      calls: [],
      turn: event.firstTurn,
      highBid: cloneHighBid(previous.highBid),
      doubledBy: previous.doubledBy,
      redoubled: false,
      consecutivePasses: 0,
      carriedBid: {
        bid: cloneHighBid(previous.highBid),
        doubledBy: previous.doubledBy,
      },
    };
    return {
      config: state.config,
      tokens: state.tokens,
      dealer: state.dealer,
      matchLog: state.matchLog,
      pastSessions: state.pastSessions,
      phase: { type: "auction", match: { ...match, auction } },
    };
  }

  if (phase.type !== "auction") {
    throw new Error(
      `Cannot apply auctionStarted event: expected phase "auction", got "${phase.type}"`,
    );
  }

  const auction: AuctionState = {
    stage: event.stage,
    calls: [],
    turn: event.firstTurn,
    highBid: null,
    doubledBy: null,
    redoubled: false,
    consecutivePasses: 0,
    carriedBid: null,
  };

  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "auction", match: { ...phase.match, auction } },
  };
}
