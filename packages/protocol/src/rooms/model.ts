import type {
  BidStyle,
  BidSuit,
  Card,
  EngineConfig,
  Rank,
  Seat,
  StakeTier,
  Suit,
  SurrenderVoteChoice,
  Team,
} from "@fiftysix/engine";
import { z } from "zod";

// Shared room vocabulary (rooms spec §3–§5, §8; design.md §2, §3, §7, §9).
//
// Every object schema is strict: an unknown key is a protocol violation in
// both directions. Inbound, that stops a client from claiming fields the
// server owns (an engine action `source`, another player's seat). Outbound,
// it stops a private field (a hand, a token, a PIN hash) from leaving the
// server inside an otherwise valid message.

// ---------------------------------------------------------------------------
// Identifiers

/** A server-generated, stable, random player identity (rooms spec §3.1). */
export type PlayerId = string;
/** The server-internal room identity. Never sent to a client. */
export type RoomId = string;
/** The six-character shareable room code (design.md §9). */
export type RoomCode = string;
/** A client-generated retry key for one command (rooms spec §7.4). */
export type CommandId = string;

/**
 * design.md §9: six characters from uppercase letters and digits, excluding
 * the look-alikes 0/O and 1/I.
 */
export const roomCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const roomCodeLength = 6;

export const roomCodeSchema = z
  .string()
  .regex(/^[A-HJ-NP-Z2-9]{6}$/) satisfies z.ZodType<RoomCode>;

/**
 * Opaque identifiers that clients echo back (player IDs) or generate (command
 * IDs, normally a UUID): 1–64 URL-safe characters. The server's player-ID
 * generator must produce values inside this alphabet and length.
 */
const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const playerIdSchema = opaqueIdSchema satisfies z.ZodType<PlayerId>;
export const commandIdSchema = opaqueIdSchema satisfies z.ZodType<CommandId>;

/** An access token as issued by the HTTP API and presented in `hello`. */
export const maximumTokenLength = 4_096;
export const accessTokenSchema = z.string().min(1).max(maximumTokenLength);

/** A room revision: increases by one with every accepted transition. */
export const revisionSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Engine primitives (types imported from the engine, schemas mirrored here)

export type GameType = EngineConfig["gameType"];
export type PlayerCount = EngineConfig["playerCount"];
export type IllegalPlayMode = EngineConfig["illegalPlayMode"];
export type SurrenderOption = EngineConfig["surrenderOption"];

export const gameTypeSchema = z.enum([
  "56",
  "28",
]) satisfies z.ZodType<GameType>;

/** The highest seat number at any table (8 players). */
export const maximumSeat = 7;

export const seatSchema = z
  .number()
  .int()
  .min(0)
  .max(maximumSeat) satisfies z.ZodType<Seat>;

export const teamSchema = z.enum(["A", "B"]) satisfies z.ZodType<Team>;

export const suitSchema = z.enum([
  "spades",
  "hearts",
  "diamonds",
  "clubs",
]) satisfies z.ZodType<Suit>;

export const rankSchema = z.enum([
  "J",
  "9",
  "A",
  "10",
  "K",
  "Q",
  "8",
  "7",
]) satisfies z.ZodType<Rank>;

export const cardSchema = z.strictObject({
  suit: suitSchema,
  rank: rankSchema,
  copy: z.union([z.literal(1), z.literal(2)]),
}) satisfies z.ZodType<Card>;

export const bidSuitSchema = z.enum([
  "spades",
  "hearts",
  "diamonds",
  "clubs",
  "noTrump",
]) satisfies z.ZodType<BidSuit>;

export const bidStyleSchema = z.enum([
  "numberFirst",
  "suitFirst",
]) satisfies z.ZodType<BidStyle>;

export const surrenderVoteChoiceSchema = z.enum([
  "yes",
  "no",
]) satisfies z.ZodType<SurrenderVoteChoice>;

// ---------------------------------------------------------------------------
// Reactions (rooms spec §5.2, design.md §7)

export type ReactionId =
  | "hello"
  | "nice"
  | "wellPlayed"
  | "wow"
  | "oops"
  | "oneMoment"
  | "thanks";

/** The only reactions the protocol carries. Labels come from translations. */
export const reactionIds = [
  "hello",
  "nice",
  "wellPlayed",
  "wow",
  "oops",
  "oneMoment",
  "thanks",
] as const satisfies readonly ReactionId[];

export const reactionIdSchema = z.enum(
  reactionIds,
) satisfies z.ZodType<ReactionId>;

// ---------------------------------------------------------------------------
// Principals (rooms spec §3.2, §3.5)

/**
 * Who a token speaks for. A Table principal never consumes a player slot and
 * never receives player-only data; `hostControls` decides whether it gets
 * host capabilities (design.md §13).
 */
export type PrincipalScope =
  | { type: "player"; playerId: PlayerId }
  | { type: "table"; hostControls: boolean };

// ---------------------------------------------------------------------------
// Settings (design.md §2)

