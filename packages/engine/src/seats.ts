import type { Seat, Team } from "./types.js";

function assertPlayerCount(playerCount: number): void {
  if (![4, 6, 8].includes(playerCount)) {
    throw new RangeError("playerCount must be 4, 6, or 8");
  }
}

export function assertSeat(seat: Seat, playerCount: number): void {
  assertPlayerCount(playerCount);

  if (!Number.isInteger(seat) || seat < 0 || seat >= playerCount) {
    throw new RangeError(
      `seat must be a whole number from 0 through ${playerCount - 1}`,
    );
  }
}

export function nextSeat(seat: Seat, playerCount: number): Seat {
  assertSeat(seat, playerCount);
  return seat + 1 === playerCount ? 0 : seat + 1;
}

export function teamOf(seat: Seat): Team {
  if (!Number.isInteger(seat) || seat < 0 || seat > 7) {
    throw new RangeError("seat must be a whole number from 0 through 7");
  }

  return seat % 2 === 0 ? "A" : "B";
}
