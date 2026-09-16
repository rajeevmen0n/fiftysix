import type {
  BidStyle,
  BidSuit,
  Card,
  EngineConfig,
  Seat,
  StakeMultiplier,
  Suit,
  Team,
  TokenBalances,
} from "./types.js";

// All state is plain JSON-safe data: no classes, Maps, Sets, Dates, functions,
// bigint, or undefined fields. Absent values are `null`. Per-seat data is an
// array indexed by seat, and per-team data is an explicit `{A, B}` record.

export interface TeamPoints {
  A: number;
  B: number;
}

export type AwaitingDealReason =
  | "firstDeal"
  | "nextMatch"
  | "redeal"
  | "restart";

export type AuctionStage = "56" | "28-first" | "28-second";

export type IllegalPlayKind =
  | "didNotFollowSuit"
  | "ledTrumpEarly"
  | "didNotPlayFaceDown"
  | "revealWhileAbleToFollow";

export type RedealReason =
  | { type: "teamWithoutJack"; team: Team }
  | { type: "lowHand"; seat: Seat; points: number };

export interface Disqualification {
  seat: Seat;
  kind: IllegalPlayKind;
}

// ---------------------------------------------------------------------------
// Auction (design §6.3, §8)

export type AuctionCall =
  | {
      type: "bid";
      seat: Seat;
      amount: number;
      suit: BidSuit | null;
      style: BidStyle | null;
    }
  | { type: "pass"; seat: Seat }
  | { type: "double"; seat: Seat }
  | { type: "redouble"; seat: Seat };

export interface HighBid {
  seat: Seat;
  amount: number;
  /**
   * 56: a suit or no trump. 28: null (number-only bids), or no trump for
   * the forced 14.
   */
  suit: BidSuit | null;
  /** 56 suit bids only; otherwise null. */
  style: BidStyle | null;
  forced: boolean;
}

export interface CarriedBid {
  bid: HighBid;
  /** The first-auction doubler, if the carried bid was doubled. */
  doubledBy: Seat | null;
}

export interface AuctionState {
  stage: AuctionStage;
  calls: readonly AuctionCall[];
  turn: Seat;
  highBid: HighBid | null;
  doubledBy: Seat | null;
  redoubled: boolean;
  consecutivePasses: number;
  /** 28 second auction only. */
  carriedBid: CarriedBid | null;
}

// ---------------------------------------------------------------------------
// Contract

export type ContractTrump =
  | { type: "suit"; suit: Suit }
  | { type: "noTrump" }
  | { type: "hidden"; suit: Suit };

export interface Contract {
  bidder: Seat;
  team: Team;
  amount: number;
  trump: ContractTrump;
  style: BidStyle | null;
  multiplier: StakeMultiplier;
  forced: boolean;
}

/** Public trump state for summaries: an unrevealed 28 trump keeps no suit/card. */
export type SummaryTrump =
  | { type: "suit"; suit: Suit }
  | { type: "noTrump" }
  | { type: "hidden" };

export interface SummaryContract {
  bidder: Seat;
  team: Team;
  amount: number;
  trump: SummaryTrump;
  style: BidStyle | null;
  multiplier: StakeMultiplier;
  forced: boolean;
}

// ---------------------------------------------------------------------------
// Rounds

export interface FaceDownCard {
  owner: Seat;
  card: Card;
}

export interface RoundPlay {
  seat: Seat;
  card: Card;
  fromFaceDown: boolean;
}

export interface CurrentRound {
  leader: Seat;
  plays: readonly RoundPlay[];
  turn: Seat;
  leadSuit: Suit | null;
  revealedThisRound: boolean;
  revealAskedBy: Seat | null;
}

export interface CompletedRound {
  leader: Seat;
  plays: readonly RoundPlay[];
  winner: Seat;
  points: number;
}

// ---------------------------------------------------------------------------
// Surrender

export interface SurrenderVote {
  proposer: Seat;
  /** Seats voting yes, including the proposer. */
  yes: readonly Seat[];
  no: readonly Seat[];
}

export interface SurrenderState {
  /** The losing team once the result is certain. */
  decided: Team | null;
  vote: SurrenderVote | null;
  /** Zero-based index of the round in which the last vote failed. */
  lastFailedRound: number | null;
}

// ---------------------------------------------------------------------------
// Match (while a match is in progress)

export interface MatchState {
  /** Cards held by each seat, indexed by seat. */
  hands: readonly (readonly Card[])[];
  /** 28: second-stage cards per seat until the second deal; otherwise null. */
  undealt: readonly (readonly Card[])[] | null;
  auction: AuctionState | null;
  contract: Contract | null;
  faceDown: FaceDownCard | null;
  /** Zero-based round index in which trump was revealed. */
  revealedInRound: number | null;
  /** Finished rounds; a round's number is its zero-based index here. */
  rounds: readonly CompletedRound[];
  currentRound: CurrentRound | null;
  trumpPlayed: boolean;
  points: TeamPoints;
  surrender: SurrenderState;
}

// ---------------------------------------------------------------------------
// Outcomes and summaries (design §10.3)

export type ScoredOutcome =
  | { type: "made" }
  | { type: "failed" }
  | { type: "disqualified"; seat: Seat; kind: IllegalPlayKind }
  /** `team` is the team that SURRENDERED, i.e. the loser of the match. */
  | { type: "surrendered"; team: Team }
  /** `team` is the team the host AWARDED the match to, i.e. the winner. */
  | { type: "awarded"; team: Team };

export type MatchOutcome =
  | ScoredOutcome
  | { type: "restarted" }
  | { type: "redealt"; reason: RedealReason };

export interface TokenMovement {
  payer: Team;
  amount: number;
}

export interface MatchSummary {
  dealer: Seat;
  contract: SummaryContract | null;
  points: TeamPoints;
  /** Null when no tokens move (restart, redeal). */
  tokensMoved: TokenMovement | null;
  /** Running balances after this result. */
  tokens: TokenBalances;
  outcome: MatchOutcome;
}

export interface PastSessionSummary {
  winner: Team;
  tokens: TokenBalances;
}

// ---------------------------------------------------------------------------
// Session and phases (design §6.1, §6.2)

export type EnginePhase =
  | { type: "awaitingDeal"; reason: AwaitingDealReason }
  | { type: "auction"; match: MatchState }
  | { type: "placingCard"; match: MatchState }
  | { type: "play"; match: MatchState }
  | { type: "matchOver"; summary: MatchSummary }
  | { type: "sessionOver"; winner: Team; summary: MatchSummary };

export type EnginePhaseType = EnginePhase["type"];

export type PhaseOfType<T extends EnginePhaseType> = Extract<
  EnginePhase,
  { type: T }
>;

export interface EngineState {
  config: EngineConfig;
  tokens: TokenBalances;
  dealer: Seat;
  matchLog: readonly MatchSummary[];
  pastSessions: readonly PastSessionSummary[];
  phase: EnginePhase;
}
