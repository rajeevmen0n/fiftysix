import { type BidRange, bidRange } from "./auction.js";
import { SUITS } from "./cards.js";
import type {
  AuctionEndedEvent,
  AuctionEvent,
  CardPlacedEvent,
  DealStage,
  EngineEvent,
  FaceDownReturnedEvent,
  MatchEvent,
  PlacingCardStartedEvent,
  PlayEvent,
  RedealtEvent,
  RevealAskedEvent,
  RoundWonEvent,
  SessionEvent,
  SurrenderEvent,
  TrumpRevealedEvent,
} from "./events.js";
import { cloneCard, faceDownIsForced, revealBlocker } from "./hidden-trump.js";
import { legalCards } from "./play.js";
import { assertNever } from "./result.js";
import { assertSeat, teamOf } from "./seats.js";
import { canAffordDouble, canAffordRedouble } from "./stakes.js";
import type {
  AuctionCall,
  AuctionStage,
  AwaitingDealReason,
  CarriedBid,
  CompletedRound,
  Contract,
  CurrentRound,
  EngineState,
  HighBid,
  MatchState,
  MatchSummary,
  PastSessionSummary,
  RoundPlay,
  SummaryTrump,
} from "./state.js";
import type {
  BidStyle,
  BidSuit,
  Card,
  Seat,
  StakeMultiplier,
  Suit,
  Team,
  TokenBalances,
} from "./types.js";

// Recipient-safe projections (design §11.2–§11.3, §12; design.md §6–§7, §13).
//
// The full `EngineState` never leaves the server. Everything a seat or the
// Table view receives goes through `view` (a snapshot) or `redactEvent` (one
// event of an action's ordered batch). Both are pure, never mutate their
// inputs, and return fresh JSON-safe data that shares no object with the
// state or the event.
//
// What stays private:
// - every seat's hand, the 28 `undealt` cards, and the deck: only the
//   viewing seat's own hand is projected, and the Table view gets none;
// - the 28 face-down card: shown only to its owner until it is revealed;
// - an unrevealed 28 trump suit: shown only to the bidder, and never in a
//   match summary, for any recipient (rules §10.3). The one accepted
//   exception is the public `didNotPlayFaceDown` disqualification, which
//   implies that the led suit was trump without naming the card;
// - result certainty (`resultDecided`): shown only to the losing team's
//   seats (design §5, §10.1).
//
// `allowedActions` lists exactly the seat actions `decide` accepts right now
// (in Auto-stop that includes the disqualifying submissions, design §12).
// `allowedHostActions` reports the phase capability of End match only; host
// authorization stays with the service.

// ---------------------------------------------------------------------------
// Viewers and settings

/** A seat's player, or the public Table view (design §13). */
export type Viewer = { type: "seat"; seat: Seat } | { type: "table" };

/** Room display settings (design §2, §7). They never affect game logic. */
export interface ViewSettings {
  roundHistory: "none" | "last" | "full";
  livePoints: boolean;
}

// ---------------------------------------------------------------------------
// Capabilities (design §12)

/** design §12, §10.2: End match availability for the current phase. */
export interface AllowedHostActions {
  /** `endMatch(restart)`: in `auction`, `placingCard`, and `play`. */
  restart: boolean;
  /** `endMatch(award, team)` targets: both teams in `play`, otherwise none. */
  awardTeams: Team[];
}

/**
 * One seat action the UI may offer (design §12). Each lists the exact
 * choices `decide` accepts:
 *
 * - `bid`: every whole `amount` in `range` (inclusive). In 56, `suits` holds
 *   the four suits and `noTrump`, and `styles` the two bid styles, which
 *   apply to suit bids only (a no-trump bid carries no style). In 28 both
 *   lists are empty: the bid is a number only, with no `suit` or `style`.
 * - `placeCard` / `playCard`: exactly these cards.
 * - `voteSurrender`: either vote.
 */
