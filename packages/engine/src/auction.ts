import type { ActionOfType, EngineAction } from "./actions.js";
import { SUITS } from "./cards.js";
import { AUCTION_BID_LIMITS } from "./config.js";
import { dealSecondStage } from "./deal.js";
import type {
  AuctionEndedEvent,
  BidMadeEvent,
  DoubleCancelledEvent,
  DoubledEvent,
  EngineEvent,
  ForcedBidEvent,
  PassedEvent,
  PlacingCardStartedEvent,
  PlayStartedEvent,
  RedoubledEvent,
} from "./events.js";
import { accept, assertNever, type Decision, reject } from "./result.js";
import { nextSeat, teamOf } from "./seats.js";
import { canAffordBid, canAffordDouble, canAffordRedouble } from "./stakes.js";
import type {
  AuctionCall,
  AuctionState,
  Contract,
  ContractTrump,
  CurrentRound,
  EngineState,
  HighBid,
  MatchState,
} from "./state.js";
import type {
  BidStyle,
  BidSuit,
  Seat,
  StakeMultiplier,
  Suit,
} from "./types.js";

// Shared auction rules (design §8, rules §4, §10.2). One model serves the 56
// auction and both 28 auctions: turn advancement, call history, doubles,
// redouble, the forced bid, and how each stage ends.
//
// 28 second auction: the carried first-auction bid and double status stand
// as `highBid`/`doubledBy` (and stay recorded unchanged in `carriedBid`).
// While the auction has only passes, the carried bid is still standing and
// the auction ends only after all N seats pass (design §8.3) — a carried
// double does not end this initial circuit when the turn reaches its
// original doubler. Any bid or double in the second auction returns it to
// the ordinary N − 1 pass ending.

export interface BidRange {
  minimum: number;
  maximum: number;
}

/**
 * The lowest amount a bid may name right now: the stage minimum (21 in the
 * 28 second auction), or one more than the standing bid if that's higher.
 */
function minimumBid(auction: AuctionState): number {
  const stageMinimum = AUCTION_BID_LIMITS[auction.stage].minimum;
  return auction.highBid === null
    ? stageMinimum
    : Math.max(stageMinimum, auction.highBid.amount + 1);
}

/**
 * design §8.3: a 28 second auction whose carried bid and double status are
 * untouched — every call so far is a pass — ends only after N passes.
 */
export function carriedBidStands(auction: AuctionState): boolean {
  return (
    auction.stage === "28-second" &&
    auction.carriedBid !== null &&
    auction.calls.every((call) => call.type === "pass")
  );
}

function isBidSuit(value: unknown): value is BidSuit {
  return (
    value === "noTrump" ||
    (typeof value === "string" && (SUITS as readonly string[]).includes(value))
  );
}

function isBidStyle(value: unknown): value is BidStyle {
  return value === "numberFirst" || value === "suitFirst";
}

/**
 * The amount range a seat could legally bid right now, after affordability
 * (design §12). `null` when it isn't the seat's turn, the auction has
 * already reached the top of its range, or the seat's team can't afford even
 * the minimum.
 *
 * This scans downward from the top of the range and returns the first
 * affordable amount as the maximum, which is only a single contiguous range
 * because `validateConfig` requires each stake tier's win/loss stake to be
 * non-decreasing as the bid rises (config.ts) — affordability can only get
 * harder, never easier, at a higher amount.
 */
export function bidRange(state: EngineState, seat: Seat): BidRange | null {
  if (state.phase.type !== "auction" || state.phase.match.auction === null) {
    return null;
  }
  const auction = state.phase.match.auction;
  if (auction.turn !== seat) {
    return null;
  }

  const minimum = minimumBid(auction);
  const stageMaximum = AUCTION_BID_LIMITS[auction.stage].maximum;
  if (minimum > stageMaximum) {
    return null;
  }

  const balance = state.tokens[teamOf(seat)];
  let maximum: number | null = null;
  for (let amount = stageMaximum; amount >= minimum; amount -= 1) {
    if (canAffordBid(state.config, amount, balance)) {
      maximum = amount;
      break;
    }
  }

  return maximum === null ? null : { minimum, maximum };
}

/** design §7.1/§8.2/§8.4: the stake multiplier implied by an auction's double state. */
export function contractMultiplier(auction: AuctionState): 1 | 2 | 4 {
  if (auction.redoubled) {
    return 4;
  }
  if (auction.doubledBy !== null) {
    return 2;
  }
  return 1;
}