/** The round-history display setting (engine `ViewSettings.roundHistory`). */
export type RoundHistorySetting = "none" | "last" | "full";

interface CommonRoomSettings {
  illegalPlayMode: IllegalPlayMode;
  startingTokens: number;
  stakeTiers: StakeTier[];
  redealThreshold: number;
  surrenderOption: SurrenderOption;
  roundHistory: RoundHistorySetting;
  livePoints: boolean;
  /** design.md §2/§10: whole seconds before host powers move. */
  hostTransferWaitSeconds: number;
}

/**
 * A room's complete, fixed settings after defaults are applied. The 28 deck
 * always contains the 8s and 7s (rules §10.1), so that flag is always `true`
 * there; it is a choice only in 56 (rules §3). A Table view PIN is never part
 * of the settings that views expose.
 */
export type RoomSettings =
  | (CommonRoomSettings & {
      gameType: "56";
      playerCount: 4 | 6 | 8;
      includeEightsAndSevens: boolean;
    })
  | (CommonRoomSettings & {
      gameType: "28";
      playerCount: 4;
      includeEightsAndSevens: true;
    });

/** design.md §2: starting tokens and stakes are whole numbers 1–999. */
export const maximumWholeSetting = 999;
/** design.md §2: host transfer wait is 1–3,600 whole seconds. */
export const maximumHostTransferWaitSeconds = 3_600;

/** rules §4.2, §10.2: the bid range each game's stake tiers must cover. */
export const stakeTierBidRanges = {
  "56": { minimum: 28, maximum: 56 },
  "28": { minimum: 14, maximum: 28 },
} as const satisfies Record<GameType, { minimum: number; maximum: number }>;

/** rules §9: the highest custom redeal threshold for each game and table. */
export const redealThresholdCaps = {
  "56": { 4: 13, 6: 8, 8: 6 },
  "28": { 4: 6 },
} as const satisfies Record<GameType, Partial<Record<PlayerCount, number>>>;

export const illegalPlayModeSchema = z.enum([
  "block",
  "autoStop",
]) satisfies z.ZodType<IllegalPlayMode>;
export const surrenderOptionSchema = z.enum([
  "off",
  "on",
]) satisfies z.ZodType<SurrenderOption>;
export const roundHistorySchema = z.enum([
  "none",
  "last",
  "full",
]) satisfies z.ZodType<RoundHistorySetting>;

export const startingTokensSchema = z
  .number()
  .int()
  .min(1)
  .max(maximumWholeSetting);
export const hostTransferWaitSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(maximumHostTransferWaitSeconds);

/**
 * One stake tier with every integer inside its documented cap. Gap-free
 * coverage and non-decreasing stakes are a structural check of the whole
 * list, which the engine's config validation owns (rules §7.1).
 */
function stakeTierSchema(gameType: GameType) {
  const bids = stakeTierBidRanges[gameType];
  const bid = z.number().int().min(bids.minimum).max(bids.maximum);
  const stake = z.number().int().min(1).max(maximumWholeSetting);
  return z.strictObject({
    fromBid: bid,
    toBid: bid,
    winStake: stake,
    lossStake: stake,
  }) satisfies z.ZodType<StakeTier>;
}

/** At most one tier per bid amount in the game's range. */
export function stakeTiersSchema(gameType: GameType) {
  const bids = stakeTierBidRanges[gameType];
  return z
    .array(stakeTierSchema(gameType))
    .min(1)
    .max(bids.maximum - bids.minimum + 1);
}

/** rules §9: 0 through the game and player-count cap. */
export function redealThresholdIsWithinCap(
  gameType: GameType,
  playerCount: PlayerCount,
  threshold: number,
): boolean {
  const caps: Partial<Record<PlayerCount, number>> =
    redealThresholdCaps[gameType];
  const cap = caps[playerCount];
  return cap !== undefined && threshold <= cap;
}

export const redealThresholdSchema = z.number().int().min(0);

const settingsTail = {
  illegalPlayMode: illegalPlayModeSchema,
  startingTokens: startingTokensSchema,
  redealThreshold: redealThresholdSchema,
  surrenderOption: surrenderOptionSchema,
  roundHistory: roundHistorySchema,
  livePoints: z.boolean(),
  hostTransferWaitSeconds: hostTransferWaitSecondsSchema,
};

/** Adds an issue when a settings object exceeds its redeal cap (rules §9). */
export function checkRedealThresholdCap(
  settings: {
    gameType: GameType;
    playerCount: PlayerCount;
    redealThreshold: number;
  },
  context: z.RefinementCtx,
): void {
  if (
    !redealThresholdIsWithinCap(
      settings.gameType,
      settings.playerCount,
      settings.redealThreshold,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["redealThreshold"],
      message: "redealThreshold exceeds the game and player-count cap",
    });
  }
}