export type AllowedEngineAction =
  | {
      type: "bid";
      range: BidRange;
      suits: readonly BidSuit[];
      styles: readonly BidStyle[];
    }
  | { type: "pass" }
  | { type: "double" }
  | { type: "redouble" }
  | { type: "placeCard"; cards: readonly Card[] }
  | { type: "askReveal" }
  | { type: "playCard"; cards: readonly Card[] }
  | { type: "proposeSurrender" }
  | { type: "voteSurrender"; votes: readonly ("yes" | "no")[] };

// ---------------------------------------------------------------------------
// Public shapes

/**
 * A canonical match summary. Summaries are already recipient-safe: their
 * contract keeps an unrevealed 28 trump only as `{type: "hidden"}` with no
 * suit or card (design §10.3), for every recipient including the bidder.
 * Projections still rebuild them field by field (`publicMatchSummary`).
 */
export type PublicMatchSummary = MatchSummary;

/** The phase without any private match data. */
export type PublicEnginePhase =
  | { type: "awaitingDeal"; reason: AwaitingDealReason }
  | { type: "auction" }
  /** `seat`: the 28 auction winner who must place the face-down card. */
  | { type: "placingCard"; seat: Seat }
  | { type: "play" }
  | { type: "matchOver"; summary: PublicMatchSummary }
  | { type: "sessionOver"; winner: Team; summary: PublicMatchSummary };

/** design.md §6: everyone sees the full auction as it happens. */
export interface PublicAuction {
  stage: AuctionStage;
  calls: readonly AuctionCall[];
  /** The seat to call; null once the auction is over (placement, play). */
  turn: Seat | null;
  highBid: HighBid | null;
  doubledBy: Seat | null;
  redoubled: boolean;
  /** 28 second auction only: the first-auction bid and its double status. */
  carriedBid: CarriedBid | null;
}

/**
 * The contract's trump as one recipient may see it. A 56 trump, a no-trump
 * contract, and a revealed 28 trump (`suit`) are public. An unrevealed 28
 * trump is `hidden`; its `suit` is set only for the bidder and is null for
 * every other seat and the Table view.
 */
export type PublicContractTrump =
  | { type: "suit"; suit: Suit }
  | { type: "noTrump" }
  | { type: "hidden"; suit: Suit | null };

/** The standing contract (design §6.3) as one recipient may see it. */
export interface PublicContract {
  bidder: Seat;
  team: Team;
  amount: number;
  trump: PublicContractTrump;
  style: BidStyle | null;
  multiplier: StakeMultiplier;
  forced: boolean;
}

/**
 * A round of the current match. Every card in it was played face up, so it
 * is public.
 */
export interface PublicRound {
  /** Zero-based round number within the match. */
  index: number;
  leader: Seat;
  plays: readonly RoundPlay[];
  leadSuit: Suit | null;
  /** Whether the 28 trump was revealed during this round. */
  revealedInRound: boolean;
  /** Current round only: the seat that asked for the reveal on its turn. */
  revealAskedBy: Seat | null;
  /** Finished rounds only; null for the current round. */
  winner: Seat | null;
  /** Finished rounds with live points on; otherwise null. */
  points: number | null;
}

/** design.md §5: a running vote is public. Votes so far, proposer included. */
export interface PublicSurrender {
  proposer: Seat;
  yes: readonly Seat[];
  no: readonly Seat[];
}

/**
 * The 28 face-down card marker. Its owner sees it face up (`visible`);
 * everyone else only sees that the owner has one (`hidden`), which is all
 * the public view lists about it (design §11.3). Null when no card is face
 * down, including after the reveal: the card is shown to everyone and goes
 * back to the bidder's hand (rules §10.3), where it is an ordinary card
 * (design §9.3). Everyone sees it through the public `trumpRevealed` event
 * (design §11.2), and the trump suit becomes public in `contract`.
 */
export type PublicFaceDown =
  | { owner: Seat; visibility: "hidden" }
  | { owner: Seat; visibility: "visible"; card: Card }
  | null;

