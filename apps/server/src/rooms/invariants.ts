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
  | "invalidPin"
  | "firstDealerOutOfRange"
  | "phaseEngineMismatch"
  | "engineConfigMismatch";

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
 * replacement state, host membership, and the room/engine phase and seat
 * count agreement (rooms spec §3.1, §4, §11).
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

  // Host: a current identity, or null while selection is pending.
  if (state.hostId !== null && !ids.has(state.hostId)) {
    fail("invalidHost");
  }
  if (
    state.hostTransfer !== null &&
    (!ids.has(state.hostTransfer.hostId) ||
      !isTimestamp(state.hostTransfer.deadline))
  ) {
    fail("invalidHostTransfer");
  }
}
