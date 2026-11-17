import type { EngineAction, SurrenderVoteChoice } from "./actions.js";
import type {
  EngineEvent,
  ResultDecidedEvent,
  SurrenderedEvent,
  SurrenderFailedEvent,
  SurrenderProposedEvent,
  SurrenderVotedEvent,
} from "./events.js";
import { accept, assertNever, type Decision, reject } from "./result.js";
import { scoreMatch } from "./scoring.js";
import { teamOf } from "./seats.js";
import type { EngineState, MatchState, SurrenderVote } from "./state.js";
import type { EngineConfig, Seat, Team } from "./types.js";

// Result certainty and the surrender vote (design §10.1, design.md §5).
//
// When the room's surrender option is on, the result becomes certain after
// a round once the bidding team has made its bid, or can no longer reach it
// with the points not yet collected. The losing team is then told (the
// `resultDecided` event, redacted to that team) and any of its members may
// propose surrendering. The proposal pauses play and opens a vote among the
// losing team only; it passes with more than half of the team voting yes and
// the match is scored as surrendered, or fails as soon as passing becomes
// impossible, after which play resumes and no new proposal is allowed until
// the next round.

/**
 * rules §3, §10.1: every deck adds up to 56 points in 56 (with or without
 * the 8s and 7s) and 28 in 28.
 */
export function totalPoints(config: EngineConfig): number {
  return config.gameType === "56" ? 56 : 28;
}

/**
 * design §10.1: the team that has certainly lost the match in play, or null
 * while the result is still open.
 *
 * - The bidding team's points are at least the contract amount: the
 *   **defenders** have lost.
 * - The bidding team's points plus every point not yet collected (the cards
 *   still in hands, face down, and in the current round) are less than the
 *   amount: the **bidding team** has lost.
 *
 * This is the arithmetic only; it ignores the room's surrender option, which
 * gates whether certainty is recorded and announced. Points change only when
 * a round is won and only grow, so once certain a match stays certain for
 * the same team. Outside play (or before a contract exists) it is null.
 */
export function losingTeamIfCertain(state: EngineState): Team | null {
  const { phase } = state;
  if (phase.type !== "play" || phase.match.contract === null) {
    return null;
  }
  const { contract, points } = phase.match;
  const defenders: Team = contract.team === "A" ? "B" : "A";
  const bidding = points[contract.team];
  if (bidding >= contract.amount) {
    return defenders;
  }
  const uncollected = totalPoints(state.config) - points.A - points.B;
  return bidding + uncollected < contract.amount ? contract.team : null;
}

/**
 * design §5: yes votes needed for a surrender to pass, more than half of
 * the losing team: 2 of 2, 2 of 3, or 3 of 4.
 */
export function surrenderVotesNeeded(playerCount: number): number {
  const teamSize = playerCount / 2;
  return Math.floor(teamSize / 2) + 1;
}

export type SurrenderVoteStatus = "open" | "passed" | "failed";

/**
 * design §10.1, checked after each vote: passed once the yes votes reach
 * the threshold, failed as soon as the yes votes plus the votes still
 * outstanding can no longer reach it, otherwise still open.
 */
export function surrenderVoteStatus(
  vote: SurrenderVote,
  playerCount: number,
): SurrenderVoteStatus {
  const needed = surrenderVotesNeeded(playerCount);
  const teamSize = playerCount / 2;
  const outstanding = teamSize - vote.yes.length - vote.no.length;
  if (vote.yes.length >= needed) {
    return "passed";
  }
  return vote.yes.length + outstanding < needed ? "failed" : "open";
}

/**
 * design §9.6, §10.1: the certainty check that runs after every round, on a
 * state that already reflects the round's `roundWon`. Emits
 * `resultDecided(losingTeam)` the first time the result is certain, and only
 * when the surrender option is on; nothing once it has been recorded.
 */
export function resultCertaintyEvents(
  state: EngineState,
): ResultDecidedEvent[] {
  const { phase } = state;
  if (
    state.config.surrenderOption !== "on" ||
    phase.type !== "play" ||
    phase.match.surrender.decided !== null
  ) {
    return [];
  }
  const losingTeam = losingTeamIfCertain(state);
  return losingTeam === null ? [] : [{ type: "resultDecided", losingTeam }];
}

// ---------------------------------------------------------------------------
// Decisions

/** A match in play between rounds' plays (never the transient null round). */
function playMatch(state: EngineState): MatchState | null {
  const { phase } = state;
  return phase.type === "play" &&
    phase.match.contract !== null &&
    phase.match.currentRound !== null
    ? phase.match
    : null;
}

function isVoteChoice(value: unknown): value is SurrenderVoteChoice {
  return value === "yes" || value === "no";
}

/**
 * Applies this module's own events, so a decider can score the state they
 * lead to without importing the engine router.
 */
