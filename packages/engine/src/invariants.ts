import { carriedBidStands } from "./auction.js";
import { buildDeck, cardPoints } from "./cards.js";
import { hasSecondAuction, validateConfig } from "./config.js";
import { countingTrumpSuit, roundWinner } from "./play.js";
import { assertNever } from "./result.js";
import { isSeatInRange, teamOf } from "./seats.js";
import type {
  AuctionState,
  Contract,
  EngineState,
  MatchOutcome,
  MatchState,
  MatchSummary,
  RoundPlay,
} from "./state.js";
import { losingTeamIfCertain, surrenderVoteStatus } from "./surrender.js";
import type { Card, EngineConfig, Seat, Team, TokenBalances } from "./types.js";

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
  | "invalidSummary"
  | "invalidAuctionState"
  | "invalidRound"
  | "invalidReveal"
  | "invalidSurrender";

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

/**
 * Balances are nonnegative whole numbers, and because tokens only ever move
 * from one team to the other (design §10.3, §13.2) they always add up to the
 * two teams' starting tokens.
 */
function checkBalances(balances: TokenBalances, startingTokens: number): void {
  check(
    isNonNegativeWholeNumber(balances.A) &&
      isNonNegativeWholeNumber(balances.B) &&
      balances.A + balances.B === 2 * startingTokens,
    "invalidTokens",
  );
}

function isTeam(value: unknown): value is Team {
  return value === "A" || value === "B";
}

