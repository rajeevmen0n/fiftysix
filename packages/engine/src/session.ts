import type { EngineAction } from "./actions.js";
import { validateConfig } from "./config.js";
import type {
  MatchEndedEvent,
  NextMatchStartedEvent,
  SessionEndedEvent,
  SessionRestartedEvent,
  SessionStartedEvent,
} from "./events.js";
import {
  accept,
  assertNever,
  type Decision,
  type EngineRejection,
  reject,
} from "./result.js";
import { cloneMatchSummary } from "./scoring.js";
import { isSeatInRange, nextSeat } from "./seats.js";
import type { EnginePhase, EngineState } from "./state.js";
import type { EngineConfig, Seat } from "./types.js";

function copyConfig(config: EngineConfig): EngineConfig {
  return {
    gameType: config.gameType,
    playerCount: config.playerCount,
    includeEightsAndSevens: config.includeEightsAndSevens,
    illegalPlayMode: config.illegalPlayMode,
    startingTokens: config.startingTokens,
    stakeTiers: config.stakeTiers.map((tier) => ({
      fromBid: tier.fromBid,
      toBid: tier.toBid,
      winStake: tier.winStake,
      lossStake: tier.lossStake,
    })),
    redealThreshold: config.redealThreshold,
    surrenderOption: config.surrenderOption,
  };
}

function firstDealerRejection(playerCount: number): EngineRejection {
  return reject("invalidSeat", {
    field: "firstDealer",
    minimum: 0,
    maximum: playerCount - 1,
  });
}

export type SessionStart =
  | { ok: true; seed: EngineState; event: SessionStartedEvent }
  | EngineRejection;

/**
 * Validates `newSession` inputs and returns the single `sessionStarted` event
 * plus a config-carrying seed state for it to evolve. The seed's other fields
 * are fully replaced by the event.
 */
export function decideSessionStart(
  config: EngineConfig,
  firstDealer: Seat,
): SessionStart {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      code: "invalidConfig",
      details: { issues: ["config must be an object"] },
    };
  }

  const configRejection = validateConfig(config);
  if (configRejection !== null) {
    return configRejection;
  }

  if (!isSeatInRange(firstDealer, config.playerCount)) {
    return firstDealerRejection(config.playerCount);
  }

  const ownedConfig = copyConfig(config);
  return {
    ok: true,
    seed: {
      config: ownedConfig,
      tokens: { A: ownedConfig.startingTokens, B: ownedConfig.startingTokens },
      dealer: firstDealer,
      matchLog: [],
      pastSessions: [],
      phase: { type: "awaitingDeal", reason: "firstDeal" },
    },
    event: {
      type: "sessionStarted",
      firstDealer,
      tokens: { A: ownedConfig.startingTokens, B: ownedConfig.startingTokens },
    },
  };
}

/**
 * design §10.4: the system actions between matches and sessions.
 *
 * - `startNextMatch`, only from `matchOver`: the deal passes to the dealer's
 *   right (rules §2), which is the next seat counter-clockwise, `dealer + 1`
 *   (design §2). Emits `nextMatchStarted(dealer)`.
 * - `restartSession(firstDealer)`, only from `sessionOver`, with a seat in
 *   range: emits `sessionRestarted(firstDealer)`.
 *
 * Like the other deciders this re-validates the action type and phase for
 * direct callers but not `decide()`'s source checks.
 */
export function decideSessionAction(
  state: EngineState,
  action: EngineAction,
): Decision {
  const { phase, config } = state;
  switch (action.type) {
    case "startNextMatch":
      if (phase.type !== "matchOver") {
        return reject("actionNotAllowed", {
          action: action.type,
          phase: phase.type,
        });
      }
      return accept([
        {
          type: "nextMatchStarted",
          dealer: nextSeat(state.dealer, config.playerCount),
        },
      ]);
    case "restartSession": {
      if (phase.type !== "sessionOver") {
        return reject("actionNotAllowed", {
          action: action.type,
          phase: phase.type,
        });
      }
      const firstDealer: unknown = action.firstDealer;
      if (!isSeatInRange(firstDealer, config.playerCount)) {
        return firstDealerRejection(config.playerCount);
      }
      return accept([{ type: "sessionRestarted", firstDealer }]);
    }
    default:
      return reject("actionNotAllowed", { action: action.type });
  }
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of recovering from a misordered log).

function withPhase(
  state: EngineState,
  fields: Pick<EngineState, "tokens" | "dealer" | "matchLog" | "phase">,
): EngineState {
  return {
    config: state.config,
    tokens: fields.tokens,
    dealer: fields.dealer,
    matchLog: fields.matchLog,
    pastSessions: state.pastSessions,
    phase: fields.phase,
  };
}

export function evolveSessionStarted(
  state: EngineState,
  event: SessionStartedEvent,
): EngineState {
  return {
    config: state.config,
    tokens: { A: event.tokens.A, B: event.tokens.B },
    dealer: event.firstDealer,
    matchLog: [],
    pastSessions: [],
    phase: { type: "awaitingDeal", reason: "firstDeal" },
  };
}

