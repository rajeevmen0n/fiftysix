import { playerIdSchema, roomCodeSchema } from "@fiftysix/protocol";

import { canonicalDisplayName, nameComparisonKey } from "./names.js";
import { roomStage } from "./snapshot.js";
import type { PinCredential, PlayerRecord, RoomSnapshot } from "./types.js";

// Structural room invariants (rooms spec §11), checked by the service after
// every accepted transition and before it is committed.

export type RoomInvariantCode =
  | "invalidRoomIdentity"
  | "invalidTimestamp"
  | "identityCapExceeded"
  | "invalidPlayerId"
  | "duplicatePlayerId"
  | "invalidName"
  | "duplicateName"
  | "invalidJoinOrder"
  | "invalidSeatCount"
  | "seatOutOfRange"
  | "seatMismatch"
  | "invalidLastSeat"
  | "invalidReadiness"
  | "invalidReplacementState"
  | "invalidHost"
  | "invalidHostTransfer"
  | "invalidPresence"
  | "invalidPin"
  | "firstDealerOutOfRange"
  | "phaseEngineMismatch"
  | "engineConfigMismatch"
  | "invalidSeatTransition"
  | "invalidMatchStart";

/**
 * Thrown for a room-policy bug. Its message and fields name only the room
 * ID, revision and invariant code: never names, PINs, tokens or engine state.
 */
export class RoomInvariantError extends Error {
  readonly roomId: string;
  readonly revision: number;
  readonly code: RoomInvariantCode;

  constructor(roomId: string, revision: number, code: RoomInvariantCode) {
    super(`room ${roomId} revision ${revision}: invariant ${code} violated`);
    this.name = "RoomInvariantError";
    this.roomId = roomId;
    this.revision = revision;
    this.code = code;
  }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === null || isTimestamp(value);
}

function isSeatIn(value: unknown, seatCount: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < seatCount
  );
}

function pinIsWellFormed(pin: PinCredential | null): boolean {
  return (
    pin === null ||
    (typeof pin.salt === "string" &&
      pin.salt.length > 0 &&
      typeof pin.digest === "string" &&
      pin.digest.length > 0 &&
      Number.isSafeInteger(pin.failures) &&
      pin.failures >= 0 &&
      isOptionalTimestamp(pin.lockedUntil))
  );
}

/**
 * A stored name is non-empty, already in its canonical display form, and
 * carries its comparison key. The 1–24 character cap and the character rules
 * are input validation only (`normalizeName`): grapheme counting depends on
 * the runtime's Unicode version, and a stored name must never become invalid.
 */
function playerNameIsCanonical(player: PlayerRecord): boolean {
  return (
    player.displayName.length > 0 &&
    canonicalDisplayName(player.displayName) === player.displayName &&
    player.normalizedName === nameComparisonKey(player.displayName)
  );
}

/**
 * Throws `RoomInvariantError` when the snapshot breaks a structural rule:
 * the identity cap, unique IDs and normalized names, join order, the
 * bidirectional seat map, seat and timestamp ranges, readiness and
 * replacement state, presence and the expiry clock, the host and its pending
 * transfer, and the room/engine phase and seat count agreement (rooms spec
 * §3.1, §4, §5, §6.4, §11).
 */
