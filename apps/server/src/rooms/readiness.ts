import type {
  MissingParticipants,
  PlayerId,
  RoomGate,
} from "@fiftysix/protocol";

import { accepted, findPlayer, rejected, roomStage } from "./snapshot.js";
import type {
  CanonicalRoomEvent,
  DomainResult,
  RoomSnapshot,
} from "./types.js";

// Readiness policy (rooms spec §4.1–§4.4, §5.1; design.md §3, §10).

/**
 * Clears every Ready flag (and every replacement confirmation). Used for a
 * seat or first-dealer change before or between matches, and by the service
 * when a match ends (rooms spec §4.3). Emits `readinessCleared` only when a
 * flag actually changed.
 */
export function clearAllReady(state: RoomSnapshot): {
  state: RoomSnapshot;
  events: CanonicalRoomEvent[];
} {
  if (
    !state.players.some((player) => player.ready || player.replacementReady)
  ) {
    return { state, events: [] };
  }
  return {
    state: {
      ...state,
      players: state.players.map((player) =>
        player.ready || player.replacementReady
          ? { ...player, ready: false, replacementReady: false }
          : player,
      ),
    },
    events: [{ type: "readinessCleared" }],
  };
}

/**
 * A seated player's Ready or Unready (rooms spec §4.2, §4.4).
 *
 * - Arranging or between matches: any seated player may toggle Ready.
 * - Active match: only a seated replacement that has not confirmed may tap
 *   `Ready to resume`; existing confirmations are kept and nobody may withdraw.
 * - Session over: nothing to be Ready for until Restart session.
 *
 * Setting the value a player already has is rejected, so every accepted
 * transition changes the room. A replacement's Ready that completes the
 * table also reports `matchResumed` (rooms spec §9); starting a match when
 * the readiness gate opens is the service's follow-up step.
 */
export function setReady(
  state: RoomSnapshot,
  playerId: PlayerId,
  ready: boolean,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined) {
    return rejected("action_not_allowed");
  }
  if (player.seat === null) {
    return rejected("not_seated");
  }
  const stage = roomStage(state);
  if (stage === "sessionOver" || player.ready === ready) {
    return rejected("not_readyable");
  }
  if (stage === "matchActive" && !ready) {
    return rejected("not_readyable");
  }
  const replacementReady = stage === "matchActive";
  const next: RoomSnapshot = {
    ...state,
    players: state.players.map((candidate) =>
      candidate.id === playerId
        ? { ...candidate, ready, replacementReady }
        : candidate,
    ),
  };
  return accepted(next, [
    { type: "readyChanged", playerId, ready },
    ...stallChangeEvents(state, next),
  ]);
}

function missingParticipants(
  state: RoomSnapshot,
  required: "everyIdentity" | "seatedOnly",
): MissingParticipants {
  const emptySeats: number[] = [];
  state.seats.forEach((occupant, seat) => {
    if (occupant === null) {
      emptySeats.push(seat);
    }
  });
  return {
    emptySeats,
    disconnected: state.players
      .filter(
        (player) =>
          !player.connected &&
          (required === "everyIdentity" || player.seat !== null),
      )
      .map((player) => player.id),
    notReady: state.players
      .filter((player) => player.seat !== null && !player.ready)
      .map((player) => player.id),
  };
}

function nothingMissing(missing: MissingParticipants): boolean {
  return (
    missing.emptySeats.length === 0 &&
    missing.disconnected.length === 0 &&
    missing.notReady.length === 0
  );
}

/**
 * The readiness gate or stall status (rooms spec §4.2–§4.4, §5.1).
 *
 * - Before and between matches the gate waits for every seat to be
 *   occupied, every player identity to be connected and every seated player
 *   to be Ready; it is open when nothing is missing.
 * - During a match, every seat must be occupied and connected, and every
 *   occupant confirmed: existing players keep their match-start Ready, and a
 *   new replacement needs `Ready to resume`. Anything missing is a stall.
 *
 * Because identities never outnumber seats, a full table seats every
 * identity, so both rules open and close on the same conditions; they differ
 * only in which disconnected identities they list.
 */
export function readinessGate(state: RoomSnapshot): RoomGate {
  switch (roomStage(state)) {
    case "arranging":
    case "betweenMatches":
      return {
        type: "readiness",
        ...missingParticipants(state, "everyIdentity"),
      };
    case "sessionOver":
      return { type: "sessionOver" };
    case "matchActive": {
      const missing = missingParticipants(state, "seatedOnly");
      return nothingMissing(missing)
        ? { type: "playing" }
        : { type: "stalled", ...missing };
    }
  }
}

/** Whether the next match should start now (rooms spec §4.2, §4.3). */
export function readinessGateIsOpen(gate: RoomGate): boolean {
  return gate.type === "readiness" && nothingMissing(gate);
}

/**
 * The stall event a transition within one active match produces (rooms spec
 * §5.1, §9): `matchStalled` when a required seat goes missing while play was
 * running, and `matchResumed` when the last missing seat is restored.
 * Nothing outside an active match or when the stall status is unchanged.
 * Every room-domain transition already includes these events, so the service
 * adds them only around engine transitions.
 */
export function stallChangeEvents(
  before: RoomSnapshot,
  after: RoomSnapshot,
): CanonicalRoomEvent[] {
  if (
    roomStage(before) !== "matchActive" ||
    roomStage(after) !== "matchActive"
  ) {
    return [];
  }
  const wasPlaying = readinessGate(before).type === "playing";
  const isPlaying = readinessGate(after).type === "playing";
  if (wasPlaying === isPlaying) {
    return [];
  }
  return [{ type: isPlaying ? "matchResumed" : "matchStalled" }];
}