/** A 56 bid names its trump: a suit or no trump. */
function trump56(highBid: HighBid): ContractTrump {
  return highBid.suit === "noTrump"
    ? { type: "noTrump" }
    : { type: "suit", suit: highBid.suit as Suit };
}

export function contractFromHighBid(
  highBid: HighBid,
  multiplier: StakeMultiplier,
  trump: ContractTrump,
): Contract {
  return {
    bidder: highBid.seat,
    team: teamOf(highBid.seat),
    amount: highBid.amount,
    trump: { ...trump },
    style: highBid.style,
    multiplier,
    forced: highBid.forced,
  };
}

function cloneContract(contract: Contract): Contract {
  return {
    bidder: contract.bidder,
    team: contract.team,
    amount: contract.amount,
    trump: { ...contract.trump },
    style: contract.style,
    multiplier: contract.multiplier,
    forced: contract.forced,
  };
}

function decideBid(
  state: EngineState,
  auction: AuctionState,
  action: ActionOfType<"bid">,
): Decision {
  const seat = action.source.seat;
  if (seat !== auction.turn) {
    return reject("notYourTurn", { expected: auction.turn, actual: seat });
  }

  let suit: BidSuit | null;
  let style: BidStyle | null;
  if (auction.stage === "56") {
    const rawSuit = action.suit;
    if (rawSuit === undefined) {
      return reject("invalidBid", { reason: "missingSuit" });
    }
    if (!isBidSuit(rawSuit)) {
      return reject("invalidBid", { reason: "invalidSuit" });
    }
    suit = rawSuit;

    const rawStyle = action.style;
    if (suit === "noTrump") {
      if (rawStyle !== undefined) {
        return reject("invalidBid", { reason: "unexpectedStyle" });
      }
      style = null;
    } else {
      if (rawStyle === undefined) {
        return reject("invalidBid", { reason: "missingStyle" });
      }
      if (!isBidStyle(rawStyle)) {
        return reject("invalidBid", { reason: "invalidStyle" });
      }
      style = rawStyle;
    }
  } else {
    // rules §10.2: 28 bids are numbers only. Like `style`, presence is what
    // is checked, so `suit: null` is rejected too.
    if (action.suit !== undefined) {
      return reject("invalidBid", { reason: "unexpectedSuit" });
    }
    if (action.style !== undefined) {
      return reject("invalidBid", { reason: "unexpectedStyle" });
    }
    suit = null;
    style = null;
  }

  const limits = AUCTION_BID_LIMITS[auction.stage];
  const amount: unknown = action.amount;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount)
  ) {
    return reject("bidOutOfRange", {
      reason: "invalidAmount",
      minimum: limits.minimum,
      maximum: limits.maximum,
    });
  }
  if (amount < limits.minimum || amount > limits.maximum) {
    return reject("bidOutOfRange", {
      minimum: limits.minimum,
      maximum: limits.maximum,
      amount,
    });
  }
  if (auction.highBid !== null && amount <= auction.highBid.amount) {
    return reject("bidTooLow", {
      minimum: auction.highBid.amount + 1,
      amount,
    });
  }

  const team = teamOf(seat);
  if (!canAffordBid(state.config, amount, state.tokens[team])) {
    return reject("cannotAfford", { team, amount });
  }

  const bidMade: BidMadeEvent = {
    type: "bidMade",
    seat,
    amount,
    suit,
    style,
  };
  const events: EngineEvent[] = [bidMade];
  if (auction.doubledBy !== null) {
    events.push({ type: "doubleCancelled" });
  }
  return accept(events);
}

/**
 * design §8.3–§8.5: the events that follow the call ending an auction with a
 * standing `highBid` (the last pass, or a redouble).
 *
 * - 56: the contract is complete; play starts at the dealer's right.
 * - 28 first auction: the winner must place a face-down card.
 * - 28 second auction with a new bid (including a self-raise): any earlier
 *   face-down card returns to its owner and the winner places a card.
 * - 28 second auction with no new bid: the carried bid, its face-down card
 *   (or a forced 14's no trump) and the current double status stand.
 */
