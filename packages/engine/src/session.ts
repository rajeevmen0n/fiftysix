import { validateConfig } from "./config.js";
import type { SessionStartedEvent } from "./events.js";
import { type EngineRejection, reject } from "./result.js";
import { isSeatInRange } from "./seats.js";
import type { EngineState } from "./state.js";
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
    return reject("invalidSeat", {
      field: "firstDealer",
      minimum: 0,
      maximum: config.playerCount - 1,
    });
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
