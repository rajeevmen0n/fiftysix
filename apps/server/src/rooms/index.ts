// The pure room aggregate and its policies (rooms spec §2.3). Nothing here
// performs I/O or reads ambient time or randomness.

export {
  applyHostDeadline,
  chooseSuccessor,
  hostTransferDeadline,
  transferHost,
} from "./host.js";
export {
  assertRoomInvariants,
  assertRoomTransition,
  type RoomInvariantCode,
  RoomInvariantError,
} from "./invariants.js";
export {
  countGraphemes,
  maximumNameCharacters,
  minimumNameCharacters,
  type NameRejection,
  type NormalizedName,
  nameComparisonKey,
  normalizeName,
} from "./names.js";
export {
  connectPlayer,
  disconnectPlayer,
  leaveRoom,
  removePlayer,
} from "./presence.js";
export {
  clearAllReady,
  readinessGate,
  readinessGateIsOpen,
  setReady,
  stallChangeEvents,
} from "./readiness.js";
export {
  hostMovePlayer,
  hostSwapPlayers,
  leaveSeat,
  setFirstDealer,
  takeSeat,
} from "./seating.js";
export {
  findPlayer,
  hasHostControls,
  isRoomSeat,
  type RoomStage,
  roomStage,
} from "./snapshot.js";
export type {
  CanonicalRoomEvent,
  DomainEffect,
  DomainResult,
  PinCredential,
  PlayerRecord,
  RoomConfig,
  RoomSnapshot,
  RoomSnapshotPhase,
} from "./types.js";