export type ViewerView =
  | { type: "table" }
  | {
      type: "seat";
      seat: Seat;
      hand: readonly Card[];
      /** The seat's own face-down card, kept apart from the hand. */
      faceDownCard: Card | null;
      allowedActions: readonly AllowedEngineAction[];
      /** The seat's own team once its loss is certain (losing team only). */
      resultDecided: Team | null;
    };

/** design §11.3: what one seat or the Table view may see right now. */
export interface EngineView {
  phase: PublicEnginePhase;
  seatCount: number;
  /** Team of each seat, indexed by seat. */
  teams: readonly Team[];
  tokens: Readonly<Record<Team, number>>;
  dealer: Seat;
  /** The seat expected to act next: call, place, or play. */
  turn: Seat | null;
  auction: PublicAuction | null;
  contract: PublicContract | null;
  faceDown: PublicFaceDown;
  /** Cards in each seat's hand, indexed by seat (the face-down card excluded). */
  cardCounts: readonly number[];
  currentRound: PublicRound | null;
  /** Finished rounds of the current match, per the round-history setting. */
  rounds: readonly PublicRound[];
  /** Team points in the current match, with live points on; otherwise null. */
  points: Readonly<Record<Team, number>> | null;
  surrender: PublicSurrender | null;
  matchLog: readonly PublicMatchSummary[];
  pastSessions: readonly PastSessionSummary[];
  viewer: ViewerView;
}

// ---------------------------------------------------------------------------
// Redacted events (design §11.2)

export type PublicSessionEvent = SessionEvent;

/**
 * `dealt` for one recipient: the viewing seat's own cards from this deal
 * stage (null for the Table view) and how many cards each seat received.
 * Other seats' cards and the 28 `undealt` cards are never included.
 */
export interface RedactedDealtEvent {
  type: "dealt";
  stage: DealStage;
  hand: readonly Card[] | null;
  cardCounts: readonly number[];
}
export type RedactedDealEvent = RedactedDealtEvent | RedealtEvent;

/** `auctionEnded` with the contract as this recipient may see it. */
export interface PublicAuctionEndedEvent {
  type: "auctionEnded";
  contract: PublicContract;
}
export type PublicAuctionEvent =
  | Exclude<AuctionEvent, AuctionEndedEvent>
  | PublicAuctionEndedEvent;

/** The placed card is shown only to its owner; null for everyone else. */
export interface RedactedCardPlacedEvent {
  type: "cardPlaced";
  seat: Seat;
  card: Card | null;
}
/** The returned card is shown only to its owner; null for everyone else. */
export interface RedactedFaceDownReturnedEvent {
  type: "faceDownReturned";
  seat: Seat;
  card: Card | null;
}
export type RedactedTrumpEvent =
  | PlacingCardStartedEvent
  | RedactedCardPlacedEvent
  | RedactedFaceDownReturnedEvent
  | RevealAskedEvent
  | TrumpRevealedEvent;

/** `roundWon` with `points` null when live points are off. */
export interface PublicRoundWonEvent {
  type: "roundWon";
  seat: Seat;
  team: Team;
  points: number | null;
}
export type PublicPlayEvent =
  | Exclude<PlayEvent, RoundWonEvent>
  | PublicRoundWonEvent;

/** `resultDecided` reaches only the losing team's seats (null otherwise). */
export type RedactedSurrenderEvent = SurrenderEvent;

export type PublicMatchEvent = MatchEvent;

export type RedactedEngineEvent =
  | PublicSessionEvent
  | RedactedDealEvent
  | PublicAuctionEvent
  | RedactedTrumpEvent
  | PublicPlayEvent
  | RedactedSurrenderEvent
  | PublicMatchEvent;

// ---------------------------------------------------------------------------
// Helpers

/**
 * A deep copy of plain JSON data (arrays and plain objects), so projections
 * never hand out an object that is shared with the state or an event.
 */
function copyPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => copyPlain(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = copyPlain(item);
    }
    return copy as T;
  }
  return value;
}

