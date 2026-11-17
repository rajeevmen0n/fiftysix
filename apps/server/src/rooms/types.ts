import type { EngineEvent, EngineState } from "@fiftysix/engine";
import type {
  PlayerId,
  RejectionDetails,
  RoomCode,
  RoomEvent,
  RoomId,
  RoomRejectionCode,
  RoomSettings,
} from "@fiftysix/protocol";

// The private, authoritative room aggregate (rooms spec §2.1, §3.1). Every
// value is JSON-safe (plain objects, arrays, strings, finite numbers,
// booleans and null) so that a storage codec can persist the snapshot as-is.
// Nothing in this file crosses the network: views and events are built from
// it per recipient (rooms spec §8).

/** A room's fixed settings, chosen at creation (design.md §2). */
export type RoomConfig = RoomSettings;

/**
 * A stored PIN (rooms spec §3.3): a salted scrypt digest plus its persisted
 * lockout counter. Salt and digest are encoded strings so the snapshot stays
 * JSON-safe. The credential primitives (R004) own hashing and lockout.
 */
export interface PinCredential {
  salt: string;
  digest: string;
  /** Consecutive wrong attempts in the current lockout sequence. */
  failures: number;
  /** Injected-clock time (ms) until which PIN checks are locked, or null. */
  lockedUntil: number | null;
}

/** One player identity (rooms spec §3.1). */
export interface PlayerRecord {
  id: PlayerId;
  /** Trimmed, NFKC-normalized name as shown to everyone. */
  displayName: string;
  /** Case-folded comparison key, unique within the room. */
  normalizedName: string;
  pin: PinCredential | null;
  /** Position in join order; strictly increasing along `players`. */
  joinOrder: number;
  seat: number | null;
  /**
   * The most recently occupied seat, or null if the identity never sat. While
   * seated it equals `seat`; after unseating it keeps the seat just left
   * (host succession starts from it, rooms spec §5.3).
   */
  lastSeat: number | null;
  /**
   * The Ready flag (rooms spec §4). Before a match it is the tapped Ready.
   * During an active match it is the confirmation the match runs on: kept
   * from the match start for existing players, and set by `Ready to resume`
   * for a replacement (rooms spec §4.4).
   */
  ready: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  /**
   * True only for a replacement that took a seat during the current active
   * match and has tapped `Ready to resume` (rooms spec §4.4). It implies
   * `ready` and is cleared with every Ready flag when the match ends.
   */
  replacementReady: boolean;
  lastReactionAt: number | null;
}

/**
 * The service-level room phase (rooms spec §4.1). `arranging` waits for the
 * readiness gate before the first match of a session: `initial` has no
 * engine yet, while `restart` keeps the finished session's engine (at
 * `sessionOver`) until the gate opens and the engine restarts.
 */
export type RoomSnapshotPhase =
  | { type: "arranging"; pending: "initial" | "restart" }
  | { type: "running" };

export interface RoomSnapshot {
  id: RoomId;
  code: RoomCode;
  revision: number;
  config: RoomConfig;
  phase: RoomSnapshotPhase;
  /** Every identity, in join order. */
  players: PlayerRecord[];
  /** One entry per configured seat: its occupant or null. */
  seats: Array<PlayerId | null>;
  /** Null only while host selection is pending (rooms spec §5.3, §11). */
  hostId: PlayerId | null;
  hostTransfer: { hostId: PlayerId; deadline: number } | null;
  /** The selected first dealer of the current or next session. */
  firstDealer: number;
  engine: EngineState | null;
  tablePin: PinCredential | null;
  createdAt: number;
  emptySince: number | null;
}

/**
 * A canonical room event as journaled (rooms spec §8.3): the public room
 * events plus raw engine events. Engine events are redacted per recipient
 * immediately before delivery and never leave the server in this form.
 */
export type CanonicalRoomEvent =
  | Exclude<RoomEvent, { type: "engine" }>
  | { type: "engine"; event: EngineEvent };

/** A side effect the service performs with the committed transition. */
export type DomainEffect = { type: "revokePlayerTokens"; playerId: PlayerId };

/**
 * The outcome of one pure room transition. An accepted transition always
 * changes the snapshot and reports at least one event; the service then
 * advances `revision`. Rejection details are flat primitives only (R001).
 */
export type DomainResult =
  | {
      ok: true;
      state: RoomSnapshot;
      events: CanonicalRoomEvent[];
      effects: DomainEffect[];
    }
  | { ok: false; code: RoomRejectionCode; details?: RejectionDetails };
