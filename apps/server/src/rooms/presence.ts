import type {
  PlayerId,
  PlayerLeftReason,
  PrincipalScope,
} from "@fiftysix/protocol";

import { chooseSuccessor, hostTransferDeadline } from "./host.js";
import { clearAllReady, stallChangeEvents } from "./readiness.js";
import {
  accepted,
  findPlayer,
  hasHostControls,
  rejected,
  roomStage,
} from "./snapshot.js";
import type {
  CanonicalRoomEvent,
  DomainResult,
  PlayerRecord,
  RoomSnapshot,
} from "./types.js";

// Presence, permanent departure and replacement (rooms spec §3.2, §3.4,
// §4.4, §5.1, §5.3, §6.4; design.md §10). Connection state is
// server-authoritative: a disconnect keeps the identity, its seat and its
// Ready; during an active match it stalls play until the seat is restored.
// `emptySince` records when the last player connection ended (Table views
// never count). Every function is immutable.

function anyPlayerConnected(players: readonly PlayerRecord[]): boolean {
  return players.some((player) => player.connected);
}

function withPlayer(
  state: RoomSnapshot,
  playerId: PlayerId,
  change: Partial<PlayerRecord>,
): PlayerRecord[] {
  return state.players.map((player) =>
    player.id === playerId ? { ...player, ...change } : player,
  );
}

/**
 * A player identity's socket connects (rooms spec §3.2, §5.3). Its seat and
 * Ready are kept, so a returning player resumes its former seat, and an
 * active match resumes once no seat is missing.
 *
 * - The current host returning before its committed deadline cancels the
 *   pending transfer. Returning at or after the deadline, before the timer
 *   callback ran, completes the transfer now (the callback becomes stale);
 *   the host keeps the role only if no other player is connected.
 * - While host selection is pending (`hostId` null, so nobody else is
 *   connected), the connecting player receives the role. That completion is
 *   reported with reason `waitElapsed` (provisional, rooms spec §5.3).
 *
 * Connecting an already connected identity is `action_not_allowed`: a
 * socket takeover changes no room state.
 */
export function connectPlayer(
  state: RoomSnapshot,
  playerId: PlayerId,
  now: number,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined || player.connected) {
    return rejected("action_not_allowed");
  }
  let hostId = state.hostId;
  let hostTransfer = state.hostTransfer;
  let hostChanged = false;
  if (hostId === null) {
    hostId = playerId;
    hostChanged = true;
  } else if (hostTransfer !== null && hostTransfer.hostId === playerId) {
    if (now >= hostTransfer.deadline) {
      const successor = chooseSuccessor(state, player);
      if (successor !== null) {
        hostId = successor;
        hostChanged = true;
      }
    }
    hostTransfer = null;
  }
  const next: RoomSnapshot = {
    ...state,
    players: withPlayer(state, playerId, {
      connected: true,
      disconnectedAt: null,
    }),
    hostId,
    hostTransfer,
    emptySince: null,
  };
  const events: CanonicalRoomEvent[] = [
    { type: "playerConnected", playerId },
    ...stallChangeEvents(state, next),
  ];
  if (hostChanged) {
    events.push({ type: "hostChanged", hostId, reason: "waitElapsed" });
  }
  return accepted(next, events);
}

/**
 * A player identity's current socket closes (rooms spec §5.1, §5.3). The
 * identity, seat and Ready are kept. A disconnecting host starts the
 * configured transfer wait from `now`. When no other player is connected the
 * room's expiry clock starts (`emptySince`, rooms spec §6.4).
 *
 * Disconnecting an identity that is not connected is `action_not_allowed`.
 */
