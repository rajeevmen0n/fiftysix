import type { PlayerId, PrincipalScope } from "@fiftysix/protocol";

import { accepted, findPlayer, hasHostControls, rejected } from "./snapshot.js";
import type { DomainResult, PlayerRecord, RoomSnapshot } from "./types.js";

// Host succession and handover (rooms spec §5.3; design.md §10). The host
// role is `hostId`. While the host is disconnected, `hostTransfer` holds the
// committed deadline after which the role moves on. `hostId` is null only
// while host selection is pending because no player is connected; the next
// player to connect then receives the role (rooms spec §5.3, §11).

/**
 * When the host transfer wait that starts at `from` elapses: the room's
 * configured whole seconds after it (design.md §2).
 */
export function hostTransferDeadline(
  state: RoomSnapshot,
  from: number,
): number {
  return from + state.config.hostTransferWaitSeconds * 1_000;
}

/**
 * The player who receives the host role from `formerHost` (rooms spec §5.3;
 * design.md §10), or null when no player other than the former host is
 * connected:
 *
 * 1. the next connected occupied seat counter-clockwise (increasing seat
 *    number, as the engine numbers seats) from the former host's seat, or
 * 2. from its last seat while it is unseated; that seat's own new occupant
 *    comes last in the circle;
 * 3. otherwise, or when it never sat, the earliest-joined connected player.
 *
 * The former host is never chosen, so `state` may still contain it (a
 * disconnected host) or already lack it (a departed host).
 */
export function chooseSuccessor(
  state: RoomSnapshot,
  formerHost: PlayerRecord,
): PlayerId | null {
  const eligible = (player: PlayerRecord | undefined): boolean =>
    player !== undefined && player.id !== formerHost.id && player.connected;
  const start = formerHost.seat ?? formerHost.lastSeat;
  if (start !== null) {
    const seatCount = state.seats.length;
    for (let step = 1; step <= seatCount; step += 1) {
      const occupant = state.seats[(start + step) % seatCount] ?? null;
      if (occupant !== null && eligible(findPlayer(state, occupant))) {
        return occupant;
      }
    }
  }
  // `players` is in join order.
  return state.players.find(eligible)?.id ?? null;
}

/**
 * The host (or a Table view with host controls) hands the role to any other
 * seated player at any time (design.md §10). An unseated or unknown target,
 * or the current host itself, is `invalid_host_target`.
 *
 * Any pending transfer of the previous host ends. A target that is
 * disconnected at the handover starts its own transfer wait from `now`, as
 * a disconnecting host would (provisional, rooms spec §5.3).
 */
export function transferHost(
  state: RoomSnapshot,
  actor: PrincipalScope,
  target: PlayerId,
  now: number,
): DomainResult {
  if (!hasHostControls(state, actor)) {
    return rejected("not_host");
  }
  const player = findPlayer(state, target);
  if (player === undefined || player.seat === null || target === state.hostId) {
    return rejected("invalid_host_target");
  }
  return accepted(
    {
      ...state,
      hostId: target,
      hostTransfer: player.connected
        ? null
        : { hostId: target, deadline: hostTransferDeadline(state, now) },
    },
    [{ type: "hostChanged", hostId: target, reason: "handedOver" }],
  );
}

/**
 * The host transfer timer callback (rooms spec §5.3). It applies only when
 * it matches the committed pending transfer exactly; a callback made stale
 * by the host's return, a handover, a departure or a later deadline is
 * rejected with `action_not_allowed`, which the service treats as a no-op
 * (nothing is committed or sent).
 *
 * The role moves to `chooseSuccessor`, or becomes null (selection pending)
 * when no other player is connected; the next player to connect then
 * receives it (`connectPlayer`).
 */
export function applyHostDeadline(
  state: RoomSnapshot,
  hostId: PlayerId,
  deadline: number,
): DomainResult {
  const transfer = state.hostTransfer;
  const formerHost = findPlayer(state, hostId);
  if (
    transfer === null ||
    transfer.hostId !== hostId ||
    transfer.deadline !== deadline ||
    state.hostId !== hostId ||
    formerHost === undefined
  ) {
    return rejected("action_not_allowed");
  }
  const successor = chooseSuccessor(state, formerHost);
  return accepted({ ...state, hostId: successor, hostTransfer: null }, [
    { type: "hostChanged", hostId: successor, reason: "waitElapsed" },
  ]);
}