/** Complete settings as sent in a room view (no defaults are applied). */
export const roomSettingsSchema = z.discriminatedUnion("gameType", [
  z
    .strictObject({
      gameType: z.literal("56"),
      playerCount: z.union([z.literal(4), z.literal(6), z.literal(8)]),
      includeEightsAndSevens: z.boolean(),
      stakeTiers: stakeTiersSchema("56"),
      ...settingsTail,
    })
    .superRefine(checkRedealThresholdCap),
  z
    .strictObject({
      gameType: z.literal("28"),
      playerCount: z.literal(4),
      includeEightsAndSevens: z.literal(true),
      stakeTiers: stakeTiersSchema("28"),
      ...settingsTail,
    })
    .superRefine(checkRedealThresholdCap),
]) satisfies z.ZodType<RoomSettings>;

// ---------------------------------------------------------------------------
// Room phase, players and seats (rooms spec §4, §8.1)

/**
 * The service-level room phase. `arranging` covers the time before the first
 * match of each session (rooms spec §4.1), including the initial room and a
 * session restart whose engine transition waits for the readiness gate.
 * `running` covers a started session, including between matches and after
 * the session ends; the engine view tells those apart.
 */
export type RoomPhase = "arranging" | "running";

export const roomPhaseSchema = z.enum([
  "arranging",
  "running",
]) satisfies z.ZodType<RoomPhase>;

/**
 * One player identity's public facts. A room view lists players in join
 * order. Credentials, PIN state, the last seat and reaction timing are not
 * public; the viewer's own last seat is in `RoomView.viewer`.
 */
export interface PublicPlayer {
  playerId: PlayerId;
  /** The trimmed, normalized display name. */
  name: string;
  seat: Seat | null;
  connected: boolean;
  ready: boolean;
}

export const publicPlayerSchema = z.strictObject({
  playerId: playerIdSchema,
  name: z.string().min(1),
  seat: seatSchema.nullable(),
  connected: z.boolean(),
  ready: z.boolean(),
}) satisfies z.ZodType<PublicPlayer>;

/** A numbered seat, its fixed team (even seats A, odd seats B) and occupant. */
export interface PublicSeat {
  seat: Seat;
  team: Team;
  playerId: PlayerId | null;
}

export const publicSeatSchema = z.strictObject({
  seat: seatSchema,
  team: teamSchema,
  playerId: playerIdSchema.nullable(),
}) satisfies z.ZodType<PublicSeat>;

/** Who or what a gate is still waiting for. */
export interface MissingParticipants {
  /** Seats with no occupant. */
  emptySeats: Seat[];
  /** Player identities that are required but not connected. */
  disconnected: PlayerId[];
  /**
   * Readiness gate: seated players who have not tapped Ready. Stall: new
   * replacements who have not tapped Ready to resume (rooms spec §4.4).
   */
  notReady: PlayerId[];
}

/**
 * The readiness gate or stall status (rooms spec §4.2–§4.4, §5.1).
 *
 * - `readiness`: no match is in progress (arranging, or between matches); the
 *   next match starts automatically once nothing is missing.
 * - `stalled`: an active match is paused until nothing is missing.
 * - `playing`: an active match with nothing missing.
 * - `sessionOver`: the session ended; only the host's Restart session leads on.
 */
export type RoomGate =
  | ({ type: "readiness" } & MissingParticipants)
  | ({ type: "stalled" } & MissingParticipants)
  | { type: "playing" }
  | { type: "sessionOver" };

const missingParticipants = {
  emptySeats: z.array(seatSchema),
  disconnected: z.array(playerIdSchema),
  notReady: z.array(playerIdSchema),
};

export const roomGateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("readiness"), ...missingParticipants }),
  z.strictObject({ type: z.literal("stalled"), ...missingParticipants }),
  z.strictObject({ type: z.literal("playing") }),
  z.strictObject({ type: z.literal("sessionOver") }),
]) satisfies z.ZodType<RoomGate>;

// ---------------------------------------------------------------------------
// Rejections (rooms spec §10)

/** Every stable room rejection code (rooms spec §10). */
export const roomRejectionCodes = [
  "room_full",
  "name_taken",
  "pin_required",
  "pin_incorrect",
  "pin_locked",
  "table_pin_incorrect",
  "table_pin_locked",
  "seat_occupied",
  "not_seated",
  "seat_change_not_allowed",
  "not_readyable",
  "player_disconnected",
  "room_not_ready",
  "not_host",
  "player_not_removable",
  "invalid_host_target",
  "match_stalled",
  "action_not_allowed",
  "reaction_rate_limited",
  "request_too_large",
  "room_code_generation_failed",
] as const;

export type RoomRejectionCode = (typeof roomRejectionCodes)[number];

export const roomRejectionCodeSchema = z.enum(roomRejectionCodes);

/**
 * Safe, non-secret context for a rejection: flat primitive values such as
 * expected ranges, seats, kinds or reasons. Never hidden cards or PINs.
 */
export type RejectionDetails = Record<string, string | number | boolean | null>;

export const rejectionDetailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
) satisfies z.ZodType<RejectionDetails>;
