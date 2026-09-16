import type { EngineEvent, MatchEndedEvent } from "./events.js";
import { assertNever } from "./result.js";
import { teamOf } from "./seats.js";
import { multiplyStake, stakeFor, transferTokens } from "./stakes.js";
import type {
  Contract,
  EngineState,
  MatchOutcome,
  MatchSummary,
  ScoredOutcome,
  SummaryContract,
  TokenMovement,
} from "./state.js";
import type { Team, TokenBalances } from "./types.js";

// Match results and token transfers (design §10.3, rules §7), plus the one
// place canonical match summaries are built for every outcome: scored
// results, host restarts, and automatic redeals.

export type { ScoredOutcome } from "./state.js";

function otherTeam(team: Team): Team {
  return team === "A" ? "B" : "A";
}

/**
 * Design §10.3: the public summary form of a contract. A 28 trump that was
 * never revealed keeps neither its suit nor its card; a revealed one is
 * public and is recorded as its suit.
 */
export function summaryContract(
  contract: Contract,
  trumpRevealed: boolean,
): SummaryContract {
  const { trump } = contract;
  return {
    bidder: contract.bidder,
    team: contract.team,
    amount: contract.amount,
    trump:
      trump.type === "hidden"
        ? trumpRevealed
          ? { type: "suit", suit: trump.suit }
          : { type: "hidden" }
        : trump.type === "suit"
          ? { type: "suit", suit: trump.suit }
          : { type: "noTrump" },
    style: contract.style,
    multiplier: contract.multiplier,
    forced: contract.forced,
  };
}

function cloneOutcome(outcome: MatchOutcome): MatchOutcome {
  switch (outcome.type) {
    case "made":
    case "failed":
    case "restarted":
      return { type: outcome.type };
    case "disqualified":
      return { type: outcome.type, seat: outcome.seat, kind: outcome.kind };
    case "surrendered":
    case "awarded":
      return { type: outcome.type, team: outcome.team };
    case "redealt":
      return {
        type: outcome.type,
        reason:
          outcome.reason.type === "teamWithoutJack"
            ? { type: "teamWithoutJack", team: outcome.reason.team }
            : {
                type: "lowHand",
                seat: outcome.reason.seat,
                points: outcome.reason.points,
              },
      };
    default:
      return assertNever(outcome, "cloneOutcome");
  }
}

/** A deep copy, so state never retains an object owned by an event's holder. */
export function cloneMatchSummary(summary: MatchSummary): MatchSummary {
  const { contract } = summary;
  return {
    dealer: summary.dealer,
    contract:
      contract === null ? null : { ...contract, trump: { ...contract.trump } },
    points: { A: summary.points.A, B: summary.points.B },
    tokensMoved:
      summary.tokensMoved === null
        ? null
        : {
            payer: summary.tokensMoved.payer,
            amount: summary.tokensMoved.amount,
          },
    tokens: { A: summary.tokens.A, B: summary.tokens.B },
    outcome: cloneOutcome(summary.outcome),
  };
}

/**
 * Design §10.3: the canonical summary of the match currently in `state`.
 * The dealer, contract, and collected points come from `state`; with no
 * match in progress (a 56 redeal decided from `awaitingDeal`) the contract
 * is null and the points are zero. The contract is the summary form, so an
 * unrevealed 28 trump is erased before any summary is emitted or stored.
 */
export function matchSummary(
  state: EngineState,
  outcome: MatchOutcome,
  tokensMoved: TokenMovement | null,
  tokens: TokenBalances,
): MatchSummary {
  const { phase } = state;
  const match = "match" in phase ? phase.match : null;
  const contract = match?.contract ?? null;
  return {
    dealer: state.dealer,
    contract:
      match === null || contract === null
        ? null
        : summaryContract(contract, match.revealedInRound !== null),
    points: {
      A: match?.points.A ?? 0,
      B: match?.points.B ?? 0,
    },
    tokensMoved:
      tokensMoved === null
        ? null
        : { payer: tokensMoved.payer, amount: tokensMoved.amount },
    tokens: { A: tokens.A, B: tokens.B },
    outcome: cloneOutcome(outcome),
  };
}

interface Payment {
  payer: Team;
  stake: "win" | "loss";
}

/** Design §10.3 "Who pays". */
function paymentFor(contract: Contract, outcome: ScoredOutcome): Payment {
  const bidding = contract.team;
  const biddingTeamPays: Payment = { payer: bidding, stake: "loss" };
  const defendersPay: Payment = { payer: otherTeam(bidding), stake: "win" };

  switch (outcome.type) {
    case "made":
      return defendersPay;
    case "failed":
      return biddingTeamPays;
    case "disqualified":
      return teamOf(outcome.seat) === bidding ? biddingTeamPays : defendersPay;
    case "surrendered":
      return outcome.team === bidding ? biddingTeamPays : defendersPay;
    case "awarded":
      return outcome.team === bidding ? defendersPay : biddingTeamPays;
    default:
      return assertNever(outcome, "paymentFor");
  }
}

/**
 * Design §10.2–§10.4, rules §7: scores the match in `play` with `outcome`.
 *
 * The stake is the contract tier's win or loss stake times its multiplier,
 * paid by the team design §10.3 names. The payer pays at most what it holds;
 * the summary records the amount that actually moved and the balances after
 * it. Emits `matchEnded(summary)`, then `sessionEnded(winner)` when either
 * team is left with 0 tokens.
 *
 * `state` must already reflect everything that happened before the result
 * (for `made`/`failed`, the final round's points). Calling this for a state
 * that is not in play, or with a `made`/`failed` outcome its points
 * contradict, is an engine bug and throws.
 */
export function scoreMatch(
  state: EngineState,
  outcome: ScoredOutcome,
): EngineEvent[] {
  const { phase } = state;
  if (phase.type !== "play" || phase.match.contract === null) {
    throw new Error("scoreMatch: expected a match in play with a contract");
  }
  const { match } = phase;
  const contract = match.contract as Contract;

  if (outcome.type === "made" || outcome.type === "failed") {
    const made = match.points[contract.team] >= contract.amount;
    if (made !== (outcome.type === "made")) {
      throw new Error(
        `scoreMatch: outcome ${outcome.type} contradicts the bidding team's points`,
      );
    }
  }

  const { payer, stake } = paymentFor(contract, outcome);
  const tier = stakeFor(state.config, contract.amount);
  const owed = multiplyStake(
    stake === "win" ? tier.winStake : tier.lossStake,
    contract.multiplier,
  );
  const transfer = transferTokens(state.tokens, payer, owed);

  const matchEnded: MatchEndedEvent = {
    type: "matchEnded",
    summary: matchSummary(
      state,
      outcome,
      { payer, amount: transfer.amount },
      transfer.balances,
    ),
  };
  const events: EngineEvent[] = [matchEnded];

  // design §10.4: a team at 0 tokens has lost the session.
  if (transfer.balances.A === 0 || transfer.balances.B === 0) {
    events.push({
      type: "sessionEnded",
      winner: transfer.balances.A === 0 ? "B" : "A",
    });
  }
  return events;
}
