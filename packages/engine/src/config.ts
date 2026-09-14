import type { ConfigRejection, EngineConfig, StakeTier } from "./types.js";

const WHOLE_NUMBER_MAX = 999;

const REDEAL_THRESHOLD_CAPS: Readonly<
  Record<EngineConfig["gameType"], Readonly<Record<number, number>>>
> = {
  "56": { 4: 13, 6: 8, 8: 6 },
  "28": { 4: 6 },
};

function isWholeNumberBetween(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validateStakeTiers(
  tiers: readonly StakeTier[],
  minimumBid: number,
  maximumBid: number,
  issues: string[],
): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    issues.push("stakeTiers must contain at least one tier");
    return;
  }

  let expectedFromBid = minimumBid;

  for (const [index, tier] of tiers.entries()) {
    if (tier === null || typeof tier !== "object") {
      issues.push(`stakeTiers[${index}] must be a tier object`);
      continue;
    }

    if (!Number.isInteger(tier.fromBid) || !Number.isInteger(tier.toBid)) {
      issues.push(`stakeTiers[${index}] bid bounds must be whole numbers`);
    }

    if (tier.fromBid !== expectedFromBid) {
      issues.push(`stakeTiers[${index}] must start at bid ${expectedFromBid}`);
    }

    if (tier.toBid < tier.fromBid || tier.toBid > maximumBid) {
      issues.push(`stakeTiers[${index}] has an invalid ending bid`);
    }

    if (!isWholeNumberBetween(tier.winStake, 1, WHOLE_NUMBER_MAX)) {
      issues.push(
        `stakeTiers[${index}].winStake must be a whole number from 1 through 999`,
      );
    }

    if (!isWholeNumberBetween(tier.lossStake, 1, WHOLE_NUMBER_MAX)) {
      issues.push(
        `stakeTiers[${index}].lossStake must be a whole number from 1 through 999`,
      );
    }

    expectedFromBid = tier.toBid + 1;
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
    const minimumBid = config.gameType === "56" ? 28 : 14;
    const maximumBid = config.gameType === "56" ? 56 : 28;
    validateStakeTiers(config.stakeTiers, minimumBid, maximumBid, issues);
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