function auctionEndEvents(
  state: EngineState,
  match: MatchState,
  auction: AuctionState,
  highBid: HighBid,
  multiplier: StakeMultiplier,
): EngineEvent[] {
  const leader = nextSeat(state.dealer, state.config.playerCount);
  const playStarted: PlayStartedEvent = { type: "playStarted", leader };
  const placingCardStarted: PlacingCardStartedEvent = {
    type: "placingCardStarted",
    seat: highBid.seat,
  };

  switch (auction.stage) {
    case "56": {
      const auctionEnded: AuctionEndedEvent = {
        type: "auctionEnded",
        contract: contractFromHighBid(highBid, multiplier, trump56(highBid)),
      };
      return [auctionEnded, playStarted];
    }
    case "28-first":
      return [placingCardStarted];
    case "28-second": {
      const { faceDown } = match;
      if (auction.calls.some((call) => call.type === "bid")) {
        const events: EngineEvent[] = [];
        if (faceDown !== null) {
          events.push({
            type: "faceDownReturned",
            seat: faceDown.owner,
            card: {
              suit: faceDown.card.suit,
              rank: faceDown.card.rank,
              copy: faceDown.card.copy,
            },
          });
        }
        events.push(placingCardStarted);
        return events;
      }
      const auctionEnded: AuctionEndedEvent = {
        type: "auctionEnded",
        contract: contractFromHighBid(
          highBid,
          multiplier,
          faceDown === null
            ? { type: "noTrump" }
            : { type: "hidden", suit: faceDown.card.suit },
        ),
      };
      return [auctionEnded, playStarted];
    }
    default:
      return assertNever(auction.stage, "auctionEndEvents");
  }
}

function decidePass(
  state: EngineState,
  match: MatchState,
  auction: AuctionState,
  action: ActionOfType<"pass">,
): Decision {
  const seat = action.source.seat;
  if (seat !== auction.turn) {
    return reject("notYourTurn", { expected: auction.turn, actual: seat });
  }

  const { playerCount } = state.config;
  const consecutivePasses = auction.consecutivePasses + 1;
  const passed: PassedEvent = { type: "passed", seat };
  const events: EngineEvent[] = [passed];

  if (auction.highBid === null) {
    // rules §4.3: everyone passes without a bid — the dealer's right is
    // forced to take the exempt, undoubleable no-trump contract at the
    // stage minimum (28 in 56, 14 in the 28 first auction). A 28 second
    // auction always has its carried bid standing, so never gets here.
    if (consecutivePasses === playerCount) {
      const leader = nextSeat(state.dealer, playerCount);
      const amount = AUCTION_BID_LIMITS[auction.stage].minimum;
      const forcedHighBid: HighBid = {
        seat: leader,
        amount,
        suit: "noTrump",
        style: null,
        forced: true,
      };
      const forcedBid: ForcedBidEvent = {
        type: "forcedBid",
        seat: leader,
        amount,
      };
      const auctionEnded: AuctionEndedEvent = {
        type: "auctionEnded",
        contract: contractFromHighBid(forcedHighBid, 1, { type: "noTrump" }),
      };
      events.push(forcedBid, auctionEnded);
      if (auction.stage === "56") {
        const playStarted: PlayStartedEvent = { type: "playStarted", leader };
        events.push(playStarted);
      } else {
        // design §8.4: forced 14 no trump places no card; the second deal
        // follows at once.
        const ended = evolveAuctionEnded(
          evolveForcedBid(evolvePassed(state, passed), forcedBid),
          auctionEnded,
        );
        events.push(...dealSecondStage(ended));
      }
    }
    return accept(events);
  }

  // design §8.3: a normal auction ends after N−1 passes following the
  // highest bid; a doubled auction ends the same way (N−1 passes after the
  // double), never letting the bidder/doubler call again. A 28 second
  // auction's untouched carried bid needs all N passes.
  const endingPasses = carriedBidStands(auction)
    ? playerCount
    : playerCount - 1;
  if (consecutivePasses === endingPasses) {
    events.push(
      ...auctionEndEvents(
        state,
        match,
        auction,
        auction.highBid,
        contractMultiplier(auction),
      ),
    );
  }

  return accept(events);
}

function decideDouble(
  state: EngineState,
  auction: AuctionState,
  action: ActionOfType<"double">,
): Decision {
  const seat = action.source.seat;
  if (seat !== auction.turn) {
    return reject("notYourTurn", { expected: auction.turn, actual: seat });
  }

  const { highBid } = auction;
  if (highBid === null || highBid.forced || auction.doubledBy !== null) {
    return reject("doubleNotAllowed", { reason: "noDoublableBid" });
  }
  if (teamOf(seat) === teamOf(highBid.seat)) {
    return reject("doubleNotAllowed", { reason: "ownTeam" });
  }

  const doublingTeam = teamOf(seat);
  if (
    !canAffordDouble(state.config, highBid.amount, state.tokens[doublingTeam])
  ) {
    return reject("cannotAfford", { team: doublingTeam });
  }

  const doubled: DoubledEvent = { type: "doubled", seat };
  return accept([doubled]);
}

