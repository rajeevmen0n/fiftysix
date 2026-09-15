import type { ActionOfType, EngineAction } from "./actions.js";
import { SUITS } from "./cards.js";
import type {
  AuctionEndedEvent,
  BidMadeEvent,
  DoubleCancelledEvent,
  DoubledEvent,
  EngineEvent,
  ForcedBidEvent,
  PassedEvent,
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

// Shared auction rules (design §8, rules §4). This module implements the
// single 56 auction end to end (turn advancement, call history, doubles,
// redouble, the forced bid, and the completed contract). 28's first and
// second auctions (carried bids, the full initial circuit exception, face-down
// placement) share the same `AuctionState` shape but are implemented by the
// unit that also builds the face-down/second-deal machinery those endings
// need (`placingCard`) — see the stage guard in `decideAuctionAction`.

export interface BidRange {
  minimum: number;
  maximum: number;
}

const MIN_BID_56 = 28;
const MAX_BID_56 = 56;

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
 * the minimum. Only the shared 56 auction is implemented; 28's ranges depend
 * on `carriedBid`/second-auction mechanics a later unit adds.
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
  if (auction.stage !== "56" || auction.turn !== seat) {
    return null;
  }

  const minimum =
    auction.highBid === null ? MIN_BID_56 : auction.highBid.amount + 1;
  if (minimum > MAX_BID_56) {
    return null;
  }

  const balance = state.tokens[teamOf(seat)];
  let maximum: number | null = null;
  for (let amount = MAX_BID_56; amount >= minimum; amount -= 1) {
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

function contractFromHighBid(
  highBid: HighBid,
  multiplier: StakeMultiplier,
): Contract {
  return {
    bidder: highBid.seat,
    team: teamOf(highBid.seat),
    amount: highBid.amount,
    trump:
      highBid.suit === "noTrump"
        ? { type: "noTrump" }
        : { type: "suit", suit: highBid.suit as Suit },
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

  const suit = action.suit;
  if (suit === undefined) {
    return reject("invalidBid", { reason: "missingSuit" });
  }
  if (!isBidSuit(suit)) {
    return reject("invalidBid", { reason: "invalidSuit" });
  }

  const rawStyle = action.style;
  let style: BidStyle | null;
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

  const amount: unknown = action.amount;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    !Number.isInteger(amount)
  ) {
    return reject("bidOutOfRange", {
      reason: "invalidAmount",
      minimum: MIN_BID_56,
      maximum: MAX_BID_56,
    });
  }
  if (amount < MIN_BID_56 || amount > MAX_BID_56) {
    return reject("bidOutOfRange", {
      minimum: MIN_BID_56,
      maximum: MAX_BID_56,
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

function decidePass(
  state: EngineState,
  auction: AuctionState,
  action: ActionOfType<"pass">,
): Decision {
  const seat = action.source.seat;
  if (seat !== auction.turn) {
    return reject("notYourTurn", { expected: auction.turn, actual: seat });
  }

  const { playerCount } = state.config;
  const consecutivePasses = auction.consecutivePasses + 1;
  const events: EngineEvent[] = [{ type: "passed", seat }];
  const leader = nextSeat(state.dealer, playerCount);

  if (auction.highBid === null) {
    // rules §4.3: everyone passes without a bid — the dealer's right is
    // forced to take the exempt, undoubleable 28 no-trump contract.
    if (consecutivePasses === playerCount) {
      const forcedHighBid: HighBid = {
        seat: leader,
        amount: MIN_BID_56,
        suit: "noTrump",
        style: null,
        forced: true,
      };
      const forcedBid: ForcedBidEvent = {
        type: "forcedBid",
        seat: leader,
        amount: MIN_BID_56,
      };
      const auctionEnded: AuctionEndedEvent = {
        type: "auctionEnded",
        contract: contractFromHighBid(forcedHighBid, 1),
      };
      const playStarted: PlayStartedEvent = { type: "playStarted", leader };
      events.push(forcedBid, auctionEnded, playStarted);
    }
    return accept(events);
  }

  // design §8.3: a normal auction ends after N−1 passes following the
  // highest bid; a doubled auction ends the same way (N−1 passes after the
  // double), never letting the bidder/doubler call again.
  if (consecutivePasses === playerCount - 1) {
    const auctionEnded: AuctionEndedEvent = {
      type: "auctionEnded",
      contract: contractFromHighBid(
        auction.highBid,
        contractMultiplier(auction),
      ),
    };
    const playStarted: PlayStartedEvent = { type: "playStarted", leader };
    events.push(auctionEnded, playStarted);
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

  const leader = nextSeat(state.dealer, state.config.playerCount);
  const redoubled: RedoubledEvent = { type: "redoubled", seat };
  const auctionEnded: AuctionEndedEvent = {
    type: "auctionEnded",
    contract: contractFromHighBid(highBid, 4),
  };
  const playStarted: PlayStartedEvent = { type: "playStarted", leader };
  return accept([redoubled, auctionEnded, playStarted]);
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
 * (design §8). Only the 56 auction (a single, uncarried auction) is wired to
 * a completed contract here; 28's auctions are a later unit's responsibility.
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
  const auction = state.phase.match.auction;

  if (auction.stage !== "56") {
    // 28's first/second auctions are implemented alongside the face-down
    // card and second deal they end into.
    return reject("actionNotAllowed", {
      action: action.type,
      stage: auction.stage,
    });
  }

  switch (action.type) {
    case "bid":
      return decideBid(state, auction, action);
    case "pass":
      return decidePass(state, auction, action);
    case "double":
      return decideDouble(state, auction, action);
    case "redouble":
      return decideRedouble(state, auction, action);
    default:
      return assertNever(action, "decideAuctionAction");
  }
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of trying to recover from a
// corrupted or misordered event log; these events only ever follow an
// active 56 auction produced by `decideAuctionAction`).

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

export function evolveAuctionEnded(
  state: EngineState,
  event: AuctionEndedEvent,
): EngineState {
  const { match, auction } = requireAuction(state, event.type);
  return withAuctionState(
    state,
    { ...match, contract: cloneContract(event.contract) },
    auction,
  );
}

/**
 * Design §8.5: fixes the contract's play state. `evolveAuctionEnded` (which
 * always precedes this event within the same action) has already set
 * `match.contract`; this evolver only adds the empty `currentRound` and
 * moves the phase from `auction` to `play`.
 */
export function evolvePlayStarted(
  state: EngineState,
  event: PlayStartedEvent,
): EngineState {
  const { phase } = state;
  if (phase.type !== "auction" || phase.match.contract === null) {
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
