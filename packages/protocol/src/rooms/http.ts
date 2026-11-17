import type { StakeTier } from "@fiftysix/engine";
import { z } from "zod";

import {
  accessTokenSchema,
  checkRedealThresholdCap,
  type GameType,
  hostTransferWaitSecondsSchema,
  illegalPlayModeSchema,
  type RoomCode,
  type RoomRejectionCode,
  type RoomSettings,
  redealThresholdSchema,
  roomCodeSchema,
  roomRejectionCodes,
  roundHistorySchema,
  stakeTiersSchema,
  startingTokensSchema,
  surrenderOptionSchema,
} from "./model.js";

// HTTP request and response bodies (rooms spec §7.1). Each JSON body is
// limited to `maximumRequestBytes` UTF-8 bytes before it is parsed.

export const maximumRequestBytes = 65_536;

// ---------------------------------------------------------------------------
// Names and PINs (rooms spec §3.1, §3.3; design.md §9)

/** The conservative network bound; the service counts graphemes (1–24). */
export const maximumNameBytes = 1_024;

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;
  }
  return bytes;
}

/**
 * Names are single-line: no NUL or other control character (`Cc`, which
 * covers the ASCII controls and DEL plus the C1 controls such as NEL), and no
 * Unicode line or paragraph separator (U+2028, U+2029). Joiners (ZWJ, ZWNJ),
 * variation selectors and combining marks are format or mark characters and
 * stay allowed, so Malayalam conjuncts and emoji sequences survive.
 * Bidirectional embedding, override and isolate controls (U+202A–U+202E,
 * U+2066–U+2069) are rejected so a name cannot reorder surrounding text
 * (rooms spec §3.1, provisional). The service's "at least one visible
 * character" rule is checked after trimming and normalization, with the
 * 1–24 count, so it is not repeated here.
 */
const forbiddenNameCharacter =
  /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

/**
 * A display name as submitted. Trimming, NFKC normalization, the 1–24
 * user-perceived-character count and uniqueness are the room service's
 * authoritative checks; this schema only rejects what can never become a
 * valid name before any service code runs. Ill-formed UTF-16 (a lone
 * surrogate) cannot be normalized or encoded, so it is rejected too.
 */
export const playerNameSchema = z
  .string()
  .min(1)
  .refine((value) => value.isWellFormed(), {
    message: "name must be well-formed Unicode",
  })
  .refine((value) => utf8Length(value) <= maximumNameBytes, {
    message: `name must be at most ${maximumNameBytes} UTF-8 bytes`,
  })
  .refine((value) => !forbiddenNameCharacter.test(value), {
    message: "name must be one line without control or bidi characters",
  });

/** A player or Table view PIN: exactly four ASCII digits (design.md §9). */
export const pinSchema = z.string().regex(/^[0-9]{4}$/);

// ---------------------------------------------------------------------------
// Settings with design.md §2 defaults