function decideRedouble(
  state: EngineState,
  match: MatchState,
  auction: AuctionState,
  action: ActionOfType<"redouble">,
): Decision {
  const seat = action.source.seat;

  if (auction.doubledBy === null || auction.redoubled) {
    return reject("noDoubleActive", {});
  }
  // `doubledBy !== null` always implies a highBid: `decideDouble` requires one
  // to set it, and no evolver clears `highBid` while `doubledBy` stays set
  // (`invariants.ts`'s `invalidAuctionState` check enforces this).
  const highBid = auction.highBid as HighBid;
  const biddingTeam = teamOf(highBid.seat);
  if (teamOf(seat) !== biddingTeam) {
    return reject("doubleNotAllowed", { reason: "notDoubledTeam" });
  }
  if (
    !canAffordRedouble(state.config, highBid.amount, state.tokens[biddingTeam])
  ) {
    return reject("cannotAfford", { team: biddingTeam });
  }

  const redoubled: RedoubledEvent = { type: "redoubled", seat };
  return accept([
    redoubled,
    ...auctionEndEvents(state, match, auction, highBid, 4),
  ]);
}

/** The seat actions this module decides — the only ones `decide()`'s
 * `ACTION_PHASES` table ever routes to `decideAuctionAction`. */
export type AuctionCallAction =
  | ActionOfType<"bid">
  | ActionOfType<"pass">
  | ActionOfType<"double">
  | ActionOfType<"redouble">;

function isAuctionCallAction(
  action: EngineAction,
): action is AuctionCallAction {
  return (
    action.type === "bid" ||
    action.type === "pass" ||
    action.type === "double" ||
    action.type === "redouble"
  );
}

/**
 * Decides `bid`, `pass`, `double` and `redouble` in one shared auction model
 * (design §8) for the 56 auction and both 28 auctions.
 *
 * `decide()`'s `ACTION_PHASES` table only ever calls this while
 * `state.phase.type === "auction"` with one of the four call action types,
 * so those paths are normally unreachable through `decide()`. But this
 * function is exported directly (`index.ts`), so it re-validates both here
 * rather than trusting the caller: an unsupported action type or a
 * non-auction (or transiently auction-less, mid-`deal()`) state is rejected
 * with `actionNotAllowed`, matching `decide()`'s own rejection style,
 * instead of throwing.
 */
export function decideAuctionAction(
  state: EngineState,
  action: EngineAction,
): Decision {
  if (!isAuctionCallAction(action)) {
    return reject("actionNotAllowed", { action: action.type });
  }

  if (state.phase.type !== "auction" || state.phase.match.auction === null) {
    return reject("actionNotAllowed", {
      action: action.type,
      phase: state.phase.type,
    });
  }
  const { match } = state.phase;
  const auction = match.auction as AuctionState;

  switch (action.type) {
    case "bid":
      return decideBid(state, auction, action);
    case "pass":
      return decidePass(state, match, auction, action);
    case "double":
      return decideDouble(state, auction, action);
    case "redouble":
      return decideRedouble(state, match, auction, action);
    default:
      return assertNever(action, "decideAuctionAction");
  }
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of trying to recover from a
// corrupted or misordered event log; these events only ever follow an
// active auction produced by `decideAuctionAction`).

function requireAuction(
  state: EngineState,
  eventType: string,
): { match: MatchState; auction: AuctionState } {
  const { phase } = state;
  if (phase.type !== "auction" || phase.match.auction === null) {
    throw new Error(
      `Cannot apply ${eventType} event: expected an active auction`,
    );
  }
  return { match: phase.match, auction: phase.match.auction };
}

/**
 * design §13.1: `bid`, `pass` and `double` only ever advance the seat whose
 * turn it is — `decideAuctionAction` never emits one of these events for any
 * other seat. `redouble` is the sole out-of-turn call and does not use this.
 */
function requireTurn(
  auction: AuctionState,
  seat: Seat,
  eventType: string,
): void {
  if (seat !== auction.turn) {
    throw new Error(
      `Cannot apply ${eventType} event: seat ${seat} is not on turn ${auction.turn}`,
    );
  }
}

function withAuctionState(
  state: EngineState,
  match: MatchState,
  auction: AuctionState,
): EngineState {
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "auction", match: { ...match, auction } },
  };
}

