import type { Card, EngineConfig, Rank, Suit } from "./types.js";

export const SUITS: readonly Suit[] = ["spades", "hearts", "diamonds", "clubs"];

export const RANKS: readonly Rank[] = ["J", "9", "A", "10", "K", "Q", "8", "7"];

export const RANK_POINTS: Readonly<Record<Rank, number>> = {
  J: 3,
  "9": 2,
  A: 1,
  "10": 1,
  K: 0,
  Q: 0,
  "8": 0,
  "7": 0,
};

export function buildDeck(config: EngineConfig): Card[] {
  const ranks =
    config.gameType === "28" || config.includeEightsAndSevens
      ? RANKS
      : RANKS.slice(0, 6);
  const copies = config.gameType === "56" ? ([1, 2] as const) : ([1] as const);
  const deck: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of ranks) {
      for (const copy of copies) {
        deck.push({ suit, rank, copy });
      }
    }
  }

  return deck;
}

export function cardPoints(card: Card): number {
  return RANK_POINTS[card.rank];
}

export function compareRanks(left: Rank, right: Rank): number {
  return RANKS.indexOf(right) - RANKS.indexOf(left);
}

export function cardsEqual(left: Card, right: Card): boolean {
  return (
    left.suit === right.suit &&
    left.rank === right.rank &&
    left.copy === right.copy
  );
}
