import type { ActionOfType } from "./actions.js";
import { buildDeck } from "./cards.js";
import type {
  AuctionStartedEvent,
  DealtEvent,
  MatchEndedEvent,
  RedealtEvent,
} from "./events.js";
import { redealReason } from "./redeal.js";
import {
  accept,
  type Decision,
  type EngineRejection,
  reject,
} from "./result.js";
import { assertSeat, nextSeat } from "./seats.js";
import type {
  AuctionState,
  EngineState,
  MatchState,
  MatchSummary,
  RedealReason,
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

function redealSummary(state: EngineState, reason: RedealReason): MatchSummary {
  return {
    dealer: state.dealer,
    contract: null,
    points: { A: 0, B: 0 },
    tokensMoved: null,
    tokens: { A: state.tokens.A, B: state.tokens.B },
    outcome: { type: "redealt", reason },
  };
}

/**
 * Design §7: the system `deal(deck)` action, valid only from `awaitingDeal`.
 * 56 deals the complete deck and runs the redeal check immediately; 28 deals
 * only the first four cards per seat and starts its first auction without a
 * redeal check (rules §9: 28 checks only after the second deal, which is out
 * of scope until the auction that triggers it exists).
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
        summary: redealSummary(state, reason),
      };
      return accept([dealtEvent, redealtEvent, matchEndedEvent]);
    }

    const auctionStartedEvent: AuctionStartedEvent = {
      type: "auctionStarted",
      stage: "56",
      firstTurn,
      minBid: 28,
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
    minBid: 14,
  };
  return accept([dealtEvent, auctionStartedEvent]);
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
 * `stage: "second"` (28's second deal, design §8.4) is not handled: by that
 * point there is live match state (`auction`, `contract`, `faceDown`) from
 * the first auction that must be merged, not discarded by rebuilding a
 * fresh `MatchState`. That merge belongs to the later unit that implements
 * the second deal/auction, so it throws for now rather than silently
 * wiping live state.
 */
export function evolveDealt(
  state: EngineState,
  event: DealtEvent,
): EngineState {
  if (event.stage === "second") {
    throw new Error(
      "evolveDealt: dealt(stage: second) is not yet implemented — " +
        "28's second deal must merge into existing match state, not rebuild it",
    );
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

/**
 * Design §13.1: "evolve throws instead of trying to recover." An
 * `auctionStarted` event only ever follows `dealt` within the same `deal`
 * action (design §7), so a mismatched phase here means the event log is
 * corrupted or misordered — an engine bug, not something to silently paper
 * over by returning `state` unchanged.
 */
export function evolveAuctionStarted(
  state: EngineState,
  event: AuctionStartedEvent,
): EngineState {
  const { phase } = state;
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
