import { carriedBidStands } from "./auction.js";
import { buildDeck, cardPoints } from "./cards.js";
import { AUCTION_BID_LIMITS, validateConfig } from "./config.js";
import { assertNever } from "./result.js";
import { isSeatInRange, teamOf } from "./seats.js";
import type {
  AuctionState,
  Contract,
  EngineState,
  MatchState,
  MatchSummary,
  RoundPlay,
} from "./state.js";
import type { Card, Seat, TokenBalances } from "./types.js";

export type EngineInvariantCode =
  | "invalidConfig"
  | "dealerOutOfRange"
  | "seatOutOfRange"
  | "contractTeamMismatch"
  | "invalidTokens"
  | "phaseMatchMismatch"
  | "invalidSeatArrays"
  | "unknownCard"
  | "duplicateCardLocation"
  | "missingCardLocation"
  | "invalidTurn"
  | "invalidPoints"
  | "summaryLeaksHiddenTrump"
  | "invalidAuctionState";

/** Thrown for engine bugs. The message names only the invariant code. */
export class EngineInvariantError extends Error {
  readonly code: EngineInvariantCode;

  constructor(code: EngineInvariantCode) {
    super(`Engine invariant violated: ${code}`);
    this.name = "EngineInvariantError";
    this.code = code;
  }
}

function check(condition: boolean, code: EngineInvariantCode): void {
  if (!condition) {
    throw new EngineInvariantError(code);
  }
}

function isNonNegativeWholeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function checkBalances(balances: TokenBalances): void {
  check(
    isNonNegativeWholeNumber(balances.A) &&
      isNonNegativeWholeNumber(balances.B),
    "invalidTokens",
  );
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

function checkSummary(summary: MatchSummary, playerCount: number): void {
  check(isSeatInRange(summary.dealer, playerCount), "seatOutOfRange");
  checkBalances(summary.tokens);
  const contract = summary.contract;
  if (contract !== null) {
    check(isSeatInRange(contract.bidder, playerCount), "seatOutOfRange");
    check(contract.team === teamOf(contract.bidder), "contractTeamMismatch");
    if (contract.trump.type === "hidden") {
      check(
        Object.keys(contract.trump).length === 1,
        "summaryLeaksHiddenTrump",
      );
    }
  }
}

function summaryTokensMatch(
  summary: MatchSummary,
  state: EngineState,
): boolean {
  return (
    summary.tokens.A === state.tokens.A && summary.tokens.B === state.tokens.B
  );
}

function checkSeat(seat: Seat | null, playerCount: number): void {
  if (seat !== null) {
    check(isSeatInRange(seat, playerCount), "seatOutOfRange");
  }
}

function checkPlayOrder(
  leader: Seat,
  plays: readonly RoundPlay[],
  playerCount: number,
): void {
  checkSeat(leader, playerCount);
  check(plays.length <= playerCount, "invalidTurn");
  for (const [index, play] of plays.entries()) {
    check(play.seat === (leader + index) % playerCount, "invalidTurn");
  }
}

function checkMatch(
  state: EngineState,
  match: MatchState,
  phase: "auction" | "placingCard" | "play",
): void {
  const { playerCount } = state.config;

  check(match.hands.length === playerCount, "invalidSeatArrays");
  check(
    match.undealt === null || match.undealt.length === playerCount,
    "invalidSeatArrays",
  );

  if (phase === "auction") {
    check(match.auction !== null, "phaseMatchMismatch");
  }
  if (phase === "placingCard") {
    // design §8.4: a finished 28 auction's winner still has to place a card.
    check(
      match.auction !== null &&
        match.auction.stage !== "56" &&
        match.auction.highBid !== null &&
        match.faceDown === null,
      "phaseMatchMismatch",
    );
  }
  if (phase === "play") {
    check(
      match.contract !== null && match.currentRound !== null,
      "phaseMatchMismatch",
    );
  } else {
    check(
      match.currentRound === null && match.rounds.length === 0,
      "phaseMatchMismatch",
    );
  }

  const auction = match.auction;
  if (auction !== null) {
    checkSeat(auction.turn, playerCount);
    checkSeat(auction.doubledBy, playerCount);
    checkSeat(auction.highBid?.seat ?? null, playerCount);
    checkSeat(auction.carriedBid?.bid.seat ?? null, playerCount);
    checkSeat(auction.carriedBid?.doubledBy ?? null, playerCount);
    for (const call of auction.calls) {
      checkSeat(call.seat, playerCount);
    }
    // design §8.3: reaching the ending threshold ends the active auction
    // within the same action. The terminal count remains in the preserved
    // auction data after the phase advances to placingCard or play.
    //
    // A 28 second auction carries its first-auction bid and double status
    // as `highBid`/`doubledBy` (recorded unchanged in `carriedBid`). While
    // every call is a pass the carried bid still stands and all N seats get
    // their initial circuit, even when a carried double would otherwise end
    // the auction on reaching its doubler.
    const expectedStage =
      state.config.gameType === "56"
        ? auction.stage === "56"
        : auction.stage !== "56";
    check(expectedStage, "invalidAuctionState");
    const carriedBidStillStanding = carriedBidStands(auction);
    const passLimit = carriedBidStillStanding
      ? playerCount
      : auction.highBid !== null && !auction.highBid.forced
        ? playerCount - 1
        : playerCount;
    check(
      isNonNegativeWholeNumber(auction.consecutivePasses) &&
        (phase === "auction"
          ? auction.consecutivePasses < passLimit
          : auction.consecutivePasses <= passLimit),
      "invalidTurn",
    );

    // design §8.2/§8.4: a double can only stand against the other team's
    // bid, a redouble implies an active double, and the forced bid (exempt
    // from doubling entirely) can never carry either. The carried
    // representation keeps the standing bid in `highBid`, so this holds in
    // the 28 second auction too.
    if (auction.doubledBy !== null) {
      check(auction.highBid !== null, "invalidAuctionState");
      check(
        auction.highBid === null ||
          teamOf(auction.doubledBy) !== teamOf(auction.highBid.seat),
        "invalidAuctionState",
      );
    }
    check(
      !auction.redoubled || auction.doubledBy !== null,
      "invalidAuctionState",
    );
    check(
      !(auction.highBid?.forced ?? false) ||
        (auction.doubledBy === null && !auction.redoubled),
      "invalidAuctionState",
    );

    checkAuctionStage(match, auction, phase);
  }

  const contract = match.contract;
  if (contract !== null) {
    checkSeat(contract.bidder, playerCount);
    check(contract.team === teamOf(contract.bidder), "contractTeamMismatch");
    if (phase === "play") {
      checkPlayTrump(match, contract);
    }
  }

  checkSeat(match.faceDown?.owner ?? null, playerCount);

  for (const round of match.rounds) {
    checkPlayOrder(round.leader, round.plays, playerCount);
    check(round.plays.length === playerCount, "invalidTurn");
    check(
      round.plays.some((play) => play.seat === round.winner),
      "invalidTurn",
    );
  }

  const current = match.currentRound;
  if (current !== null) {
    checkPlayOrder(current.leader, current.plays, playerCount);
    check(
      current.plays.length < playerCount &&
        current.turn === (current.leader + current.plays.length) % playerCount,
      "invalidTurn",
    );
    checkSeat(current.revealAskedBy, playerCount);
  }

  const vote = match.surrender.vote;
  if (vote !== null) {
    checkSeat(vote.proposer, playerCount);
    for (const seat of [...vote.yes, ...vote.no]) {
      checkSeat(seat, playerCount);
    }
  }

  check(
    isNonNegativeWholeNumber(match.points.A) &&
      isNonNegativeWholeNumber(match.points.B),
    "invalidPoints",
  );
  const wonPoints = { A: 0, B: 0 };
  for (const round of match.rounds) {
    const roundPoints = round.plays.reduce(
      (total, play) => total + cardPoints(play.card),
      0,
    );
    check(round.points === roundPoints, "invalidPoints");
    wonPoints[teamOf(round.winner)] += round.points;
  }
  check(
    match.points.A === wonPoints.A && match.points.B === wonPoints.B,
    "invalidPoints",
  );

  checkCardLocations(state, match);
}

/**
 * design §6.3, §8.4: where each 28 auction stage leaves the undealt cards,
 * the carried bid, and the face-down card.
 */
function checkAuctionStage(
  match: MatchState,
  auction: AuctionState,
  phase: "auction" | "placingCard" | "play",
): void {
  const { carriedBid, stage } = auction;
  if (stage !== "28-second") {
    check(carriedBid === null, "invalidAuctionState");
  }
  if (stage === "56") {
    check(
      match.undealt === null && match.faceDown === null,
      "phaseMatchMismatch",
    );
    return;
  }

  if (stage === "28-first") {
    // The second deal follows the first auction's end in the same action.
    // Only a redoubled first auction, or one bid at 28, has no second
    // auction and goes straight to play after it (rules §10.2).
    check(
      match.undealt !== null
        ? match.faceDown === null && match.contract === null
        : phase === "play" &&
            match.contract !== null &&
            (auction.redoubled ||
              auction.highBid?.amount ===
                AUCTION_BID_LIMITS["28-first"].maximum),
      "phaseMatchMismatch",
    );
    return;
  }

  check(carriedBid !== null && match.undealt === null, "invalidAuctionState");
  if (carriedBid === null) {
    return;
  }
  // design §6.3: the first-auction contract stands through the second
  // auction and the placement after it, matching the carried bid; a double
  // or redouble made in the second auction reaches the contract only through
  // its `auctionEnded`, which replaces the contract before play.
  if (phase !== "play") {
    const { contract } = match;
    const carried = carriedBid.bid;
    check(
      contract !== null &&
        contract.bidder === carried.seat &&
        contract.amount === carried.amount &&
        contract.forced === carried.forced &&
        contract.multiplier === (carriedBid.doubledBy === null ? 1 : 2) &&
        (carried.forced
          ? contract.trump.type === "noTrump"
          : contract.trump.type === "hidden" &&
            (match.faceDown === null ||
              match.faceDown.card.suit === contract.trump.suit)),
      "invalidAuctionState",
    );
  }
  check(
    (!carriedBid.bid.forced || carriedBid.doubledBy === null) &&
      carriedBid.bid.amount < AUCTION_BID_LIMITS["28-second"].maximum,
    "invalidAuctionState",
  );
  if (carriedBidStands(auction)) {
    // No second-auction bid or double yet: the carried state is intact and,
    // until a reveal during play, so is its face-down card (none for a
    // forced 14 no trump).
    check(
      auction.highBid !== null &&
        auction.highBid.seat === carriedBid.bid.seat &&
        auction.highBid.amount === carriedBid.bid.amount &&
        auction.highBid.forced === carriedBid.bid.forced &&
        auction.doubledBy === carriedBid.doubledBy &&
        (match.revealedInRound !== null ||
          (carriedBid.bid.forced
            ? match.faceDown === null
            : match.faceDown?.owner === carriedBid.bid.seat)),
      "invalidAuctionState",
    );
  }
}

/**
 * design §8.4, §9.3: a hidden trump that hasn't been revealed is the
 * bidder's face-down card; no trump (and every 56 contract) has none.
 */
function checkPlayTrump(match: MatchState, contract: Contract): void {
  if (contract.trump.type === "hidden") {
    if (match.revealedInRound === null) {
      check(
        match.faceDown !== null &&
          match.faceDown.owner === contract.bidder &&
          match.faceDown.card.suit === contract.trump.suit,
        "phaseMatchMismatch",
      );
    }
    return;
  }
  check(match.faceDown === null, "phaseMatchMismatch");
}

function checkCardLocations(state: EngineState, match: MatchState): void {
  const known = new Set(buildDeck(state.config).map(cardKey));
  const seen = new Set<string>();
  const locate = (card: Card): void => {
    const key = cardKey(card);
    check(known.has(key), "unknownCard");
    check(!seen.has(key), "duplicateCardLocation");
    seen.add(key);
  };

  for (const hand of match.hands) {
    hand.forEach(locate);
  }
  for (const cards of match.undealt ?? []) {
    cards.forEach(locate);
  }
  if (match.faceDown !== null) {
    locate(match.faceDown.card);
  }
  for (const round of match.rounds) {
    for (const play of round.plays) {
      locate(play.card);
    }
  }
  for (const play of match.currentRound?.plays ?? []) {
    locate(play.card);
  }

  // Design §7.1/E003: once a match exists every configured card is in
  // exactly one place — a hand, `undealt`, a round, or face-down storage.
  // The loops above already reject duplicates and foreign cards; this closes
  // the gap by rejecting cards that are missing from all of them.
  check(seen.size === known.size, "missingCardLocation");
}

/**
 * Checks structural invariants that must hold after every accepted action.
 * Later units extend these as new state becomes reachable.
 */
export function assertEngineInvariants(state: EngineState): void {
  check(validateConfig(state.config) === null, "invalidConfig");
  const { playerCount } = state.config;

  check(isSeatInRange(state.dealer, playerCount), "dealerOutOfRange");

  checkBalances(state.tokens);

  for (const summary of state.matchLog) {
    checkSummary(summary, playerCount);
  }
  for (const past of state.pastSessions) {
    checkBalances(past.tokens);
  }

  const phase = state.phase;
  switch (phase.type) {
    case "awaitingDeal":
      return;
    case "auction":
    case "placingCard":
    case "play":
      checkMatch(state, phase.match, phase.type);
      return;
    case "matchOver":
      // design §10.4: a scored match with no team at 0 tokens.
      checkSummary(phase.summary, playerCount);
      check(state.tokens.A > 0 && state.tokens.B > 0, "invalidTokens");
      check(summaryTokensMatch(phase.summary, state), "invalidTokens");
      return;
    case "sessionOver":
      // design §10.4: a team reached 0 tokens; the other team wins.
      checkSummary(phase.summary, playerCount);
      check(
        state.tokens[phase.winner] > 0 &&
          state.tokens[phase.winner === "A" ? "B" : "A"] === 0,
        "invalidTokens",
      );
      check(summaryTokensMatch(phase.summary, state), "invalidTokens");
      return;
    default:
      assertNever(phase, "assertEngineInvariants");
  }
}
