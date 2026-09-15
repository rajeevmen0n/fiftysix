import type { EngineAction } from "./actions.js";
import {
  contractFromHighBid,
  contractMultiplier,
  evolveAuctionEnded,
} from "./auction.js";
import { cardsEqual } from "./cards.js";
import { dealSecondStage } from "./deal.js";
import type {
  AuctionEndedEvent,
  CardPlacedEvent,
  FaceDownReturnedEvent,
  PlacingCardStartedEvent,
  PlayStartedEvent,
} from "./events.js";
import { accept, type Decision, reject } from "./result.js";
import { nextSeat } from "./seats.js";
import type { EngineState, MatchState } from "./state.js";
import type { Card, Seat } from "./types.js";

// 28 face-down card (design §8.4, rules §10.2–§10.3): placing it after an
// auction, returning it when a new second-auction winner replaces it, and
// whether the bidder is forced to play it.

function cloneCard(card: Card): Card {
  return { suit: card.suit, rank: card.rank, copy: card.copy };
}

function isCardLike(value: unknown): value is Card {
  return value !== null && typeof value === "object";
}

/**
 * design §8.4: `placeCard(card)` from the auction winner in `placingCard`.
 * The card must be in the winner's hand; its suit becomes the hidden trump.
 *
 * After the first auction this emits `cardPlaced`, `auctionEnded` with the
 * hidden-trump contract, and the automatic second deal (`dealSecondStage`).
 * After the second auction it emits `cardPlaced`, `auctionEnded`, and
 * `playStarted` at the dealer's right.
 *
 * Like `decideAuctionAction`, this re-validates the action type and phase so
 * a direct caller gets `actionNotAllowed` rather than a throw, but it does
 * not repeat `decide()`'s source/seat-range checks.
 */
export function decidePlaceCard(
  state: EngineState,
  action: EngineAction,
): Decision {
  if (action.type !== "placeCard") {
    return reject("actionNotAllowed", { action: action.type });
  }
  const { phase } = state;
  if (
    phase.type !== "placingCard" ||
    phase.match.auction === null ||
    phase.match.auction.highBid === null
  ) {
    return reject("actionNotAllowed", {
      action: action.type,
      phase: phase.type,
    });
  }
  const { match } = phase;
  const auction = match.auction as NonNullable<MatchState["auction"]>;
  const highBid = auction.highBid as NonNullable<typeof auction.highBid>;

  const seat = action.source.seat;
  if (seat !== highBid.seat) {
    return reject("notYourTurn", { expected: highBid.seat, actual: seat });
  }

  const requested: unknown = action.card;
  const held = isCardLike(requested)
    ? (match.hands[seat] ?? []).find((card) => cardsEqual(card, requested))
    : undefined;
  if (held === undefined) {
    return reject("cardNotInHand", {});
  }

  if (auction.stage === "56") {
    return reject("actionNotAllowed", {
      action: action.type,
      stage: auction.stage,
    });
  }

  const card = cloneCard(held);
  const cardPlaced: CardPlacedEvent = { type: "cardPlaced", seat, card };
  const auctionEnded: AuctionEndedEvent = {
    type: "auctionEnded",
    contract: contractFromHighBid(highBid, contractMultiplier(auction), {
      type: "hidden",
      suit: card.suit,
    }),
  };

  if (auction.stage === "28-first") {
    const ended = evolveAuctionEnded(
      evolveCardPlaced(state, cardPlaced),
      auctionEnded,
    );
    return accept([cardPlaced, auctionEnded, ...dealSecondStage(ended)]);
  }
  const playStarted: PlayStartedEvent = {
    type: "playStarted",
    leader: nextSeat(state.dealer, state.config.playerCount),
  };
  return accept([cardPlaced, auctionEnded, playStarted]);
}

/**
 * design §9.3: whether `seat`, as the 28 bidder, must play its face-down card
 * on its current turn — trump is still hidden and either the hidden suit was
 * led and the hand holds none of it, or the face-down card is the seat's
 * last card.
 */
export function faceDownIsForced(state: EngineState, seat: Seat): boolean {
  const { phase } = state;
  if (phase.type !== "play") {
    return false;
  }
  const { faceDown, currentRound, revealedInRound, contract } = phase.match;
  if (
    faceDown === null ||
    faceDown.owner !== seat ||
    revealedInRound !== null ||
    contract?.trump.type !== "hidden" ||
    currentRound === null ||
    currentRound.turn !== seat
  ) {
    return false;
  }

  const hand = phase.match.hands[seat] ?? [];
  if (hand.length === 0) {
    return true;
  }
  const hiddenSuit = faceDown.card.suit;
  return (
    currentRound.leadSuit === hiddenSuit &&
    !hand.some((card) => card.suit === hiddenSuit)
  );
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of recovering from a misordered log).

function withMatch(
  state: EngineState,
  type: "auction" | "placingCard",
  match: MatchState,
): EngineState {
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type, match },
  };
}

/** Moves a finished 28 auction into `placingCard` for its winner. */
export function evolvePlacingCardStarted(
  state: EngineState,
  event: PlacingCardStartedEvent,
): EngineState {
  const { phase } = state;
  if (
    phase.type !== "auction" ||
    phase.match.auction?.highBid?.seat !== event.seat ||
    phase.match.faceDown !== null
  ) {
    throw new Error(
      "Cannot apply placingCardStarted event: expected a finished auction won by that seat",
    );
  }
  return withMatch(state, "placingCard", phase.match);
}

/** Moves the placed card from the winner's hand into face-down storage. */
export function evolveCardPlaced(
  state: EngineState,
  event: CardPlacedEvent,
): EngineState {
  const { phase } = state;
  if (phase.type !== "placingCard" || phase.match.faceDown !== null) {
    throw new Error(
      "Cannot apply cardPlaced event: expected card placement with no face-down card",
    );
  }
  const hand = phase.match.hands[event.seat];
  const index =
    hand === undefined
      ? -1
      : hand.findIndex((card) => cardsEqual(card, event.card));
  if (hand === undefined || index === -1) {
    throw new Error(
      "Cannot apply cardPlaced event: the card is not in that seat's hand",
    );
  }

  const hands = phase.match.hands.map((cards, seat) =>
    seat === event.seat
      ? cards.filter((_, cardIndex) => cardIndex !== index)
      : cards,
  );
  return withMatch(state, "placingCard", {
    ...phase.match,
    hands,
    faceDown: { owner: event.seat, card: cloneCard(event.card) },
  });
}

/** Returns the face-down card to the end of its owner's hand. */
export function evolveFaceDownReturned(
  state: EngineState,
  event: FaceDownReturnedEvent,
): EngineState {
  const { phase } = state;
  if (
    (phase.type !== "auction" && phase.type !== "placingCard") ||
    phase.match.faceDown === null ||
    phase.match.faceDown.owner !== event.seat ||
    !cardsEqual(phase.match.faceDown.card, event.card)
  ) {
    throw new Error(
      "Cannot apply faceDownReturned event: expected that seat's face-down card",
    );
  }

  const hands = phase.match.hands.map((cards, seat) =>
    seat === event.seat ? [...cards, cloneCard(event.card)] : cards,
  );
  return withMatch(state, phase.type, {
    ...phase.match,
    hands,
    faceDown: null,
  });
}