function assertViewer(state: EngineState, viewer: Viewer): void {
  if (viewer.type === "seat") {
    assertSeat(viewer.seat, state.config.playerCount);
  } else if (viewer.type !== "table") {
    throw new RangeError("viewer must be a seat or the Table view");
  }
}

function isSeatViewer(viewer: Viewer, seat: Seat): boolean {
  return viewer.type === "seat" && viewer.seat === seat;
}

function matchOf(state: EngineState): MatchState | null {
  const { phase } = state;
  return phase.type === "auction" ||
    phase.type === "placingCard" ||
    phase.type === "play"
    ? phase.match
    : null;
}

function copyTokens(tokens: Readonly<TokenBalances>): TokenBalances {
  return { A: tokens.A, B: tokens.B };
}

/**
 * The contract as `viewer` may see it. `trumpRevealed` is whether a 28
 * hidden trump has been revealed during play.
 */
function publicContract(
  contract: Contract,
  trumpRevealed: boolean,
  viewer: Viewer,
): PublicContract {
  const { trump } = contract;
  let publicTrump: PublicContractTrump;
  switch (trump.type) {
    case "suit":
      publicTrump = { type: "suit", suit: trump.suit };
      break;
    case "noTrump":
      publicTrump = { type: "noTrump" };
      break;
    case "hidden":
      publicTrump = trumpRevealed
        ? { type: "suit", suit: trump.suit }
        : {
            type: "hidden",
            suit: isSeatViewer(viewer, contract.bidder) ? trump.suit : null,
          };
      break;
    default:
      return assertNever(trump, "publicContract");
  }
  return {
    bidder: contract.bidder,
    team: contract.team,
    amount: contract.amount,
    trump: publicTrump,
    style: contract.style,
    multiplier: contract.multiplier,
    forced: contract.forced,
  };
}

/**
 * Canonical summaries never hold an unrevealed suit (scoring.ts
 * `summaryContract`), but the summary trump is still rebuilt from its
 * allowed fields only, so a hidden trump can carry nothing but its type.
 */
function publicSummaryTrump(trump: SummaryTrump): SummaryTrump {
  switch (trump.type) {
    case "suit":
      return { type: "suit", suit: trump.suit };
    case "noTrump":
      return { type: "noTrump" };
    case "hidden":
      return { type: "hidden" };
    default:
      return assertNever(trump, "publicSummaryTrump");
  }
}

function publicMatchSummary(summary: MatchSummary): PublicMatchSummary {
  const { contract } = summary;
  return {
    dealer: summary.dealer,
    contract:
      contract === null
        ? null
        : {
            bidder: contract.bidder,
            team: contract.team,
            amount: contract.amount,
            trump: publicSummaryTrump(contract.trump),
            style: contract.style,
            multiplier: contract.multiplier,
            forced: contract.forced,
          },
    points: { A: summary.points.A, B: summary.points.B },
    tokensMoved:
      summary.tokensMoved === null
        ? null
        : {
            payer: summary.tokensMoved.payer,
            amount: summary.tokensMoved.amount,
          },
    tokens: copyTokens(summary.tokens),
    outcome: copyPlain(summary.outcome),
  };
}

function publicPlays(plays: readonly RoundPlay[]): RoundPlay[] {
  return plays.map((play) => ({
    seat: play.seat,
    card: cloneCard(play.card),
    fromFaceDown: play.fromFaceDown,
  }));
}

function publicFinishedRound(
  round: CompletedRound,
  index: number,
  match: MatchState,
  settings: ViewSettings,
): PublicRound {
  return {
    index,
    leader: round.leader,
    plays: publicPlays(round.plays),
    leadSuit: round.plays[0]?.card.suit ?? null,
    revealedInRound: match.revealedInRound === index,
    revealAskedBy: null,
    winner: round.winner,
    points: settings.livePoints ? round.points : null,
  };
}

