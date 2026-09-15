import { buildDeck, cardPoints } from "./cards.js";
import { validateConfig } from "./config.js";
import { assertNever } from "./result.js";
import { isSeatInRange, teamOf } from "./seats.js";
import type {
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
  | "summaryLeaksHiddenTrump";

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
    check(match.auction?.highBid != null, "phaseMatchMismatch");
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
    check(isNonNegativeWholeNumber(auction.consecutivePasses), "invalidTurn");
  }

  const contract = match.contract;
  if (contract !== null) {
    checkSeat(contract.bidder, playerCount);
    check(contract.team === teamOf(contract.bidder), "contractTeamMismatch");
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
