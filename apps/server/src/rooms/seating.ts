import type { PlayerId, PrincipalScope } from "@fiftysix/protocol";

import { clearAllReady } from "./readiness.js";
import {
  accepted,
  findPlayer,
  hasHostControls,
  isRoomSeat,
  type RoomStage,
  rejected,
  roomStage,
} from "./snapshot.js";
import type {
  CanonicalRoomEvent,
  DomainResult,
  PlayerRecord,
  RoomSnapshot,
} from "./types.js";

// Seating and first-dealer policy (rooms spec §4.1, §4.3; design.md §3).
// Every function is immutable: it returns a new snapshot and never changes
// its input. Seat-owned engine state (team, position, hand) never moves with
// an identity; only the seat-to-identity mapping changes.

/**
 * Puts each listed player in its new seat (null to unseat). Seats the moves
 * vacate are emptied first, so a swap is one call. A newly taken seat also
 * becomes the player's `lastSeat`.
 */
function placePlayers(
  state: RoomSnapshot,
  moves: ReadonlyArray<{ playerId: PlayerId; seat: number | null }>,
): RoomSnapshot {
  const seatOf = new Map(moves.map((move) => [move.playerId, move.seat]));
  const seats = state.seats.map((occupant) =>
    occupant !== null && seatOf.has(occupant) ? null : occupant,
  );
  for (const move of moves) {
    if (move.seat !== null) {
      seats[move.seat] = move.playerId;
    }
  }
  const players = state.players.map((player): PlayerRecord => {
    const seat = seatOf.get(player.id);
    if (seat === undefined) {
      return player;
    }
    return { ...player, seat, lastSeat: seat ?? player.lastSeat };
  });
  return { ...state, seats, players };
}

/**
 * Before or between matches every seat change clears everyone's Ready
 * (design.md §3). During an active match a replacement's seat claim keeps
 * existing confirmations (rooms spec §4.4).
 */
function finishSeatChange(
  stage: RoomStage,
  state: RoomSnapshot,
  events: CanonicalRoomEvent[],
): DomainResult {
  if (stage === "matchActive") {
    return accepted(state, events);
  }
  const cleared = clearAllReady(state);
  return accepted(cleared.state, [...events, ...cleared.events]);
}

/** Whether the host may rearrange players now (rooms spec §4.1, §4.3). */
function hostMayRearrange(stage: RoomStage): boolean {
  return stage === "arranging" || stage === "betweenMatches";
}

/**
 * A player takes an empty seat.
 *
 * - Arranging: any player, seated (a direct move) or unseated.
 * - After the session's first match has begun: only an unseated identity,
 *   which can only be a newcomer admitted after the session started. Its
 *   one claim locks it like everyone else (rooms spec §4.3). During an active
 *   match this is the replacement's vacant-seat claim (rooms spec §4.4).
 * - Session over: nobody, until Restart session.
 */
export function takeSeat(
  state: RoomSnapshot,
  playerId: PlayerId,
  seat: number,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined || !isRoomSeat(state, seat)) {
    return rejected("action_not_allowed");
  }
  const stage = roomStage(state);
  if (
    stage === "sessionOver" ||
    (stage !== "arranging" && player.seat !== null)
  ) {
    return rejected("seat_change_not_allowed");
  }
  if (state.seats[seat] !== null) {
    return rejected("seat_occupied");
  }
  const events: CanonicalRoomEvent[] = [];
  if (player.seat !== null) {
    events.push({ type: "seatLeft", playerId, seat: player.seat });
  }
  events.push({ type: "seatTaken", playerId, seat });
  return finishSeatChange(
    stage,
    placePlayers(state, [{ playerId, seat }]),
    events,
  );
}

/** A player leaves its seat; only while arranging (rooms spec §4.1, §4.3). */
export function leaveSeat(
  state: RoomSnapshot,
  playerId: PlayerId,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined) {
    return rejected("action_not_allowed");
  }
  if (player.seat === null) {
    return rejected("not_seated");
  }
  const stage = roomStage(state);
  if (stage !== "arranging") {
    return rejected("seat_change_not_allowed");
  }
  return finishSeatChange(
    stage,
    placePlayers(state, [{ playerId, seat: null }]),
    [{ type: "seatLeft", playerId, seat: player.seat }],
  );
}

/**
 * The host moves a seated or unseated player to an empty seat, while
 * arranging or between matches, never during active play (design.md §3).
 * Swapping into an occupied seat is `hostSwapPlayers`.
 */
export function hostMovePlayer(
  state: RoomSnapshot,
  actor: PrincipalScope,
  playerId: PlayerId,
  seat: number,
): DomainResult {
  if (!hasHostControls(state, actor)) {
    return rejected("not_host");
  }
  const stage = roomStage(state);
  if (!hostMayRearrange(stage)) {
    return rejected("seat_change_not_allowed");
  }
  const player = findPlayer(state, playerId);
  if (
    player === undefined ||
    !isRoomSeat(state, seat) ||
    player.seat === seat
  ) {
    // Moving a player to its own seat would change nothing.
    return rejected("action_not_allowed");
  }
  if (state.seats[seat] !== null) {
    return rejected("seat_occupied");
  }
  return finishSeatChange(stage, placePlayers(state, [{ playerId, seat }]), [
    { type: "playerMoved", playerId, from: player.seat, to: seat },
  ]);
}

/**
 * The host swaps the seats of two distinct seated players, while arranging
 * or between matches (design.md §3). Each assumes the other seat's team and
 * position.
 */
export function hostSwapPlayers(
  state: RoomSnapshot,
  actor: PrincipalScope,
  first: PlayerId,
  second: PlayerId,
): DomainResult {
  if (!hasHostControls(state, actor)) {
    return rejected("not_host");
  }
  const stage = roomStage(state);
  if (!hostMayRearrange(stage)) {
    return rejected("seat_change_not_allowed");
  }
  const firstPlayer = findPlayer(state, first);
  const secondPlayer = findPlayer(state, second);
  if (
    firstPlayer === undefined ||
    secondPlayer === undefined ||
    first === second
  ) {
    return rejected("action_not_allowed");
  }
  if (firstPlayer.seat === null || secondPlayer.seat === null) {
    return rejected("not_seated");
  }
  const firstSeat = secondPlayer.seat;
  const secondSeat = firstPlayer.seat;
  return finishSeatChange(
    stage,
    placePlayers(state, [
      { playerId: first, seat: firstSeat },
      { playerId: second, seat: secondSeat },
    ]),
    [{ type: "playersSwapped", first, firstSeat, second, secondSeat }],
  );
}

/**
 * The host picks a different first dealer while arranging a session
 * (rooms spec §4.1). Like a seat change, it clears everyone's Ready.
 */
export function setFirstDealer(
  state: RoomSnapshot,
  actor: PrincipalScope,
  seat: number,
): DomainResult {
  if (!hasHostControls(state, actor)) {
    return rejected("not_host");
  }
  const stage = roomStage(state);
  if (
    stage !== "arranging" ||
    !isRoomSeat(state, seat) ||
    seat === state.firstDealer
  ) {
    return rejected("action_not_allowed");
  }
  return finishSeatChange(stage, { ...state, firstDealer: seat }, [
    { type: "firstDealerChanged", seat },
  ]);
}