function publicCurrentRound(
  round: CurrentRound,
  match: MatchState,
): PublicRound {
  return {
    index: match.rounds.length,
    leader: round.leader,
    plays: publicPlays(round.plays),
    leadSuit: round.leadSuit,
    revealedInRound: round.revealedThisRound,
    revealAskedBy: round.revealAskedBy,
    winner: null,
    points: null,
  };
}

/** design.md §7: none, the most recently finished round, or all of them. */
function visibleRounds(
  match: MatchState,
  settings: ViewSettings,
): PublicRound[] {
  const rounds = match.rounds.map((round, index) =>
    publicFinishedRound(round, index, match, settings),
  );
  switch (settings.roundHistory) {
    case "none":
      return [];
    case "last":
      return rounds.slice(-1);
    case "full":
      return rounds;
    default:
      return assertNever(settings.roundHistory, "visibleRounds");
  }
}

function publicAuction(
  state: EngineState,
  match: MatchState,
): PublicAuction | null {
  const { auction } = match;
  if (auction === null) {
    return null;
  }
  return {
    stage: auction.stage,
    calls: copyPlain(auction.calls),
    turn: state.phase.type === "auction" ? auction.turn : null,
    highBid: copyPlain(auction.highBid),
    doubledBy: auction.doubledBy,
    redoubled: auction.redoubled,
    carriedBid: copyPlain(auction.carriedBid),
  };
}

function publicPhase(state: EngineState): PublicEnginePhase {
  const { phase } = state;
  switch (phase.type) {
    case "awaitingDeal":
      return { type: "awaitingDeal", reason: phase.reason };
    case "auction":
      return { type: "auction" };
    case "placingCard":
      return {
        type: "placingCard",
        seat: placingSeat(phase.match),
      };
    case "play":
      return { type: "play" };
    case "matchOver":
      return { type: "matchOver", summary: publicMatchSummary(phase.summary) };
    case "sessionOver":
      return {
        type: "sessionOver",
        winner: phase.winner,
        summary: publicMatchSummary(phase.summary),
      };
    default:
      return assertNever(phase, "publicPhase");
  }
}

/** In `placingCard`, the auction winner who must place the card. */
function placingSeat(match: MatchState): Seat {
  const seat = match.auction?.highBid?.seat;
  if (seat === undefined) {
    throw new Error("placingCard without an auction winner");
  }
  return seat;
}

function currentTurn(state: EngineState): Seat | null {
  const { phase } = state;
  switch (phase.type) {
    case "auction":
      return phase.match.auction?.turn ?? null;
    case "placingCard":
      return placingSeat(phase.match);
    case "play":
      return phase.match.currentRound?.turn ?? null;
    case "awaitingDeal":
    case "matchOver":
    case "sessionOver":
      return null;
    default:
      return assertNever(phase, "currentTurn");
  }
}

function publicSurrender(match: MatchState): PublicSurrender | null {
  const { vote } = match.surrender;
  return vote === null
    ? null
    : { proposer: vote.proposer, yes: [...vote.yes], no: [...vote.no] };
}

function publicFaceDown(match: MatchState, viewer: Viewer): PublicFaceDown {
  const { faceDown } = match;
  if (faceDown === null) {
    return null;
  }
  return isSeatViewer(viewer, faceDown.owner)
    ? {
        owner: faceDown.owner,
        visibility: "visible",
        card: cloneCard(faceDown.card),
      }
    : { owner: faceDown.owner, visibility: "hidden" };
}

// ---------------------------------------------------------------------------
// Capabilities

const BID_SUITS_56: readonly BidSuit[] = [...SUITS, "noTrump"];
const BID_STYLES_56: readonly BidStyle[] = ["numberFirst", "suitFirst"];

/**
 * design §8.2, §12: calls in the auction. Bid, pass and double only on the
 * seat's turn; redouble for any member of the doubled team while a double is
 * active. Every call is filtered by the same affordability checks `decide`
 * applies (rules §4.6); the forced bid is never doublable.
 */