function applySurrenderEvents(
  state: EngineState,
  events: readonly EngineEvent[],
): EngineState {
  let next = state;
  for (const event of events) {
    switch (event.type) {
      case "surrenderVoted":
        next = evolveSurrenderVoted(next, event);
        break;
      case "surrendered":
        next = evolveSurrendered(next, event);
        break;
      case "surrenderFailed":
        next = evolveSurrenderFailed(next, event);
        break;
      default:
        throw new Error(`applySurrenderEvents: unexpected ${event.type} event`);
    }
  }
  return next;
}

/**
 * design §10.1: `proposeSurrender` from any seat of the losing team, on or
 * off its turn, once the result is certain, while no vote runs, and not in a
 * round in which a vote already failed. The proposer counts as a yes vote
 * and play is paused. A proposal never settles a vote by itself: with at
 * least two seats per team, one yes vote is short of more than half and
 * leaves the rest able to reach it.
 *
 * While no vote runs, a seat that isn't on the losing team gets the same
 * `resultNotDecided` rejection whether or not the result is certain, so the
 * rejection never tells the winning team what only the losing team is told
 * (design §11.2). A running vote is public, so then it gets
 * `notOnLosingTeam`.
 */
function decidePropose(match: MatchState, seat: Seat): Decision {
  const { decided, vote, lastFailedRound } = match.surrender;
  if (vote !== null && decided !== null && teamOf(seat) !== decided) {
    return reject("actionNotAllowed", {
      action: "proposeSurrender",
      reason: "notOnLosingTeam",
    });
  }
  if (decided === null || teamOf(seat) !== decided) {
    return reject("actionNotAllowed", {
      action: "proposeSurrender",
      reason: "resultNotDecided",
    });
  }
  if (vote !== null) {
    return reject("surrenderVoteRunning", {});
  }
  if (lastFailedRound === match.rounds.length) {
    return reject("actionNotAllowed", {
      action: "proposeSurrender",
      reason: "failedThisRound",
    });
  }
  const proposed: SurrenderProposedEvent = { type: "surrenderProposed", seat };
  return accept([proposed]);
}

/**
 * design §10.1: `voteSurrender(yes | no)`, once, from each losing-team seat
 * other than the proposer while a vote runs. A vote that reaches more than
 * half of the team passes: `surrendered(team)` and the match is scored with
 * outcome `surrendered`, the losing team paying its side's stake. A vote
 * that can no longer pass fails: `surrenderFailed`, and play resumes.
 */
function decideVote(
  state: EngineState,
  match: MatchState,
  seat: Seat,
  choice: unknown,
): Decision {
  if (!isVoteChoice(choice)) {
    return reject("actionNotAllowed", {
      action: "voteSurrender",
      reason: "invalidVote",
    });
  }
  const { decided, vote } = match.surrender;
  if (vote === null || decided === null) {
    return reject("actionNotAllowed", {
      action: "voteSurrender",
      reason: "noVoteRunning",
    });
  }
  if (teamOf(seat) !== decided) {
    return reject("actionNotAllowed", {
      action: "voteSurrender",
      reason: "notOnLosingTeam",
    });
  }
  if (vote.yes.includes(seat) || vote.no.includes(seat)) {
    return reject("actionNotAllowed", {
      action: "voteSurrender",
      reason: "alreadyVoted",
    });
  }

  const voted: SurrenderVotedEvent = {
    type: "surrenderVoted",
    seat,
    vote: choice,
  };
  const afterVote = applySurrenderEvents(state, [voted]);
  const counted = playMatch(afterVote)?.surrender.vote;
  if (counted === null || counted === undefined) {
    throw new Error("decideVote: expected the vote to still be running");
  }

  const status = surrenderVoteStatus(counted, state.config.playerCount);
  switch (status) {
    case "open":
      return accept([voted]);
    case "failed": {
      const failed: SurrenderFailedEvent = { type: "surrenderFailed" };
      return accept([voted, failed]);
    }
    case "passed": {
      const surrendered: SurrenderedEvent = {
        type: "surrendered",
        team: decided,
      };
      const stopped = applySurrenderEvents(afterVote, [surrendered]);
      return accept([
        voted,
        surrendered,
        ...scoreMatch(stopped, { type: "surrendered", team: decided }),
      ]);
    }
    default:
      return assertNever(status, "decideVote");
  }
}

/**
 * design §10.1: `proposeSurrender` and `voteSurrender` from a seat, in play.
 *
 * Rejections: code `surrenderVoteRunning` for a losing-team proposal during
 * a vote; otherwise `actionNotAllowed` with a `reason`: `surrenderOff` when
 * the room's option is off, `resultNotDecided`, `failedThisRound`,
 * `invalidVote`, `noVoteRunning`, `notOnLosingTeam`, and `alreadyVoted`.
 *
 * Event orders:
 * - proposal: `surrenderProposed`.
 * - vote still open: `surrenderVoted`.
 * - vote failed: `surrenderVoted`, `surrenderFailed`.
 * - vote passed: `surrenderVoted`, `surrendered`, `matchEnded(surrendered)`,
 *   and possibly `sessionEnded`.
 *
 * Host End match stays available during a vote (design §10.2); its
 * `matchEnded` discards the vote with the match. Like the other deciders
 * this re-validates the action type and phase for direct callers but not
 * `decide()`'s source checks.
 */