export function disconnectPlayer(
  state: RoomSnapshot,
  playerId: PlayerId,
  now: number,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined || !player.connected) {
    return rejected("action_not_allowed");
  }
  const players = withPlayer(state, playerId, {
    connected: false,
    disconnectedAt: now,
  });
  const next: RoomSnapshot = {
    ...state,
    players,
    hostTransfer:
      state.hostId === playerId
        ? { hostId: playerId, deadline: hostTransferDeadline(state, now) }
        : state.hostTransfer,
    emptySince: anyPlayerConnected(players) ? null : now,
  };
  return accepted(next, [
    { type: "playerDisconnected", playerId },
    ...stallChangeEvents(state, next),
  ]);
}

/**
 * The shared cleanup of an intentional departure or a removal (rooms spec
 * §3.4): the identity is deleted, its seat vacated and its tokens revoked.
 *
 * - Before and between matches a vacated seat is a seat change, so every
 *   Ready clears (design.md §3). An unseated identity's departure changes
 *   no seat and clears nothing.
 * - During an active match the seat-owned engine state stays with the seat
 *   and every other player's confirmation is kept. The empty seat stalls
 *   play until a new identity takes it and taps `Ready to resume` (§4.4).
 * - A departing host's role moves immediately by the succession order
 *   (§5.3), or becomes pending when no other player is connected.
 */
function depart(
  state: RoomSnapshot,
  player: PlayerRecord,
  reason: PlayerLeftReason,
  now: number,
): DomainResult {
  const stage = roomStage(state);
  const players = state.players.filter(
    (candidate) => candidate.id !== player.id,
  );
  let next: RoomSnapshot = {
    ...state,
    players,
    seats: state.seats.map((occupant) =>
      occupant === player.id ? null : occupant,
    ),
    emptySince: anyPlayerConnected(players) ? null : (state.emptySince ?? now),
  };
  const events: CanonicalRoomEvent[] = [];
  if (player.seat !== null) {
    events.push({ type: "seatLeft", playerId: player.id, seat: player.seat });
  }
  events.push({ type: "playerLeft", playerId: player.id, reason });
  if (player.seat !== null && stage !== "matchActive") {
    const cleared = clearAllReady(next);
    next = cleared.state;
    events.push(...cleared.events);
  }
  events.push(...stallChangeEvents(state, next));
  if (state.hostId === player.id) {
    const successor = chooseSuccessor(next, player);
    next = { ...next, hostId: successor, hostTransfer: null };
    events.push({
      type: "hostChanged",
      hostId: successor,
      reason: "hostDeparted",
    });
  }
  return accepted(next, events, [
    { type: "revokePlayerTokens", playerId: player.id },
  ]);
}

/**
 * The player's permanent Leave room (rooms spec §3.4; design.md §10),
 * allowed at any time. `now` starts the expiry clock if it was the last
 * connected player.
 */
export function leaveRoom(
  state: RoomSnapshot,
  playerId: PlayerId,
  now: number,
): DomainResult {
  const player = findPlayer(state, playerId);
  if (player === undefined) {
    return rejected("action_not_allowed");
  }
  return depart(state, player, "left", now);
}

/**
 * The host (or a Table view with host controls) removes a player, with the
 * same cleanup as Leave room (rooms spec §3.4; design.md §10).
 *
 * - Before a session, between matches and after the session: any identity.
 * - During an active match: only a disconnected identity. A disconnected
 *   seated player stalls the match, and an unseated identity implies an
 *   empty seat, so such a removal always happens during a stall.
 * - A host player removes itself only through Leave room
 *   (`player_not_removable`, provisional, rooms spec §3.4).
 */
export function removePlayer(
  state: RoomSnapshot,
  actor: PrincipalScope,
  target: PlayerId,
  now: number,
): DomainResult {
  if (!hasHostControls(state, actor)) {
    return rejected("not_host");
  }
  const player = findPlayer(state, target);
  if (player === undefined) {
    return rejected("action_not_allowed");
  }
  if (
    (actor.type === "player" && actor.playerId === target) ||
    (roomStage(state) === "matchActive" && player.connected)
  ) {
    return rejected("player_not_removable");
  }
  return depart(state, player, "removed", now);
}