function auctionActions(
  state: EngineState,
  match: MatchState,
  seat: Seat,
): AllowedEngineAction[] {
  const { auction } = match;
  if (auction === null) {
    return [];
  }
  const { config, tokens } = state;
  const team = teamOf(seat);
  const { highBid } = auction;
  const actions: AllowedEngineAction[] = [];

  if (auction.turn === seat) {
    const range = bidRange(state, seat);
    if (range !== null) {
      const is56 = auction.stage === "56";
      actions.push({
        type: "bid",
        range: { minimum: range.minimum, maximum: range.maximum },
        suits: is56 ? [...BID_SUITS_56] : [],
        styles: is56 ? [...BID_STYLES_56] : [],
      });
    }
    actions.push({ type: "pass" });
    if (
      highBid !== null &&
      !highBid.forced &&
      auction.doubledBy === null &&
      teamOf(highBid.seat) !== team &&
      canAffordDouble(config, highBid.amount, tokens[team])
    ) {
      actions.push({ type: "double" });
    }
  }

  if (
    highBid !== null &&
    auction.doubledBy !== null &&
    !auction.redoubled &&
    teamOf(highBid.seat) === team &&
    canAffordRedouble(config, highBid.amount, tokens[team])
  ) {
    actions.push({ type: "redouble" });
  }
  return actions;
}

/** design §8.4, §12: the 28 auction winner places any card from its hand. */
function placingActions(match: MatchState, seat: Seat): AllowedEngineAction[] {
  const hand = match.hands[seat] ?? [];
  return placingSeat(match) === seat && hand.length > 0
    ? [{ type: "placeCard", cards: hand.map(cloneCard) }]
    : [];
}

/**
 * design §10.1, §12: `proposeSurrender` for losing-team seats once the result
 * is certain, while no vote runs and no vote failed this round; during a
 * vote, `voteSurrender` for losing-team seats that haven't voted.
 */
function surrenderActions(
  state: EngineState,
  match: MatchState,
  seat: Seat,
): AllowedEngineAction[] {
  const { decided, vote, lastFailedRound } = match.surrender;
  if (
    state.config.surrenderOption !== "on" ||
    decided === null ||
    teamOf(seat) !== decided
  ) {
    return [];
  }
  if (vote !== null) {
    return vote.yes.includes(seat) || vote.no.includes(seat)
      ? []
      : [{ type: "voteSurrender", votes: ["yes", "no"] }];
  }
  return lastFailedRound === match.rounds.length
    ? []
    : [{ type: "proposeSurrender" }];
}

/**
 * design §9, §12: cards and the reveal on the seat's turn, plus surrender.
 *
 * - Block: the legal cards (`legalCards`: only the face-down card when
 *   forced), and `askReveal` when the reveal is allowed and the seat can't
 *   follow suit.
 * - Auto-stop: every card in hand plus the face-down card when forced, and
 *   `askReveal` whenever the reveal is allowed; the disqualifying ones are
 *   accepted and stop the match. A face-down card that isn't forced is
 *   rejected in both modes, so it is never listed.
 * - While a surrender vote runs, only `voteSurrender`.
 */
function playActions(
  state: EngineState,
  match: MatchState,
  seat: Seat,
): AllowedEngineAction[] {
  const round = match.currentRound;
  if (round === null || match.contract === null) {
    return [];
  }
  const surrender = surrenderActions(state, match, seat);
  if (match.surrender.vote !== null) {
    return surrender;
  }

  const actions: AllowedEngineAction[] = [];
  if (round.turn === seat) {
    const hand = match.hands[seat] ?? [];
    const autoStop = state.config.illegalPlayMode === "autoStop";
    let cards: Card[];
    if (autoStop) {
      cards = hand.map(cloneCard);
      if (faceDownIsForced(state, seat) && match.faceDown !== null) {
        cards.push(cloneCard(match.faceDown.card));
      }
    } else {
      cards = legalCards(state, seat);
    }
    if (cards.length > 0) {
      actions.push({ type: "playCard", cards });
    }

    const ableToFollow = hand.some((card) => card.suit === round.leadSuit);
    if (revealBlocker(state, seat) === null && (autoStop || !ableToFollow)) {
      actions.push({ type: "askReveal" });
    }
  }
  actions.push(...surrender);
  return actions;
}