function isScoredOutcome(outcome: MatchOutcome): boolean {
  return outcome.type !== "restarted" && outcome.type !== "redealt";
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

function checkSummary(summary: MatchSummary, config: EngineConfig): void {
  const { playerCount } = config;
  check(isSeatInRange(summary.dealer, playerCount), "seatOutOfRange");
  checkBalances(summary.tokens, config.startingTokens);
  check(
    isNonNegativeWholeNumber(summary.points.A) &&
      isNonNegativeWholeNumber(summary.points.B),
    "invalidPoints",
  );

  // design §10.3: only scored outcomes move tokens; restarts and redeals
  // record none.
  const { outcome, tokensMoved } = summary;
  if (isScoredOutcome(outcome)) {
    check(
      tokensMoved !== null &&
        isTeam(tokensMoved.payer) &&
        isNonNegativeWholeNumber(tokensMoved.amount),
      "invalidSummary",
    );
  } else {
    check(tokensMoved === null, "invalidSummary");
  }
  if (outcome.type === "disqualified") {
    check(isSeatInRange(outcome.seat, playerCount), "seatOutOfRange");
  }
  if (outcome.type === "surrendered" || outcome.type === "awarded") {
    check(isTeam(outcome.team), "invalidSummary");
  }
  if (outcome.type === "redealt" && outcome.reason.type === "lowHand") {
    check(isSeatInRange(outcome.reason.seat, playerCount), "seatOutOfRange");
  }

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

/**
 * Structural equality of two JSON values, independent of object key order
 * (a state rebuilt from JSON or by another evolver may order keys
 * differently).
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function summaryTokensMatch(
  summary: MatchSummary,
  state: EngineState,
): boolean {
  return (
    summary.tokens.A === state.tokens.A && summary.tokens.B === state.tokens.B
  );
}

/**
 * design §10.4: `matchOver`/`sessionOver` show the scored result that was just
 * appended to `matchLog`, for the current dealer.
 */
function checkFinishedMatchSummary(
  summary: MatchSummary,
  state: EngineState,
): void {
  checkSummary(summary, state.config);
  check(isScoredOutcome(summary.outcome), "invalidSummary");
  check(summary.dealer === state.dealer, "invalidSummary");
  const last = state.matchLog[state.matchLog.length - 1];
  check(last !== undefined && jsonEqual(last, summary), "invalidSummary");
  check(summaryTokensMatch(summary, state), "invalidTokens");
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
      checkPlayProgress(state, match, contract);
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
  checkRoundResults(match);

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

  checkSurrender(state, match, phase);

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
 * design §9.5–§9.6: each finished round's stored winner is the seat the rules
 * pick from its cards, and `trumpPlayed` says exactly whether a finished
 * round held a card that counted as trump. In 28 a hidden suit counts only
 * from the reveal round onward. Rounds exist only once a contract does.
 * Must run after the rounds' play counts are checked.
 */
function checkRoundResults(match: MatchState): void {
  const { contract, revealedInRound } = match;
  if (contract === null) {
    check(match.rounds.length === 0 && !match.trumpPlayed, "invalidRound");
    return;
  }
  let trumpPlayed = false;
  match.rounds.forEach((round, index) => {
    const revealed = revealedInRound !== null && index >= revealedInRound;
    check(
      round.winner === roundWinner(round, contract, revealed),
      "invalidRound",
    );
    const trump = countingTrumpSuit(contract, revealed);
    trumpPlayed ||= round.plays.some((play) => play.card.suit === trump);
  });
  check(match.trumpPlayed === trumpPlayed, "invalidRound");
}

/**
 * design §10.1: surrender state exists only in play with the option on.
 * `decided` is exactly the certain losing team: the check runs after every
 * round and points change only when a round is won, so between actions it
 * always matches the arithmetic. A running vote belongs to that team, counts
 * the proposer as yes and each seat once, and is still open (a vote that
 * passes or fails is settled within the same action). A failed vote's round
 * is the current round or an earlier one.
 */
function checkSurrender(
  state: EngineState,
  match: MatchState,
  phase: "auction" | "placingCard" | "play",
): void {
  const { playerCount } = state.config;
  const { decided, vote, lastFailedRound } = match.surrender;
  if (vote !== null) {
    checkSeat(vote.proposer, playerCount);
    for (const seat of [...vote.yes, ...vote.no]) {
      checkSeat(seat, playerCount);
    }
  }

  if (phase !== "play" || state.config.surrenderOption !== "on") {
    check(
      decided === null && vote === null && lastFailedRound === null,
      "invalidSurrender",
    );
    return;
  }

  check(decided === losingTeamIfCertain(state), "invalidSurrender");
  if (vote !== null) {
    const voters = [...vote.yes, ...vote.no];
    check(
      decided !== null &&
        vote.yes.includes(vote.proposer) &&
        new Set(voters).size === voters.length &&
        voters.every((seat) => teamOf(seat) === decided) &&
        surrenderVoteStatus(vote, playerCount) === "open",
      "invalidSurrender",
    );
  }
  if (lastFailedRound !== null) {
    check(
      decided !== null &&
        isNonNegativeWholeNumber(lastFailedRound) &&
        lastFailedRound <= match.rounds.length,
      "invalidSurrender",
    );
  }
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
            auction.highBid !== null &&
            !hasSecondAuction(auction.redoubled, auction.highBid.amount),
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
  // A carried bid comes from a first auction that wasn't redoubled (a
  // redouble skips the second auction) and left room to overbid.
  check(
    (!carriedBid.bid.forced || carriedBid.doubledBy === null) &&
      hasSecondAuction(false, carriedBid.bid.amount),
    "invalidAuctionState",
  );
  if (phase === "auction") {
    // rules §10.2: while the second auction runs, the first-auction
    // face-down card stays face down with its owner, whatever has been
    // called since; only the auction's end returns it (design §8.4). A
    // carried forced 14 no trump never had one.
    check(
      carriedBid.bid.forced
        ? match.faceDown === null
        : match.faceDown?.owner === carriedBid.bid.seat,
      "invalidAuctionState",
    );
  }
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

/**
 * design §6.3, §9: the current round's lead suit and reveal-turn flags, the
 * reveal round, forced face-down plays, and per-seat card counts during play.
 */
function checkPlayProgress(
  state: EngineState,
  match: MatchState,
  contract: Contract,
): void {
  const { playerCount } = state.config;
  const current = match.currentRound;
  if (current === null) {
    return;
  }
  const roundNumber = match.rounds.length;

  check(
    current.leadSuit === (current.plays[0]?.card.suit ?? null),
    "invalidRound",
  );

  // A reveal happens in a 28 hidden-trump match, returns the face-down
  // card, and marks the round it happened in.
  const { revealedInRound } = match;
  if (revealedInRound !== null) {
    check(
      contract.trump.type === "hidden" &&
        match.faceDown === null &&
        isNonNegativeWholeNumber(revealedInRound) &&
        revealedInRound <= roundNumber,
      "invalidReveal",
    );
  }
  check(
    current.revealedThisRound === (revealedInRound === roundNumber),
    "invalidReveal",
  );
  // The asker asked on its own turn in this, the reveal round: it is still
  // that seat's turn or the seat has since played.
  if (current.revealAskedBy !== null) {
    check(
      current.revealedThisRound &&
        (current.turn === current.revealAskedBy ||
          current.plays.some((play) => play.seat === current.revealAskedBy)),
      "invalidReveal",
    );
  }

  // design §9.3: only the bidder's forced play, in the reveal round, comes
  // from face-down storage.
  const roundsWithPlays = [...match.rounds, current];
  roundsWithPlays.forEach((round, index) => {
    for (const play of round.plays) {
      if (play.fromFaceDown) {
        check(
          contract.trump.type === "hidden" &&
            play.seat === contract.bidder &&
            play.card.suit === contract.trump.suit &&
            index === revealedInRound,
          "invalidReveal",
        );
      }
    }
  });

  // Every seat plays one card per round: what it still holds (including a
  // face-down card) plus this round's play is a full holding less the
  // finished rounds.
  const cardsPerSeat = buildDeck(state.config).length / playerCount;
  for (let seat = 0; seat < playerCount; seat += 1) {
    const held =
      (match.hands[seat]?.length ?? 0) +
      (match.faceDown?.owner === seat ? 1 : 0) +
      (current.plays.some((play) => play.seat === seat) ? 1 : 0);
    check(held === cardsPerSeat - roundNumber, "invalidRound");
  }
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

  const { startingTokens } = state.config;
  checkBalances(state.tokens, startingTokens);

  for (const summary of state.matchLog) {
    checkSummary(summary, state.config);
  }
  for (const past of state.pastSessions) {
    // design §10.4: an archived session ended with its loser at 0 tokens.
    checkBalances(past.tokens, startingTokens);
    check(
      isTeam(past.winner) &&
        past.tokens[past.winner] > 0 &&
        past.tokens[past.winner === "A" ? "B" : "A"] === 0,
      "invalidTokens",
    );
  }

  const phase = state.phase;
  // design §10.4: only a finished session has a team at 0 tokens.
  check(
    phase.type === "sessionOver" || (state.tokens.A > 0 && state.tokens.B > 0),
    "invalidTokens",
  );
  switch (phase.type) {
    case "awaitingDeal":
      // design §10.4: a first deal follows a session start or restart, before
      // any result has been logged or any token has moved.
      if (phase.reason === "firstDeal") {
        check(state.matchLog.length === 0, "invalidSummary");
        check(
          state.tokens.A === startingTokens &&
            state.tokens.B === startingTokens,
          "invalidTokens",
        );
      }
      return;
    case "auction":
    case "placingCard":
    case "play":
      checkMatch(state, phase.match, phase.type);
      return;
    case "matchOver":
      // design §10.4: a scored match with no team at 0 tokens.
      checkFinishedMatchSummary(phase.summary, state);
      return;
    case "sessionOver":
      // design §10.4: a team reached 0 tokens; the other team wins.
      checkFinishedMatchSummary(phase.summary, state);
      check(
        state.tokens[phase.winner] > 0 &&
          state.tokens[phase.winner === "A" ? "B" : "A"] === 0,
        "invalidTokens",
      );
      return;
    default:
      assertNever(phase, "assertEngineInvariants");
  }
}