function isMatchPhase(phase: EnginePhase): boolean {
  return (
    phase.type === "auction" ||
    phase.type === "placingCard" ||
    phase.type === "play"
  );
}

/**
 * Design §7.1, §10.2–§10.4: ends the match in progress.
 *
 * - Scored outcomes (`made`, `failed`, `disqualified`, `surrendered`,
 *   `awarded`) end play: the summary's balances become the session's, the
 *   summary is appended to `matchLog`, and the phase becomes
 *   `matchOver(summary)`. A following `sessionEnded` in the same action moves
 *   it on to `sessionOver`.
 * - `restarted` (host End match) is always logged; no tokens move and the
 *   same dealer awaits a new deck in `awaitingDeal(restart)`.
 * - `redealt` (automatic): a 56 redeal is a transient notice and is not
 *   appended to `matchLog`; a 28 redeal is appended because its first
 *   auction already occurred. The same dealer awaits `awaitingDeal(redeal)`.
 *
 * The match state, including any running surrender vote, is discarded. The
 * stored summary is a copy, so a caller mutating the event can't reach state.
 */
export function evolveMatchEnded(
  state: EngineState,
  event: MatchEndedEvent,
): EngineState {
  const summary = cloneMatchSummary(event.summary);
  const { outcome } = summary;

  switch (outcome.type) {
    case "made":
    case "failed":
    case "disqualified":
    case "surrendered":
    case "awarded":
      if (state.phase.type !== "play") {
        throw new Error(
          `Cannot apply matchEnded(${outcome.type}) event: expected phase "play", got "${state.phase.type}"`,
        );
      }
      return withPhase(state, {
        tokens: { A: summary.tokens.A, B: summary.tokens.B },
        dealer: state.dealer,
        matchLog: [...state.matchLog, summary],
        phase: { type: "matchOver", summary },
      });
    case "restarted":
      if (!isMatchPhase(state.phase)) {
        throw new Error(
          `Cannot apply matchEnded(restarted) event: expected a match in progress, got "${state.phase.type}"`,
        );
      }
      return withPhase(state, {
        tokens: state.tokens,
        dealer: state.dealer,
        matchLog: [...state.matchLog, summary],
        phase: { type: "awaitingDeal", reason: "restart" },
      });
    case "redealt":
      if (!isMatchPhase(state.phase)) {
        throw new Error(
          `Cannot apply matchEnded(redealt) event: expected a match in progress, got "${state.phase.type}"`,
        );
      }
      return withPhase(state, {
        tokens: { A: summary.tokens.A, B: summary.tokens.B },
        dealer: summary.dealer,
        matchLog:
          state.config.gameType === "28"
            ? [...state.matchLog, summary]
            : state.matchLog,
        phase: { type: "awaitingDeal", reason: "redeal" },
      });
    default:
      return assertNever(outcome, "evolveMatchEnded");
  }
}

/** Design §10.4: a scored match left a team at 0 tokens. */
export function evolveSessionEnded(
  state: EngineState,
  event: SessionEndedEvent,
): EngineState {
  const { phase } = state;
  if (phase.type !== "matchOver") {
    throw new Error(
      `Cannot apply sessionEnded event: expected phase "matchOver", got "${phase.type}"`,
    );
  }
  return withPhase(state, {
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    phase: {
      type: "sessionOver",
      winner: event.winner,
      summary: phase.summary,
    },
  });
}

/** Design §10.4: the next dealer awaits a new deck. */
export function evolveNextMatchStarted(
  state: EngineState,
  event: NextMatchStartedEvent,
): EngineState {
  if (state.phase.type !== "matchOver") {
    throw new Error(
      `Cannot apply nextMatchStarted event: expected phase "matchOver", got "${state.phase.type}"`,
    );
  }
  return withPhase(state, {
    tokens: state.tokens,
    dealer: event.dealer,
    matchLog: state.matchLog,
    phase: { type: "awaitingDeal", reason: "nextMatch" },
  });
}

/**
 * Design §10.4: archives the finished session's winner and final tokens,
 * resets balances to the starting tokens, clears the match log, and awaits
 * the first deal from the supplied dealer.
 */
export function evolveSessionRestarted(
  state: EngineState,
  event: SessionRestartedEvent,
): EngineState {
  const { phase } = state;
  if (phase.type !== "sessionOver") {
    throw new Error(
      `Cannot apply sessionRestarted event: expected phase "sessionOver", got "${phase.type}"`,
    );
  }
  const { startingTokens } = state.config;
  return {
    config: state.config,
    tokens: { A: startingTokens, B: startingTokens },
    dealer: event.firstDealer,
    matchLog: [],
    pastSessions: [
      ...state.pastSessions,
      {
        winner: phase.winner,
        tokens: { A: state.tokens.A, B: state.tokens.B },
      },
    ],
    phase: { type: "awaitingDeal", reason: "firstDeal" },
  };
}