/**
 * design §12: what `seat` may do right now. Anything not listed is rejected
 * by `decide`; everything listed is accepted (in Auto-stop, including the
 * disqualifying plays). System and host actions are never listed.
 */
export function allowedActions(
  state: EngineState,
  seat: Seat,
): AllowedEngineAction[] {
  assertSeat(seat, state.config.playerCount);
  const { phase } = state;
  switch (phase.type) {
    case "auction":
      return auctionActions(state, phase.match, seat);
    case "placingCard":
      return placingActions(phase.match, seat);
    case "play":
      return playActions(state, phase.match, seat);
    case "awaitingDeal":
    case "matchOver":
    case "sessionOver":
      return [];
    default:
      return assertNever(phase, "allowedActions");
  }
}

/**
 * design §10.2, §12: End match `restart` in `auction`, `placingCard` and
 * `play` (also during a surrender vote), and `award` to either team only in
 * `play`. Whether the sender holds the host role is the service's check.
 */
export function allowedHostActions(state: EngineState): AllowedHostActions {
  const { type } = state.phase;
  return {
    restart: type === "auction" || type === "placingCard" || type === "play",
    awardTeams: type === "play" ? ["A", "B"] : [],
  };
}

// ---------------------------------------------------------------------------
// Views

/**
 * design §11.3: everything `viewer` may see right now.
 *
 * Public for every viewer: phase, seats and teams, tokens, dealer, turn, the
 * auction, the contract (an unrevealed 28 trump is `hidden`, with its suit
 * only for the bidder), whose face-down card exists, card counts, the
 * current round, finished rounds per `roundHistory`, points only with
 * `livePoints`, a running surrender vote, and the canonical match log,
 * phase summary and past sessions.
 *
 * Seat only: its own hand, its own face-down card, its allowed actions, and
 * `resultDecided` when its team has certainly lost. The Table view gets no
 * hand, face-down card, or actions. Throws a `RangeError` for a seat outside
 * the table.
 */
export function view(
  state: EngineState,
  viewer: Viewer,
  settings: ViewSettings,
): EngineView {
  assertViewer(state, viewer);
  const { config } = state;
  const match = matchOf(state);
  const seats = Array.from({ length: config.playerCount }, (_, seat) => seat);

  let viewerView: ViewerView = { type: "table" };
  if (viewer.type === "seat") {
    const { seat } = viewer;
    const faceDown = match?.faceDown ?? null;
    const decided = match?.surrender.decided ?? null;
    viewerView = {
      type: "seat",
      seat,
      hand: (match?.hands[seat] ?? []).map(cloneCard),
      faceDownCard:
        faceDown !== null && faceDown.owner === seat
          ? cloneCard(faceDown.card)
          : null,
      allowedActions: allowedActions(state, seat),
      resultDecided:
        decided !== null && teamOf(seat) === decided ? decided : null,
    };
  }

  return {
    phase: publicPhase(state),
    seatCount: config.playerCount,
    teams: seats.map(teamOf),
    tokens: copyTokens(state.tokens),
    dealer: state.dealer,
    turn: currentTurn(state),
    auction: match === null ? null : publicAuction(state, match),
    contract:
      match === null || match.contract === null
        ? null
        : publicContract(
            match.contract,
            match.revealedInRound !== null,
            viewer,
          ),
    faceDown: match === null ? null : publicFaceDown(match, viewer),
    cardCounts: seats.map((seat) => match?.hands[seat]?.length ?? 0),
    currentRound:
      match === null || match.currentRound === null
        ? null
        : publicCurrentRound(match.currentRound, match),
    rounds: match === null ? [] : visibleRounds(match, settings),
    points:
      match !== null && settings.livePoints
        ? { A: match.points.A, B: match.points.B }
        : null,
    surrender: match === null ? null : publicSurrender(match),
    matchLog: state.matchLog.map(publicMatchSummary),
    pastSessions: state.pastSessions.map((past) => ({
      winner: past.winner,
      tokens: copyTokens(past.tokens),
    })),
    viewer: viewerView,
  };
}

