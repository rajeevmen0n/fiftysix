import type { AuctionStage } from "./state.js";
import type { ConfigRejection, EngineConfig, StakeTier } from "./types.js";

const WHOLE_NUMBER_MAX = 999;

/**
 * Rules §4.2/§10.2, design §8.2: the amount range of each auction stage. The
 * 56 and 28 first-auction minimums are also the forced bid (rules §4.3). A
 * 28 second-auction bid must additionally beat the carried bid.
 */
export const AUCTION_BID_LIMITS: Readonly<
  Record<AuctionStage, Readonly<{ minimum: number; maximum: number }>>
> = {
  "56": { minimum: 28, maximum: 56 },
  "28-first": { minimum: 14, maximum: 28 },
  "28-second": { minimum: 21, maximum: 28 },
};

const REDEAL_THRESHOLD_CAPS: Readonly<
  Record<EngineConfig["gameType"], Readonly<Record<number, number>>>
> = {
  "56": { 4: 13, 6: 8, 8: 6 },
  "28": { 4: 6 },
};

function isWholeNumberBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validateStakeTiers(
  tiers: unknown,
  minimumBid: number,
  maximumBid: number,
  issues: string[],
): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    issues.push("stakeTiers must contain at least one tier");
    return;
  }

  let expectedFromBid = minimumBid;
  // design §5.2/rules §7.1: stake tiers are configurable, but a higher tier
  // must never pay out or cost less than a lower one — `bidRange` relies on
  // this to return one contiguous affordable range.
  let previousWinStake: number | null = null;
  let previousLossStake: number | null = null;

  for (const [index, tier] of tiers.entries()) {
    if (tier === null || typeof tier !== "object") {
      issues.push(`stakeTiers[${index}] must be a tier object`);
      continue;
    }

    const candidate = tier as Partial<Record<keyof StakeTier, unknown>>;
    const { fromBid, toBid, winStake, lossStake } = candidate;
    const fromBidValid =
      typeof fromBid === "number" && Number.isInteger(fromBid);
    const toBidValid = typeof toBid === "number" && Number.isInteger(toBid);

    if (!fromBidValid || !toBidValid) {
      issues.push(`stakeTiers[${index}] bid bounds must be whole numbers`);
    }

    if (fromBid !== expectedFromBid) {
      issues.push(`stakeTiers[${index}] must start at bid ${expectedFromBid}`);
    }

    if (fromBidValid && toBidValid && (toBid < fromBid || toBid > maximumBid)) {
      issues.push(`stakeTiers[${index}] has an invalid ending bid`);
    }

    if (!isWholeNumberBetween(winStake, 1, WHOLE_NUMBER_MAX)) {
      issues.push(
        `stakeTiers[${index}].winStake must be a whole number from 1 through 999`,
      );
    } else {
      if (previousWinStake !== null && winStake < previousWinStake) {
        issues.push(
          `stakeTiers[${index}].winStake must not be lower than the previous tier's`,
        );
      }
      // Keep the last valid value as the comparison baseline. A malformed
      // middle tier is already rejected, but must not mask a later decrease.
      previousWinStake = winStake;
    }

    if (!isWholeNumberBetween(lossStake, 1, WHOLE_NUMBER_MAX)) {
      issues.push(
        `stakeTiers[${index}].lossStake must be a whole number from 1 through 999`,
      );
    } else {
      if (previousLossStake !== null && lossStake < previousLossStake) {
        issues.push(
          `stakeTiers[${index}].lossStake must not be lower than the previous tier's`,
        );
      }
      previousLossStake = lossStake;
    }

    if (toBidValid) {
      expectedFromBid = toBid + 1;
    }
  }

  if (expectedFromBid !== maximumBid + 1) {
    issues.push(`stakeTiers must end at bid ${maximumBid}`);
  }
}

export function validateConfig(config: EngineConfig): ConfigRejection | null {
  const issues: string[] = [];
  const gameTypeValid = config.gameType === "56" || config.gameType === "28";

  if (!gameTypeValid) {
    issues.push("gameType must be 56 or 28");
  }

  const playerCountValid =
    config.playerCount === 4 ||
    config.playerCount === 6 ||
    config.playerCount === 8;
  if (!playerCountValid) {
    issues.push("playerCount must be 4, 6, or 8");
  }

  if (config.gameType === "28" && config.playerCount !== 4) {
    issues.push("28 requires exactly 4 players");
  }

  if (typeof config.includeEightsAndSevens !== "boolean") {
    issues.push("includeEightsAndSevens must be a boolean");
  } else if (config.gameType === "28" && !config.includeEightsAndSevens) {
    issues.push("28 requires eights and sevens");
  }

  if (config.gameType === "56" && playerCountValid) {
    const cardCount = config.includeEightsAndSevens ? 64 : 48;
    if (cardCount % config.playerCount !== 0) {
      issues.push(
        `${cardCount} cards cannot be divided among ${config.playerCount} players`,
      );
    }
  }

  if (
    config.illegalPlayMode !== "block" &&
    config.illegalPlayMode !== "autoStop"
  ) {
    issues.push("illegalPlayMode must be block or autoStop");
  }

  if (!isWholeNumberBetween(config.startingTokens, 1, WHOLE_NUMBER_MAX)) {
    issues.push("startingTokens must be a whole number from 1 through 999");
  }

  if (config.surrenderOption !== "off" && config.surrenderOption !== "on") {
    issues.push("surrenderOption must be off or on");
  }

  const redealThresholdCap = gameTypeValid
    ? REDEAL_THRESHOLD_CAPS[config.gameType][config.playerCount]
    : undefined;
  if (
    redealThresholdCap === undefined ||
    !isWholeNumberBetween(config.redealThreshold, 0, redealThresholdCap)
  ) {
    issues.push(
      "redealThreshold must be a whole number within the game and player-count cap",
    );
  }

  if (gameTypeValid) {
    const limits =
      AUCTION_BID_LIMITS[config.gameType === "56" ? "56" : "28-first"];
    validateStakeTiers(
      config.stakeTiers,
      limits.minimum,
      limits.maximum,
      issues,
    );
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    ok: false,
    code: "invalidConfig",
    details: { issues },
  };
}
