import type { EngineRejectionCode } from "@fiftysix/engine";
import { z } from "zod";

import {
  type HelloMessage,
  helloMessageSchema,
  type ProtocolErrorMessage,
  protocolErrorMessageSchema,
} from "../connection.js";
import { type RoomCommand, roomCommandSchemas } from "./commands.js";
import { type RoomEvent, roomEventSchema } from "./events.js";
import {
  type CommandId,
  commandIdSchema,
  type GameType,
  type RejectionDetails,
  type RoomRejectionCode,
  rejectionDetailsSchema,
  revisionSchema,
  roomRejectionCodeSchema,
} from "./model.js";
import { type RoomView, roomViewSchema } from "./views.js";

// WebSocket messages (rooms spec §7.2–§7.4). Every message is a JSON object
// whose `type` names it.

// ---------------------------------------------------------------------------
// Client to server

/**
 * A room mutation after `hello` was accepted. A client keeps `commandId`
 * until the command is accepted or rejected and resends the same envelope
 * after an uncertain disconnect; a repeat returns the recorded outcome.
 */
export interface CommandMessage {
  type: "command";
  commandId: CommandId;
  command: RoomCommand;
}

function commandMessageSchema<Game extends GameType>(gameType: Game) {
  return z.strictObject({
    type: z.literal("command"),
    commandId: commandIdSchema,
    command: roomCommandSchemas[gameType],
  });
}

/** A connection's first message must be `hello`; parse it with `helloMessageSchema`. */
export type ClientMessage = HelloMessage | CommandMessage;

/**
 * Messages from a connection whose room is known, by the room's game type.
 * The game type matters only to a 28 bid, which must not carry a suit or
 * style. Before `hello` is accepted, the room is unknown and only
 * `helloMessageSchema` applies.
 */
export const commandMessageSchemas = {
  "56": commandMessageSchema("56"),
  "28": commandMessageSchema("28"),
} as const satisfies Record<GameType, z.ZodType<CommandMessage>>;

export const clientMessageSchemas = {
  "56": z.discriminatedUnion("type", [
    helloMessageSchema,
    commandMessageSchemas["56"],
  ]),
  "28": z.discriminatedUnion("type", [
    helloMessageSchema,
    commandMessageSchemas["28"],
  ]),
} as const satisfies Record<GameType, z.ZodType<ClientMessage>>;

// ---------------------------------------------------------------------------
// Server to client

/**
 * The complete current view after a successful `hello`. It never replays
 * earlier events or animations. Here and in the messages below, the room and
 * host capability lists that rooms spec §7.3 names travel inside `view`
 * (`allowedRoomActions`, `allowedHostActions`), as plan R001's `RoomView`
 * defines.
 */
export interface HelloAcceptedMessage {
  type: "helloAccepted";
  revision: number;
  view: RoomView;
}

/**
 * An accepted transition: this recipient's redacted events in order, then
 * the resulting view. `commandId` is set only for the principal whose
 * command produced the transition.
 */
export interface UpdateMessage {
  type: "update";
  revision: number;
  events: RoomEvent[];
  view: RoomView;
  commandId?: CommandId;
}

/**
 * A valid but disallowed command, with the caller's current state. Room
 * rejections use the stable room codes; engine rejections pass the engine's
 * code through unchanged (rooms spec §10).
 */
export type CommandRejection =
  | { source: "room"; code: RoomRejectionCode; details?: RejectionDetails }
  | { source: "engine"; code: EngineRejectionCode; details?: RejectionDetails };

export type CommandRejectedMessage = {
  type: "commandRejected";
  commandId: CommandId;
  revision: number;
  view: RoomView;
} & CommandRejection;

/** Why a connection's access ended. The message is terminal. */
export type AccessRevokedReason =
  | "signed_in_elsewhere"
  | "removed"
  | "left_room"
  | "room_expired";

export interface AccessRevokedMessage {
  type: "accessRevoked";
  reason: AccessRevokedReason;
}

export type ServerMessage =
  | HelloAcceptedMessage
  | UpdateMessage
  | CommandRejectedMessage
  | ProtocolErrorMessage
  | AccessRevokedMessage;

export const engineRejectionCodes = [
  "invalidConfig",
  "invalidSeat",
  "actionNotAllowed",
  "invalidDeck",
  "notYourTurn",
  "invalidBid",
  "bidTooLow",
  "bidOutOfRange",
  "cannotAfford",
  "doubleNotAllowed",
  "noDoubleActive",
  "cardNotInHand",
  "faceDownNotPlayable",
  "surrenderVoteRunning",
  "revealNotAllowed",
  "illegalPlay",
] as const satisfies readonly EngineRejectionCode[];

/** The message and its view must describe the same revision. */
function revisionMatchesView(
  message: { revision: number; view: { revision: number } },
  context: z.RefinementCtx,
): void {
  if (message.revision !== message.view.revision) {
    context.addIssue({
      code: "custom",
      path: ["view", "revision"],
      message: "view revision must match the message revision",
    });
  }
}

const helloAcceptedMessageSchema = z
  .strictObject({
    type: z.literal("helloAccepted"),
    revision: revisionSchema,
    view: roomViewSchema,
  })
  .superRefine(revisionMatchesView) satisfies z.ZodType<HelloAcceptedMessage>;

const updateMessageSchema = z
  .strictObject({
    type: z.literal("update"),
    revision: revisionSchema,
    events: z.array(roomEventSchema),
    view: roomViewSchema,
    commandId: commandIdSchema.optional(),
  })
  .superRefine(revisionMatchesView) satisfies z.ZodType<UpdateMessage>;

const commandRejectedFields = {
  type: z.literal("commandRejected"),
  commandId: commandIdSchema,
  revision: revisionSchema,
  view: roomViewSchema,
  details: rejectionDetailsSchema.optional(),
};

const commandRejectedMessageSchema = z.discriminatedUnion("source", [
  z
    .strictObject({
      ...commandRejectedFields,
      source: z.literal("room"),
      code: roomRejectionCodeSchema,
    })
    .superRefine(revisionMatchesView),
  z
    .strictObject({
      ...commandRejectedFields,
      source: z.literal("engine"),
      code: z.enum(engineRejectionCodes),
    })
    .superRefine(revisionMatchesView),
]) satisfies z.ZodType<CommandRejectedMessage>;

const accessRevokedMessageSchema = z.strictObject({
  type: z.literal("accessRevoked"),
  reason: z.enum([
    "signed_in_elsewhere",
    "removed",
    "left_room",
    "room_expired",
  ]),
}) satisfies z.ZodType<AccessRevokedMessage>;

/**
 * Every server message. The server checks each outgoing message with this
 * schema before serializing it, so a field outside the public shapes never
 * reaches a client.
 */
export const serverMessageSchema = z.discriminatedUnion("type", [
  helloAcceptedMessageSchema,
  updateMessageSchema,
  commandRejectedMessageSchema,
  protocolErrorMessageSchema,
  accessRevokedMessageSchema,
]) satisfies z.ZodType<ServerMessage>;