// ---------------------------------------------------------------------------
// Event redaction

function ownCardOnly(
  event: CardPlacedEvent | FaceDownReturnedEvent,
  viewer: Viewer,
): Card | null {
  return isSeatViewer(viewer, event.seat) ? cloneCard(event.card) : null;
}

/**
 * design §11.2: `event` as `viewer` may see it, or null when the viewer must
 * not receive it at all. Returning null keeps the order of the remaining
 * events in an action's batch.
 *
 * - `dealt`: the viewing seat's own cards and every seat's count; counts
 *   only for the Table view; never the 28 `undealt` cards.
 * - `cardPlaced`, `faceDownReturned`: the card only for its owner.
 * - `auctionEnded`: an unrevealed 28 trump suit only for the bidder.
 * - `roundWon`: `points` null when live points are off.
 * - `resultDecided`: only for the losing team's seats; null otherwise.
 * - `matchEnded`: the canonical summary, rebuilt from its public fields.
 * - Every other event is public and copied unchanged.
 *
 * `redactEvent` needs no state: whether the viewer is the owner, the bidder,
 * or on the losing team is in the event itself. Throws a `RangeError` for a
 * seat viewer that isn't a whole number from 0 through 7. The caller must
 * pass a seat that exists at the event's table: with no state, a seat past
 * the seat count isn't rejected and gets, for example, `dealt` with
 * `hand: []`.
 */
export function redactEvent(
  event: EngineEvent,
  viewer: Viewer,
  settings: ViewSettings,
): RedactedEngineEvent | null {
  if (viewer.type === "seat") {
    // Validates the seat (0–7); there is no state here to bound it further.
    teamOf(viewer.seat);
  } else if (viewer.type !== "table") {
    throw new RangeError("viewer must be a seat or the Table view");
  }
  switch (event.type) {
    case "dealt":
      return {
        type: "dealt",
        stage: event.stage,
        hand:
          viewer.type === "seat"
            ? (event.hands[viewer.seat] ?? []).map(cloneCard)
            : null,
        cardCounts: event.hands.map((cards) => cards.length),
      };
    case "cardPlaced":
      return {
        type: "cardPlaced",
        seat: event.seat,
        card: ownCardOnly(event, viewer),
      };
    case "faceDownReturned":
      return {
        type: "faceDownReturned",
        seat: event.seat,
        card: ownCardOnly(event, viewer),
      };
    case "auctionEnded":
      return {
        type: "auctionEnded",
        contract: publicContract(event.contract, false, viewer),
      };
    case "roundWon":
      return {
        type: "roundWon",
        seat: event.seat,
        team: event.team,
        points: settings.livePoints ? event.points : null,
      };
    case "resultDecided":
      return viewer.type === "seat" && teamOf(viewer.seat) === event.losingTeam
        ? { type: "resultDecided", losingTeam: event.losingTeam }
        : null;
    case "matchEnded":
      return { type: "matchEnded", summary: publicMatchSummary(event.summary) };
    case "sessionStarted":
    case "sessionRestarted":
    case "sessionEnded":
    case "nextMatchStarted":
    case "redealt":
    case "auctionStarted":
    case "bidMade":
    case "passed":
    case "doubled":
    case "doubleCancelled":
    case "redoubled":
    case "forcedBid":
    case "placingCardStarted":
    case "revealAsked":
    case "trumpRevealed":
    case "playStarted":
    case "cardPlayed":
    case "disqualified":
    case "surrenderProposed":
    case "surrenderVoted":
    case "surrenderFailed":
    case "surrendered":
      return copyPlain(event);
    default:
      return assertNever(event, "redactEvent");
  }
}
