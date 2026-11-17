import type {
  ClientEngineAction,
  ClientHostAction,
  ClientSeatAction,
} from "@fiftysix/engine";
import { z } from "zod";

import {
  bidStyleSchema,
  bidSuitSchema,
  cardSchema,
  type GameType,
  type PlayerId,
  playerIdSchema,
  type ReactionId,
  reactionIdSchema,
  seatSchema,
  surrenderVoteChoiceSchema,
  teamSchema,
} from "./model.js";

// Client room commands (rooms spec §7.2). A command never names its actor or
// an engine action source: the server attaches the authenticated principal
// and, for engine actions, the seat or host source (engine spec §2).

// ---------------------------------------------------------------------------
// Engine actions (engine `ClientEngineAction`, source omitted)

const passSchema = z.strictObject({ type: z.literal("pass") });
const doubleSchema = z.strictObject({ type: z.literal("double") });
const redoubleSchema = z.strictObject({ type: z.literal("redouble") });
const placeCardSchema = z.strictObject({
  type: z.literal("placeCard"),
  card: cardSchema,
});
const askRevealSchema = z.strictObject({ type: z.literal("askReveal") });
const playCardSchema = z.strictObject({
  type: z.literal("playCard"),
  card: cardSchema,
});
const proposeSurrenderSchema = z.strictObject({
  type: z.literal("proposeSurrender"),
});
const voteSurrenderSchema = z.strictObject({
  type: z.literal("voteSurrender"),
  vote: surrenderVoteChoiceSchema,
});
const endMatchSchema = z.strictObject({
  type: z.literal("endMatch"),
  resolution: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("restart") }),
    z.strictObject({ type: z.literal("award"), team: teamSchema }),
  ]),
}) satisfies z.ZodType<ClientHostAction>;

/**
 * The engine's bid shape. `suit` and `style` may be absent but never `null`
 * (engine E004/E005: presence, not nullness, is checked). Whether a 56 suit
 * and style are well-formed together is the engine's `invalidBid` check
 * (engine spec §8.2); the amount range is its `bidOutOfRange`/`bidTooLow`.
 */
const bidSchema = z.strictObject({
  type: z.literal("bid"),
  amount: z.number().int(),
  suit: bidSuitSchema.optional(),
  style: bidStyleSchema.optional(),
});

/**
 * engine spec §8.2: 28 bids are numbers only. The client never sends a suit
 * or style for a 28 bid, so the protocol rejects either key (including a
 * `null` value) before the engine sees it.
 */
const bid28Schema = z.strictObject({
  type: z.literal("bid"),
  amount: z.number().int(),
});

function seatActionOptions<Bid extends typeof bidSchema | typeof bid28Schema>(
  bid: Bid,
) {
  return [
    bid,
    passSchema,
    doubleSchema,
    redoubleSchema,
    placeCardSchema,
    askRevealSchema,
    playCardSchema,
    proposeSurrenderSchema,
    voteSurrenderSchema,
  ] as const;
}

/** Exactly the engine's `ClientSeatAction` union. */
export const clientSeatActionSchema = z.discriminatedUnion(
  "type",
  seatActionOptions(bidSchema),
) satisfies z.ZodType<ClientSeatAction>;

/**
 * Exactly the engine's `ClientEngineAction` union, independent of the game.
 * Use `clientEngineActionSchemas[gameType]` to parse a room's commands.
 */
export const clientEngineActionSchema = z.discriminatedUnion("type", [
  ...seatActionOptions(bidSchema),
  endMatchSchema,
]) satisfies z.ZodType<ClientEngineAction>;

const clientEngineAction28Schema = z.discriminatedUnion("type", [
  ...seatActionOptions(bid28Schema),
  endMatchSchema,
]) satisfies z.ZodType<ClientEngineAction>;

/** The engine actions a room of each game type accepts at the network edge. */
export const clientEngineActionSchemas = {
  "56": clientEngineActionSchema,
  "28": clientEngineAction28Schema,
} as const satisfies Record<GameType, z.ZodType<ClientEngineAction>>;

// ---------------------------------------------------------------------------
// Room commands

/**
 * rooms spec §7.2. Seats are bounded by the largest table here; the room
 * service checks them against the room's own seat count.
 */
export type RoomCommand =
  | { type: "takeSeat"; seat: number }
  | { type: "leaveSeat" }
  | { type: "setReady"; ready: boolean }
  | { type: "hostMovePlayer"; playerId: PlayerId; seat: number }
  | { type: "hostSwapPlayers"; first: PlayerId; second: PlayerId }
  | { type: "setFirstDealer"; seat: number }
  | { type: "removePlayer"; playerId: PlayerId }
  | { type: "transferHost"; playerId: PlayerId }
  | { type: "engineAction"; action: ClientEngineAction }
  | { type: "sendReaction"; reaction: ReactionId }
  | { type: "restartSession" }
  | { type: "leaveRoom" };

export type RoomCommandType = RoomCommand["type"];

function roomCommandOptions<
  Action extends
    | typeof clientEngineActionSchema
    | typeof clientEngineAction28Schema,
>(action: Action) {
  return [
    z.strictObject({ type: z.literal("takeSeat"), seat: seatSchema }),
    z.strictObject({ type: z.literal("leaveSeat") }),
    z.strictObject({ type: z.literal("setReady"), ready: z.boolean() }),
    z.strictObject({
      type: z.literal("hostMovePlayer"),
      playerId: playerIdSchema,
      seat: seatSchema,
    }),
    z.strictObject({
      type: z.literal("hostSwapPlayers"),
      first: playerIdSchema,
      second: playerIdSchema,
    }),
    z.strictObject({ type: z.literal("setFirstDealer"), seat: seatSchema }),
    z.strictObject({
      type: z.literal("removePlayer"),
      playerId: playerIdSchema,
    }),
    z.strictObject({
      type: z.literal("transferHost"),
      playerId: playerIdSchema,
    }),
    z.strictObject({ type: z.literal("engineAction"), action }),
    z.strictObject({
      type: z.literal("sendReaction"),
      reaction: reactionIdSchema,
    }),
    z.strictObject({ type: z.literal("restartSession") }),
    z.strictObject({ type: z.literal("leaveRoom") }),
  ] as const;
}

/**
 * Exactly the `RoomCommand` union, independent of the game. The server parses
 * a room's commands with `roomCommandSchemas[gameType]`, which additionally
 * rejects a `suit` or `style` on a 28 bid.
 */
export const roomCommandSchema = z.discriminatedUnion(
  "type",
  roomCommandOptions(clientEngineActionSchema),
) satisfies z.ZodType<RoomCommand>;

const roomCommand28Schema = z.discriminatedUnion(
  "type",
  roomCommandOptions(clientEngineAction28Schema),
) satisfies z.ZodType<RoomCommand>;

export const roomCommandSchemas = {
  "56": roomCommandSchema,
  "28": roomCommand28Schema,
} as const satisfies Record<GameType, z.ZodType<RoomCommand>>;