export function assertRoomInvariants(state: RoomSnapshot): void {
  const fail = (code: RoomInvariantCode): never => {
    throw new RoomInvariantError(state.id, state.revision, code);
  };

  if (
    typeof state.id !== "string" ||
    state.id.length === 0 ||
    !roomCodeSchema.safeParse(state.code).success ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    fail("invalidRoomIdentity");
  }
  if (!isTimestamp(state.createdAt) || !isOptionalTimestamp(state.emptySince)) {
    fail("invalidTimestamp");
  }

  const seatCount = state.config.playerCount;
  if (state.seats.length !== seatCount) {
    fail("invalidSeatCount");
  }
  if (state.players.length > seatCount) {
    fail("identityCapExceeded");
  }
  if (!pinIsWellFormed(state.tablePin)) {
    fail("invalidPin");
  }

  // Players: identity, names, order, credentials and timestamps.
  const ids = new Set<string>();
  const names = new Set<string>();
  let previousJoinOrder = -1;
  for (const player of state.players) {
    if (!playerIdSchema.safeParse(player.id).success) {
      fail("invalidPlayerId");
    }
    if (ids.has(player.id)) {
      fail("duplicatePlayerId");
    }
    ids.add(player.id);
    if (!playerNameIsCanonical(player)) {
      fail("invalidName");
    }
    if (names.has(player.normalizedName)) {
      fail("duplicateName");
    }
    names.add(player.normalizedName);
    if (
      !Number.isSafeInteger(player.joinOrder) ||
      player.joinOrder <= previousJoinOrder
    ) {
      fail("invalidJoinOrder");
    }
    previousJoinOrder = player.joinOrder;
    if (!pinIsWellFormed(player.pin)) {
      fail("invalidPin");
    }
    if (
      !isOptionalTimestamp(player.disconnectedAt) ||
      !isOptionalTimestamp(player.lastReactionAt)
    ) {
      fail("invalidTimestamp");
    }
  }

  // Seats: each seat holds at most one known identity and each identity
  // occupies at most the one seat that names it.
  const seated = new Set<string>();
  state.seats.forEach((occupant, seat) => {
    if (occupant === null) {
      return;
    }
    const player = state.players.find((candidate) => candidate.id === occupant);
    if (player === undefined || player.seat !== seat || seated.has(occupant)) {
      fail("seatMismatch");
    }
    seated.add(occupant);
  });
  for (const player of state.players) {
    if (player.seat !== null) {
      if (!isSeatIn(player.seat, seatCount)) {
        fail("seatOutOfRange");
      }
      if (state.seats[player.seat] !== player.id) {
        fail("seatMismatch");
      }
    }
    if (
      (player.lastSeat !== null && !isSeatIn(player.lastSeat, seatCount)) ||
      (player.seat !== null && player.lastSeat !== player.seat)
    ) {
      fail("invalidLastSeat");
    }
  }

  if (!isSeatIn(state.firstDealer, seatCount)) {
    fail("firstDealerOutOfRange");
  }

  // Phase and engine agreement.
  const engine = state.engine;
  if (state.phase.type === "arranging") {
    const restartPending = state.phase.pending === "restart";
    if (
      restartPending
        ? engine === null || engine.phase.type !== "sessionOver"
        : engine !== null
    ) {
      fail("phaseEngineMismatch");
    }
  } else if (engine === null) {
    fail("phaseEngineMismatch");
  }
  if (
    engine !== null &&
    (engine.config.playerCount !== seatCount ||
      engine.config.gameType !== state.config.gameType)
  ) {
    fail("engineConfigMismatch");
  }

  // Readiness: only a seated player is Ready; a replacement confirmation
  // exists only during an active match and is itself a Ready.
  const matchActive = roomStage(state) === "matchActive";
  for (const player of state.players) {
    if (player.ready && player.seat === null) {
      fail("invalidReadiness");
    }
    if (player.replacementReady && (!player.ready || !matchActive)) {
      fail("invalidReplacementState");
    }
  }
  if (
    roomStage(state) === "sessionOver" &&
    state.players.some((player) => player.ready)
  ) {
    fail("invalidReadiness");
  }

  // Presence: a connected identity has no disconnect time, and the expiry
  // clock runs exactly while no player is connected (rooms spec §6.4). A
  // disconnected identity may lack a time (a crash, rooms spec §6.3).
  const anyConnected = state.players.some((player) => player.connected);
  if (
    state.players.some(
      (player) => player.connected && player.disconnectedAt !== null,
    ) ||
    anyConnected !== (state.emptySince === null)
  ) {
    fail("invalidPresence");
  }

  // Host: a current identity, or null only while selection is pending
  // because no player is connected (rooms spec §5.3, §11).
  if (state.hostId === null ? anyConnected : !ids.has(state.hostId)) {
    fail("invalidHost");
  }
  // A pending transfer belongs to the current host while it is disconnected.
  if (state.hostTransfer !== null) {
    const host = state.players.find(
      (player) => player.id === state.hostTransfer?.hostId,
    );
    if (
      host === undefined ||
      host.id !== state.hostId ||
      host.connected ||
      !isTimestamp(state.hostTransfer.deadline)
    ) {
      fail("invalidHostTransfer");
    }
  }
}

/**
 * Throws `RoomInvariantError` (with the later snapshot's ID and revision)
 * when an accepted transition breaks a rule that spans two snapshots (rooms
 * spec §4.2, §4.4, §11):
 *
 * - A match starts only with every seat occupied and every player connected
 *   and Ready (`invalidMatchStart`).
 * - Within an active match an engine seat changes identity only through the
 *   stalled-replacement flow (`invalidSeatTransition`): a seat empties only
 *   when its occupant leaves the room, and an empty seat is filled only by
 *   a previously unseated identity that has not yet confirmed `Ready to
 *   resume`.
 *
 * Both snapshots must already satisfy `assertRoomInvariants`.
 */
export function assertRoomTransition(
  before: RoomSnapshot,
  after: RoomSnapshot,
): void {
  const fail = (code: RoomInvariantCode): never => {
    throw new RoomInvariantError(after.id, after.revision, code);
  };
  const beforeStage = roomStage(before);
  const afterStage = roomStage(after);
  if (afterStage !== "matchActive") {
    return;
  }
  if (beforeStage !== "matchActive") {
    if (
      after.seats.includes(null) ||
      after.players.some((player) => !player.connected || !player.ready)
    ) {
      fail("invalidMatchStart");
    }
    return;
  }
  before.seats.forEach((previous, seat) => {
    const current = after.seats[seat] ?? null;
    if (previous === current) {
      return;
    }
    if (current === null) {
      if (after.players.some((player) => player.id === previous)) {
        fail("invalidSeatTransition");
      }
      return;
    }
    const newcomerBefore = before.players.find(
      (player) => player.id === current,
    );
    const newcomerAfter = after.players.find((player) => player.id === current);
    if (
      previous !== null ||
      newcomerBefore === undefined ||
      newcomerBefore.seat !== null ||
      newcomerAfter === undefined ||
      newcomerAfter.ready
    ) {
      fail("invalidSeatTransition");
    }
  });
}
