import type {
  PlayerId,
  PrincipalScope,
  RejectionDetails,
  RoomRejectionCode,
} from "@fiftysix/protocol";

import type {
  CanonicalRoomEvent,
  DomainEffect,
  DomainResult,
  PlayerRecord,
  RoomSnapshot,
} from "./types.js";

// Small shared queries and result constructors for the pure room policy.

/**
 * Where the room is in its session (rooms spec §4, §5.1; design.md §3):
 *
 * - `arranging`: before the first match of a session.
 * - `matchActive`: a match has begun and has not been scored. Every engine
 *   phase from `awaitingDeal` (including a pending redeal or restart deal)
 *   through `play` belongs to the match.
 * - `betweenMatches`: the engine waits at `matchOver` for the Ready gate.
 * - `sessionOver`: a team ran out of tokens; only Restart session leads on.
 */
export type RoomStage =
  | "arranging"
  | "matchActive"
  | "betweenMatches"
  | "sessionOver";

export function roomStage(state: RoomSnapshot): RoomStage {
  if (state.phase.type === "arranging") {
    return "arranging";
  }
  if (state.engine === null) {
    throw new Error("a running room has no engine state");
  }
  switch (state.engine.phase.type) {
    case "matchOver":
      return "betweenMatches";
    case "sessionOver":
      return "sessionOver";
    default:
      return "matchActive";
  }
}

export function findPlayer(
  state: RoomSnapshot,
  playerId: PlayerId,
): PlayerRecord | undefined {
  return state.players.find((player) => player.id === playerId);
}

/** Whether `seat` is a numbered seat of this room. */
export function isRoomSeat(state: RoomSnapshot, seat: number): boolean {
  return Number.isInteger(seat) && seat >= 0 && seat < state.seats.length;
}

/**
 * Whether a principal holds host controls: the current host player, or a
 * Table view authorized with host controls (design.md §10, §13).
 */
export function hasHostControls(
  state: RoomSnapshot,
  actor: PrincipalScope,
): boolean {
  if (actor.type === "table") {
    return actor.hostControls;
  }
  return state.hostId !== null && actor.playerId === state.hostId;
}

export function accepted(
  state: RoomSnapshot,
  events: CanonicalRoomEvent[],
  effects: DomainEffect[] = [],
): DomainResult {
  return { ok: true, state, events, effects };
}

export function rejected(
  code: RoomRejectionCode,
  details?: RejectionDetails,
): DomainResult {
  return details === undefined
    ? { ok: false, code }
    : { ok: false, code, details };
}
