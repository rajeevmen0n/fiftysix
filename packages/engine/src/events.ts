import type { SurrenderVoteChoice } from "./actions.js";
import type {
  AuctionStage,
  Contract,
  IllegalPlayKind,
  MatchSummary,
  RedealReason,
} from "./state.js";
import type {
  BidStyle,
  BidSuit,
  Card,
  Seat,
  Team,
  TokenBalances,
} from "./types.js";

/** `full`: the complete 56 deal. `first`/`second`: the two 28 deal stages. */
export type DealStage = "full" | "first" | "second";

// Session (design §11.1)
export type SessionStartedEvent = {
  type: "sessionStarted";
  firstDealer: Seat;
  tokens: TokenBalances;
};
export type SessionRestartedEvent = {
  type: "sessionRestarted";
  firstDealer: Seat;
};
export type SessionEndedEvent = { type: "sessionEnded"; winner: Team };
export type NextMatchStartedEvent = { type: "nextMatchStarted"; dealer: Seat };

export type SessionEvent =
  | SessionStartedEvent
  | SessionRestartedEvent
  | SessionEndedEvent
  | NextMatchStartedEvent;

// Deal
export type DealtEvent = {
  type: "dealt";
  stage: DealStage;
  /** Cards dealt to each seat in this stage, indexed by seat. */
  hands: readonly (readonly Card[])[];
  /** 28 first stage: the per-seat cards held back for the second deal. */
  undealt: readonly (readonly Card[])[] | null;
};
export type RedealtEvent = { type: "redealt"; reason: RedealReason };

export type DealEvent = DealtEvent | RedealtEvent;

// Auction
export type AuctionStartedEvent = {
  type: "auctionStarted";
  stage: AuctionStage;
  firstTurn: Seat;
  minBid: number;
};
export type BidMadeEvent = {
  type: "bidMade";
  seat: Seat;
  amount: number;
  suit: BidSuit | null;
  style: BidStyle | null;
};
export type PassedEvent = { type: "passed"; seat: Seat };
export type DoubledEvent = { type: "doubled"; seat: Seat };
export type DoubleCancelledEvent = { type: "doubleCancelled" };
export type RedoubledEvent = { type: "redoubled"; seat: Seat };
export type ForcedBidEvent = { type: "forcedBid"; seat: Seat; amount: number };
export type AuctionEndedEvent = { type: "auctionEnded"; contract: Contract };

export type AuctionEvent =
  | AuctionStartedEvent
  | BidMadeEvent
  | PassedEvent
  | DoubledEvent
  | DoubleCancelledEvent
  | RedoubledEvent
  | ForcedBidEvent
  | AuctionEndedEvent;

// 28 face-down card
/**
 * A 28 auction ended with a winner who must place a face-down card (design
 * §8.3–§8.4): moves the match from `auction` to `placingCard`. Public. The
 * contract's hidden trump — and so `auctionEnded(contract)` — is only known
 * once the card is placed.
 */
export type PlacingCardStartedEvent = {
  type: "placingCardStarted";
  seat: Seat;
};
export type CardPlacedEvent = { type: "cardPlaced"; seat: Seat; card: Card };
export type FaceDownReturnedEvent = {
  type: "faceDownReturned";
  seat: Seat;
  card: Card;
};
export type RevealAskedEvent = { type: "revealAsked"; seat: Seat };
export type TrumpRevealedEvent = { type: "trumpRevealed"; card: Card };

export type TrumpEvent =
  | PlacingCardStartedEvent
  | CardPlacedEvent
  | FaceDownReturnedEvent
  | RevealAskedEvent
  | TrumpRevealedEvent;

// Play
export type PlayStartedEvent = { type: "playStarted"; leader: Seat };
export type CardPlayedEvent = {
  type: "cardPlayed";
  seat: Seat;
  card: Card;
  fromFaceDown: boolean;
};
export type RoundWonEvent = {
  type: "roundWon";
  seat: Seat;
  team: Team;
  points: number;
};
export type DisqualifiedEvent = {
  type: "disqualified";
  seat: Seat;
  kind: IllegalPlayKind;
};

export type PlayEvent =
  | PlayStartedEvent
  | CardPlayedEvent
  | RoundWonEvent
  | DisqualifiedEvent;

// Surrender
export type ResultDecidedEvent = { type: "resultDecided"; losingTeam: Team };
export type SurrenderProposedEvent = { type: "surrenderProposed"; seat: Seat };
export type SurrenderVotedEvent = {
  type: "surrenderVoted";
  seat: Seat;
  vote: SurrenderVoteChoice;
};
export type SurrenderFailedEvent = { type: "surrenderFailed" };
export type SurrenderedEvent = { type: "surrendered"; team: Team };

export type SurrenderEvent =
  | ResultDecidedEvent
  | SurrenderProposedEvent
  | SurrenderVotedEvent
  | SurrenderFailedEvent
  | SurrenderedEvent;

// End of match
export type MatchEndedEvent = { type: "matchEnded"; summary: MatchSummary };

export type MatchEvent = MatchEndedEvent;

export type EngineEvent =
  | SessionEvent
  | DealEvent
  | AuctionEvent
  | TrumpEvent
  | PlayEvent
  | SurrenderEvent
  | MatchEvent;

export type EngineEventType = EngineEvent["type"];

export type EventOfType<T extends EngineEventType> = Extract<
  EngineEvent,
  { type: T }
>;