/** rules §7.1 default stake tiers. */
export const defaultStakeTiers = {
  "56": [
    { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
    { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
    { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
  ],
  "28": [
    { fromBid: 14, toBid: 19, winStake: 1, lossStake: 2 },
    { fromBid: 20, toBid: 27, winStake: 2, lossStake: 3 },
    { fromBid: 28, toBid: 28, winStake: 3, lossStake: 4 },
  ],
} as const satisfies Record<GameType, readonly StakeTier[]>;

/** design.md §2 advanced-setting defaults. */
export const defaultAdvancedSettings = {
  startingTokens: 10,
  redealThreshold: { "56": 2, "28": 1 },
  surrenderOption: "off",
  roundHistory: "last",
  livePoints: false,
  hostTransferWaitSeconds: 60,
} as const;

function copyTiers(gameType: GameType): StakeTier[] {
  return defaultStakeTiers[gameType].map((tier) => ({ ...tier }));
}

interface AdvancedSettingsInput {
  startingTokens?: number;
  stakeTiers?: StakeTier[];
  redealThreshold?: number;
  surrenderOption?: RoomSettings["surrenderOption"];
  roundHistory?: RoomSettings["roundHistory"];
  livePoints?: boolean;
  hostTransferWaitSeconds?: number;
}

/**
 * Settings as a client submits them: the basic settings are required, every
 * advanced setting is optional (design.md §2). The 8s-and-7s choice exists
 * only for 56; 28 always uses them, so a 28 request may omit the flag or send
 * `true`.
 */
export type RoomSettingsInput =
  | (AdvancedSettingsInput & {
      gameType: "56";
      playerCount: 4 | 6 | 8;
      includeEightsAndSevens: boolean;
      illegalPlayMode: RoomSettings["illegalPlayMode"];
    })
  | (AdvancedSettingsInput & {
      gameType: "28";
      playerCount: 4;
      includeEightsAndSevens?: true;
      illegalPlayMode: RoomSettings["illegalPlayMode"];
    });

function advancedSettings(gameType: GameType) {
  return {
    startingTokens: startingTokensSchema.default(
      defaultAdvancedSettings.startingTokens,
    ),
    stakeTiers: stakeTiersSchema(gameType).default(() => copyTiers(gameType)),
    redealThreshold: redealThresholdSchema.default(
      defaultAdvancedSettings.redealThreshold[gameType],
    ),
    surrenderOption: surrenderOptionSchema.default(
      defaultAdvancedSettings.surrenderOption,
    ),
    roundHistory: roundHistorySchema.default(
      defaultAdvancedSettings.roundHistory,
    ),
    livePoints: z.boolean().default(defaultAdvancedSettings.livePoints),
    hostTransferWaitSeconds: hostTransferWaitSecondsSchema.default(
      defaultAdvancedSettings.hostTransferWaitSeconds,
    ),
  };
}

/**
 * Room settings with defaults applied. Integer caps (design.md §2) and the
 * game/player redeal cap (rules §9) are checked here; whether the deck divides
 * evenly and whether the stake tiers are gap-free and non-decreasing are
 * checked by the engine's config validation when the room is created.
 */
export const roomSettingsInputSchema = z.discriminatedUnion("gameType", [
  z
    .strictObject({
      gameType: z.literal("56"),
      playerCount: z.union([z.literal(4), z.literal(6), z.literal(8)]),
      includeEightsAndSevens: z.boolean(),
      illegalPlayMode: illegalPlayModeSchema,
      ...advancedSettings("56"),
    })
    .superRefine(checkRedealThresholdCap),
  z
    .strictObject({
      gameType: z.literal("28"),
      playerCount: z.literal(4),
      includeEightsAndSevens: z.literal(true).default(true),
      illegalPlayMode: illegalPlayModeSchema,
      ...advancedSettings("28"),
    })
    .superRefine(checkRedealThresholdCap),
]) satisfies z.ZodType<RoomSettings, RoomSettingsInput>;

// ---------------------------------------------------------------------------
// Requests and responses

/**
 * `POST /api/rooms`: create a room and its host identity. `tablePin` is the
 * optional Table view PIN (a basic setting, design.md §2) and `pin` the host's
 * own optional player PIN.
 */
export interface CreateRoomRequest {
  settings: RoomSettingsInput;
  tablePin?: string;
  name: string;
  pin?: string;
}

/** A create request after parsing: settings are complete. */
export interface ParsedCreateRoomRequest {
  settings: RoomSettings;
  tablePin?: string;
  name: string;
  pin?: string;
}

export const createRoomRequestSchema = z.strictObject({
  settings: roomSettingsInputSchema,
  tablePin: pinSchema.optional(),
  name: playerNameSchema,
  pin: pinSchema.optional(),
}) satisfies z.ZodType<ParsedCreateRoomRequest, CreateRoomRequest>;

export interface CreateRoomResponse {
  roomCode: RoomCode;
  token: string;
}

export const createRoomResponseSchema = z.strictObject({
  roomCode: roomCodeSchema,
  token: accessTokenSchema,
}) satisfies z.ZodType<CreateRoomResponse>;

/**
 * `POST /api/rooms/:code/join`: a new identity, or a name-and-PIN rejoin from
 * another browser (rooms spec §3.3).
 */
export interface JoinRoomRequest {
  name: string;
  pin?: string;
}

export const joinRoomRequestSchema = z.strictObject({
  name: playerNameSchema,
  pin: pinSchema.optional(),
}) satisfies z.ZodType<JoinRoomRequest>;

/** A player token for the new or rejoined identity. */
export interface JoinRoomResponse {
  roomCode: RoomCode;
  token: string;
}

export const joinRoomResponseSchema = z.strictObject({
  roomCode: roomCodeSchema,
  token: accessTokenSchema,
}) satisfies z.ZodType<JoinRoomResponse>;

/** `POST /api/rooms/:code/table`: authorize a Table view (rooms spec §3.5). */
export interface OpenTableRequest {
  pin?: string;
}

export const openTableRequestSchema = z.strictObject({
  pin: pinSchema.optional(),
}) satisfies z.ZodType<OpenTableRequest>;

export interface OpenTableResponse {
  roomCode: RoomCode;
  token: string;
}

export const openTableResponseSchema = z.strictObject({
  roomCode: roomCodeSchema,
  token: accessTokenSchema,
}) satisfies z.ZodType<OpenTableResponse>;

// ---------------------------------------------------------------------------
// Errors

/**
 * HTTP failures: every stable room rejection (rooms spec §10), plus
 * `room_not_found` for an unknown room code (404) and `invalid_request` for
 * a body or settings that fail validation (400).
 */
// Provisional, pending user confirmation: rooms spec §10.
export const httpErrorCodes = [
  ...roomRejectionCodes,
  "room_not_found",
  "invalid_request",
] as const;

export type HttpErrorCode =
  | RoomRejectionCode
  | "room_not_found"
  | "invalid_request";

export interface HttpErrorResponse {
  code: HttpErrorCode;
}

export const httpErrorResponseSchema = z.strictObject({
  code: z.enum(httpErrorCodes),
}) satisfies z.ZodType<HttpErrorResponse>;
