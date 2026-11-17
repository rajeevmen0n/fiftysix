import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  ClientEngineAction,
  ClientSeatAction,
  EngineRejectionCode,
  EngineView,
  RedactedEngineEvent,
} from "@fiftysix/engine";
import type { z } from "zod";

import type { HelloMessage } from "../connection.js";
import type {
  clientEngineActionSchema,
  clientEngineActionSchemas,
  clientSeatActionSchema,
  RoomCommand,
  roomCommandSchema,
  roomCommandSchemas,
} from "./commands.js";
import type {
  RoomEvent,
  redactedEngineEventSchema,
  roomEventSchema,
} from "./events.js";
import type {
  CreateRoomRequest,
  createRoomRequestSchema,
  JoinRoomRequest,
  joinRoomRequestSchema,
  OpenTableRequest,
  openTableRequestSchema,
  ParsedCreateRoomRequest,
  RoomSettingsInput,
  roomSettingsInputSchema,
} from "./http.js";
import type {
  ClientMessage,
  CommandMessage,
  clientMessageSchemas,
  commandMessageSchemas,
  engineRejectionCodes,
  ServerMessage,
  serverMessageSchema,
} from "./messages.js";
import type {
  PublicPlayer,
  ReactionId,
  RoomGate,
  RoomSettings,
  reactionIds,
  roomGateSchema,
  roomSettingsSchema,
} from "./model.js";
import type {
  AllowedHostAction,
  AllowedRoomAction,
  allowedHostActionSchema,
  allowedRoomActionSchema,
  engineViewSchema,
  RoomView,
  roomViewSchema,
} from "./views.js";

// Compile-time proof that every schema reproduces its declared type exactly,
// so the protocol stays in sync with the engine types it mirrors. These
// checks run under `pnpm typecheck` (tsconfig.test.json); the runtime test
// below only records that this file was compiled and loaded.

/** Exact type identity (not mere assignability). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * Engine types use readonly arrays; Zod infers mutable ones. Comparing both
 * sides as deeply readonly checks the same fields and value types.
 */
type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type Same<A, B> = Equal<DeepReadonly<A>, DeepReadonly<B>>;

function expectTrue<_Check extends true>(): boolean {
  return true;
}

/** The 28 shapes: the engine unions with number-only bids. */
type ClientEngineAction28 =
  | Exclude<ClientEngineAction, { type: "bid" }>
  | { type: "bid"; amount: number };
type RoomCommand28 =
  | Exclude<RoomCommand, { type: "engineAction" }>
  | { type: "engineAction"; action: ClientEngineAction28 };
type CommandMessage28 = Omit<CommandMessage, "command"> & {
  command: RoomCommand28;
};
type ClientMessage28 = HelloMessage | CommandMessage28;

type Out<Schema extends z.ZodType> = z.output<Schema>;
type In<Schema extends z.ZodType> = z.input<Schema>;

const checks = [
  // Engine actions: exactly `ClientEngineAction`, for parse input and output.
  expectTrue<Same<Out<typeof clientSeatActionSchema>, ClientSeatAction>>(),
  expectTrue<Same<In<typeof clientSeatActionSchema>, ClientSeatAction>>(),
  expectTrue<Same<Out<typeof clientEngineActionSchema>, ClientEngineAction>>(),
  expectTrue<Same<In<typeof clientEngineActionSchema>, ClientEngineAction>>(),
  expectTrue<
    Same<Out<(typeof clientEngineActionSchemas)["56"]>, ClientEngineAction>
  >(),
  // The 28 schema is the engine union with number-only bids.
  expectTrue<
    Equal<Out<(typeof clientEngineActionSchemas)["28"]>, ClientEngineAction28>
  >(),
  expectTrue<
    Equal<In<(typeof clientEngineActionSchemas)["28"]>, ClientEngineAction28>
  >(),
  // Room commands.
  expectTrue<Same<Out<typeof roomCommandSchema>, RoomCommand>>(),
  expectTrue<Same<In<typeof roomCommandSchema>, RoomCommand>>(),
  expectTrue<Same<Out<(typeof roomCommandSchemas)["56"]>, RoomCommand>>(),
  expectTrue<Same<Out<(typeof commandMessageSchemas)["56"]>, CommandMessage>>(),
  expectTrue<Same<Out<(typeof clientMessageSchemas)["56"]>, ClientMessage>>(),
  expectTrue<Same<Out<(typeof roomCommandSchemas)["28"]>, RoomCommand28>>(),
  expectTrue<Same<In<(typeof roomCommandSchemas)["28"]>, RoomCommand28>>(),
  expectTrue<
    Same<Out<(typeof commandMessageSchemas)["28"]>, CommandMessage28>
  >(),
  expectTrue<Same<Out<(typeof clientMessageSchemas)["28"]>, ClientMessage28>>(),
  expectTrue<Same<In<(typeof clientMessageSchemas)["28"]>, ClientMessage28>>(),
  // 28 commands are a strict subset of the game-independent shape.
  expectTrue<RoomCommand28 extends RoomCommand ? true : false>(),
  expectTrue<Equal<(typeof reactionIds)[number], ReactionId>>(),
  // Engine views and redacted events.
  expectTrue<Same<Out<typeof engineViewSchema>, EngineView>>(),
  expectTrue<
    Same<Out<typeof redactedEngineEventSchema>, RedactedEngineEvent>
  >(),
  expectTrue<
    Equal<(typeof engineRejectionCodes)[number], EngineRejectionCode>
  >(),
  // Room views, events and messages.
  expectTrue<Same<Out<typeof roomViewSchema>, RoomView>>(),
  expectTrue<Same<Out<typeof roomEventSchema>, RoomEvent>>(),
  expectTrue<Same<Out<typeof serverMessageSchema>, ServerMessage>>(),
  expectTrue<Same<Out<typeof roomGateSchema>, RoomGate>>(),
  expectTrue<Same<Out<typeof roomSettingsSchema>, RoomSettings>>(),
  expectTrue<Same<Out<typeof allowedRoomActionSchema>, AllowedRoomAction>>(),
  expectTrue<Same<Out<typeof allowedHostActionSchema>, AllowedHostAction>>(),
  expectTrue<Same<Out<typeof roomEventSchema>, RoomEvent>>(),
  expectTrue<
    Same<
      Extract<Out<typeof roomEventSchema>, { type: "playerJoined" }>["player"],
      PublicPlayer
    >
  >(),
  // HTTP: the wire body and the parsed result with defaults applied.
  expectTrue<Same<Out<typeof roomSettingsInputSchema>, RoomSettings>>(),
  expectTrue<Same<In<typeof roomSettingsInputSchema>, RoomSettingsInput>>(),
  expectTrue<
    Same<Out<typeof createRoomRequestSchema>, ParsedCreateRoomRequest>
  >(),
  expectTrue<Same<In<typeof createRoomRequestSchema>, CreateRoomRequest>>(),
  expectTrue<Same<Out<typeof joinRoomRequestSchema>, JoinRoomRequest>>(),
  expectTrue<Same<Out<typeof openTableRequestSchema>, OpenTableRequest>>(),
];

it("compiles every protocol type-equality check", () => {
  assert.ok(checks.every(Boolean));
});
