import { cardPoints } from "./cards.js";
import type { RedealtEvent } from "./events.js";
import { teamOf } from "./seats.js";
import type { EngineState, RedealReason } from "./state.js";
import type { Card, Team } from "./types.js";

const TEAMS: readonly Team[] = ["A", "B"];

/**
 * Rules §9, design §7.1: a redeal happens if one team holds no Jack across
 * its own members' combined holdings (checked first, in team order), or any
 * single seat's complete holding is worth `threshold` points or fewer
 * (checked in seat order, for a stable result when several seats qualify).
 * `holdings` is generic: the caller supplies each seat's complete holding,
 * including any face-down card once one exists.
 */
export function redealReason(
  holdings: readonly (readonly Card[])[],
  threshold: number,
): RedealReason | null {
  const playerCount = holdings.length;

  for (const team of TEAMS) {
    let hasJack = false;
    for (let seat = 0; seat < playerCount; seat += 1) {
      if (teamOf(seat) !== team) {
        continue;
      }
      const holding = holdings[seat] ?? [];
      if (holding.some((card) => card.rank === "J")) {
        hasJack = true;
        break;
      }
    }
    if (!hasJack) {
      return { type: "teamWithoutJack", team };
    }
  }

  for (let seat = 0; seat < playerCount; seat += 1) {
    const holding = holdings[seat] ?? [];
    const points = holding.reduce((total, card) => total + cardPoints(card), 0);
    if (points <= threshold) {
      return { type: "lowHand", seat, points };
    }
  }

  return null;
}

/**
 * `redealt` is a transient notice: the phase reset, unchanged dealer, and
 * unchanged tokens are all carried by the `matchEnded` event that follows it
 * in the same `deal` action, so this evolver leaves state untouched.
 */
export function evolveRedealt(
  state: EngineState,
  _event: RedealtEvent,
): EngineState {
  return state;
}
