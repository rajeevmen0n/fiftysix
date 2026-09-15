export type Seat = number;
export type Team = "A" | "B";
export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "J" | "9" | "A" | "10" | "K" | "Q" | "8" | "7";

export interface Card {
  suit: Suit;
  rank: Rank;
  copy: 1 | 2;
}

export interface StakeTier {
  fromBid: number;
  toBid: number;
  winStake: number;
  lossStake: number;
}

export interface EngineConfig {
  gameType: "56" | "28";
  playerCount: 4 | 6 | 8;
  includeEightsAndSevens: boolean;
  illegalPlayMode: "block" | "autoStop";
  startingTokens: number;
  stakeTiers: readonly StakeTier[];
  redealThreshold: number;
  surrenderOption: "off" | "on";
}

export interface ConfigRejection {
  ok: false;
  code: "invalidConfig";
  details: Record<string, unknown>;
}

export type StakeMultiplier = 1 | 2 | 4;

export interface TokenBalances {
  A: number;
  B: number;
}

export interface TokenTransfer {
  balances: TokenBalances;
  amount: number;
}

export type BidSuit = Suit | "noTrump";
export type BidStyle = "numberFirst" | "suitFirst";