export function decideSurrenderAction(
  state: EngineState,
  action: EngineAction,
): Decision {
  if (action.type !== "proposeSurrender" && action.type !== "voteSurrender") {
    return reject("actionNotAllowed", { action: action.type });
  }
  const match = playMatch(state);
  if (match === null) {
    return reject("actionNotAllowed", {
      action: action.type,
      phase: state.phase.type,
    });
  }
  if (state.config.surrenderOption !== "on") {
    return reject("actionNotAllowed", {
      action: action.type,
      reason: "surrenderOff",
    });
  }
  const seat = action.source.seat;
  return action.type === "proposeSurrender"
    ? decidePropose(match, seat)
    : decideVote(state, match, seat, action.vote as unknown);
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of recovering from a misordered log).

function withPlayMatch(state: EngineState, match: MatchState): EngineState {
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "play", match },
  };
}

function matchInPlay(state: EngineState, event: EngineEvent): MatchState {
  const { phase } = state;
  if (phase.type !== "play" || phase.match.contract === null) {
    throw new Error(
      `Cannot apply ${event.type} event: expected a match in play`,
    );
  }
  return phase.match;
}

/**
 * design §10.1: records the certain losing team for the rest of the match.
 * Follows a `roundWon` in the same action, including the last round's, when
 * `currentRound` is transiently null before `matchEnded`.
 */
export function evolveResultDecided(
  state: EngineState,
  event: ResultDecidedEvent,
): EngineState {
  const match = matchInPlay(state, event);
  if (match.surrender.decided !== null) {
    throw new Error(
      "Cannot apply resultDecided event: the result was already decided",
    );
  }
  return withPlayMatch(state, {
    ...match,
    surrender: { ...match.surrender, decided: event.losingTeam },
  });
}

/** design §10.1: opens a vote with the proposer counted as yes; play pauses. */
export function evolveSurrenderProposed(
  state: EngineState,
  event: SurrenderProposedEvent,
): EngineState {
  const match = matchInPlay(state, event);
  if (
    match.currentRound === null ||
    match.surrender.decided === null ||
    match.surrender.vote !== null
  ) {
    throw new Error(
      "Cannot apply surrenderProposed event: expected a decided result with no vote running",
    );
  }
  return withPlayMatch(state, {
    ...match,
    surrender: {
      ...match.surrender,
      vote: { proposer: event.seat, yes: [event.seat], no: [] },
    },
  });
}

/** design §10.1: counts one seat's vote. */
export function evolveSurrenderVoted(
  state: EngineState,
  event: SurrenderVotedEvent,
): EngineState {
  const match = matchInPlay(state, event);
  const { vote } = match.surrender;
  if (
    vote === null ||
    vote.yes.includes(event.seat) ||
    vote.no.includes(event.seat)
  ) {
    throw new Error(
      "Cannot apply surrenderVoted event: expected a running vote that seat has not voted in",
    );
  }
  return withPlayMatch(state, {
    ...match,
    surrender: {
      ...match.surrender,
      vote: {
        proposer: vote.proposer,
        yes: event.vote === "yes" ? [...vote.yes, event.seat] : vote.yes,
        no: event.vote === "no" ? [...vote.no, event.seat] : vote.no,
      },
    },
  });
}

/**
 * design §10.1: the vote ends without passing. Play resumes, and no new
 * proposal is allowed until the next round.
 */
export function evolveSurrenderFailed(
  state: EngineState,
  event: SurrenderFailedEvent,
): EngineState {
  const match = matchInPlay(state, event);
  if (match.surrender.vote === null || match.currentRound === null) {
    throw new Error(
      "Cannot apply surrenderFailed event: expected a running vote",
    );
  }
  return withPlayMatch(state, {
    ...match,
    surrender: {
      ...match.surrender,
      vote: null,
      lastFailedRound: match.rounds.length,
    },
  });
}

/**
 * design §10.1: the vote passed and the losing team surrendered. The state
 * is unchanged; the `matchEnded(surrendered)` that follows in the same
 * action scores and ends the match, discarding the vote.
 */
export function evolveSurrendered(
  state: EngineState,
  event: SurrenderedEvent,
): EngineState {
  const match = matchInPlay(state, event);
  if (match.surrender.vote === null || match.surrender.decided !== event.team) {
    throw new Error(
      "Cannot apply surrendered event: expected a running vote of the losing team",
    );
  }
  return state;
}