export function evolveBidMade(
  state: EngineState,
  event: BidMadeEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  requireTurn(auction, event.seat, event.type);
  const highBid: HighBid = {
    seat: event.seat,
    amount: event.amount,
    suit: event.suit,
    style: event.style,
    forced: false,
  };
  const call: AuctionCall = {
    type: "bid",
    seat: event.seat,
    amount: event.amount,
    suit: event.suit,
    style: event.style,
  };
  return withAuctionState(state, match, {
    ...auction,
    calls: [...auction.calls, call],
    highBid,
    consecutivePasses: 0,
    turn: nextSeat(auction.turn, state.config.playerCount),
  });
}

export function evolvePassed(
  state: EngineState,
  event: PassedEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  requireTurn(auction, event.seat, event.type);
  const call: AuctionCall = { type: "pass", seat: event.seat };
  return withAuctionState(state, match, {
    ...auction,
    calls: [...auction.calls, call],
    consecutivePasses: auction.consecutivePasses + 1,
    turn: nextSeat(auction.turn, state.config.playerCount),
  });
}

export function evolveDoubled(
  state: EngineState,
  event: DoubledEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  requireTurn(auction, event.seat, event.type);
  const call: AuctionCall = { type: "double", seat: event.seat };
  return withAuctionState(state, match, {
    ...auction,
    calls: [...auction.calls, call],
    doubledBy: event.seat,
    consecutivePasses: 0,
    turn: nextSeat(auction.turn, state.config.playerCount),
  });
}

export function evolveDoubleCancelled(
  state: EngineState,
  _event: DoubleCancelledEvent,
): EngineState {
  const { match, auction } = requireAuction(state, "doubleCancelled");
  return withAuctionState(state, match, { ...auction, doubledBy: null });
}

export function evolveRedoubled(
  state: EngineState,
  event: RedoubledEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  const call: AuctionCall = { type: "redouble", seat: event.seat };
  return withAuctionState(state, match, {
    ...auction,
    calls: [...auction.calls, call],
    redoubled: true,
  });
}

export function evolveForcedBid(
  state: EngineState,
  event: ForcedBidEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  const highBid: HighBid = {
    seat: event.seat,
    amount: event.amount,
    suit: "noTrump",
    style: null,
    forced: true,
  };
  return withAuctionState(state, match, { ...auction, highBid });
}

/**
 * Fixes the contract. Emitted while the auction phase is still current (56,
 * a forced 14, a 28 second auction whose carried bid stands) or right after
 * `cardPlaced` in `placingCard` (design §8.4). The phase is unchanged:
 * `playStarted`, `auctionStarted(28-second)`, or a redeal's `matchEnded`
 * follows in the same action.
 */
export function evolveAuctionEnded(
  state: EngineState,
  event: AuctionEndedEvent,
): EngineState {
  const { phase } = state;
  if (
    (phase.type !== "auction" && phase.type !== "placingCard") ||
    phase.match.auction === null
  ) {
    throw new Error(
      "Cannot apply auctionEnded event: expected an auction or card placement",
    );
  }
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: {
      type: phase.type,
      match: { ...phase.match, contract: cloneContract(event.contract) },
    },
  };
}

/**
 * Design §8.5: fixes the contract's play state. `evolveAuctionEnded` (which
 * always precedes this event within the same action) has already set
 * `match.contract`; this evolver only adds the empty `currentRound` and
 * moves the phase from `auction` (or 28's `placingCard`) to `play`.
 */
export function evolvePlayStarted(
  state: EngineState,
  event: PlayStartedEvent,
): EngineState {
  const { phase } = state;
  if (
    (phase.type !== "auction" && phase.type !== "placingCard") ||
    phase.match.contract === null
  ) {
    throw new Error(
      "Cannot apply playStarted event: expected a finalized auction contract",
    );
  }

  const currentRound: CurrentRound = {
    leader: event.leader,
    plays: [],
    turn: event.leader,
    leadSuit: null,
    revealedThisRound: false,
    revealAskedBy: null,
  };

  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "play", match: { ...phase.match, currentRound } },
  };
}
