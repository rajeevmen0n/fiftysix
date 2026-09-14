import type {
  EngineConfig,
  StakeMultiplier,
  StakeTier,
  Team,
  TokenBalances,
  TokenTransfer,
} from "./types.js";

function assertNonNegativeWholeNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative whole number`);
  }
}

export function stakeFor(config: EngineConfig, amount: number): StakeTier {
  if (!Number.isInteger(amount)) {
    throw new RangeError("bid amount must be a whole number");
  }

  const tier = config.stakeTiers.find(
    (candidate) => candidate.fromBid <= amount && amount <= candidate.toBid,
  );
  if (tier === undefined) {
    throw new RangeError(`no stake tier covers bid ${amount}`);
  }

  return { ...tier };
}

export function multiplyStake(
  stake: number,
  multiplier: StakeMultiplier,
): number {
  assertNonNegativeWholeNumber(stake, "stake");
  if (multiplier !== 1 && multiplier !== 2 && multiplier !== 4) {
    throw new RangeError("stake multiplier must be 1, 2, or 4");
  }

  return stake * multiplier;
}

export function canAffordBid(
  config: EngineConfig,
  amount: number,
  balance: number,
): boolean {
  assertNonNegativeWholeNumber(balance, "balance");
  return balance >= stakeFor(config, amount).lossStake;
}

export function canAffordDouble(
  config: EngineConfig,
  amount: number,
  balance: number,
): boolean {
  assertNonNegativeWholeNumber(balance, "balance");
  return balance >= multiplyStake(stakeFor(config, amount).winStake, 2);
}

export function canAffordRedouble(
  config: EngineConfig,
  amount: number,
  balance: number,
): boolean {
  assertNonNegativeWholeNumber(balance, "balance");
  return balance >= multiplyStake(stakeFor(config, amount).lossStake, 4);
}

export function transferTokens(
  balances: Readonly<TokenBalances>,
  payer: Team,
  amount: number,
): TokenTransfer {
  assertNonNegativeWholeNumber(balances.A, "Team A balance");
  assertNonNegativeWholeNumber(balances.B, "Team B balance");
  assertNonNegativeWholeNumber(amount, "transfer amount");

  const recipient: Team = payer === "A" ? "B" : "A";
  const transferred = Math.min(balances[payer], amount);

  return {
    balances: {
      A: balances.A + (recipient === "A" ? transferred : -transferred),
      B: balances.B + (recipient === "B" ? transferred : -transferred),
    },
    amount: transferred,
  };
}
