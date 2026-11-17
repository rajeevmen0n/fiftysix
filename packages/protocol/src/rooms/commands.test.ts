import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClientEngineAction } from "@fiftysix/engine";

import {
  clientEngineActionSchemas,
  type RoomCommand,
  roomCommandSchemas,
} from "./commands.js";
import { clientMessageSchemas, commandMessageSchemas } from "./messages.js";
import { reactionIds } from "./model.js";

const card = { suit: "spades", rank: "J", copy: 1 } as const;

/** One of every engine action a client may send (engine `ClientEngineAction`). */
const engineActions: ClientEngineAction[] = [
  { type: "bid", amount: 30, suit: "spades", style: "numberFirst" },
  { type: "bid", amount: 28, suit: "noTrump" },
  { type: "pass" },
  { type: "double" },
  { type: "redouble" },
  { type: "placeCard", card },
  { type: "askReveal" },
  { type: "playCard", card: { ...card, copy: 2 } },
  { type: "proposeSurrender" },
  { type: "voteSurrender", vote: "yes" },
  { type: "voteSurrender", vote: "no" },
  { type: "endMatch", resolution: { type: "restart" } },
  { type: "endMatch", resolution: { type: "award", team: "B" } },
];

const roomCommands: RoomCommand[] = [
  { type: "takeSeat", seat: 0 },
  { type: "takeSeat", seat: 7 },
  { type: "leaveSeat" },
  { type: "setReady", ready: true },
  { type: "setReady", ready: false },
  { type: "hostMovePlayer", playerId: "p-1", seat: 3 },
  { type: "hostSwapPlayers", first: "p-1", second: "p_2" },
  { type: "setFirstDealer", seat: 5 },
  { type: "removePlayer", playerId: "AbC123" },
  { type: "transferHost", playerId: "AbC123" },
  ...reactionIds.map((reaction) => ({
    type: "sendReaction" as const,
    reaction,
  })),
  { type: "restartSession" },
  { type: "leaveRoom" },
  ...engineActions.map((action) => ({
    type: "engineAction" as const,
    action,
  })),
];

describe("engine actions", () => {
  it("accepts every client engine action unchanged in 56", () => {
    for (const action of engineActions) {
      assert.deepEqual(clientEngineActionSchemas["56"].parse(action), action);
    }
  });

  it("accepts every 28 action except bids carrying a suit or style", () => {
    assert.deepEqual(
      clientEngineActionSchemas["28"].parse({ type: "bid", amount: 16 }),
      { type: "bid", amount: 16 },
    );
    for (const action of engineActions.filter((item) => item.type !== "bid")) {
      assert.deepEqual(clientEngineActionSchemas["28"].parse(action), action);
    }
    for (const bid of [
      { type: "bid", amount: 16, suit: "spades" },
      { type: "bid", amount: 16, suit: "noTrump" },
      { type: "bid", amount: 16, suit: null },
      { type: "bid", amount: 16, style: "numberFirst" },
      { type: "bid", amount: 16, style: null },
    ]) {
      assert.equal(
        clientEngineActionSchemas["28"].safeParse(bid).success,
        false,
        JSON.stringify(bid),
      );
    }
  });

  it("rejects a claimed source, null bid fields and malformed values", () => {
    const invalid: unknown[] = [
      { type: "pass", source: { type: "seat", seat: 1 } },
      { type: "endMatch", resolution: { type: "restart" }, source: "host" },
      { type: "deal", deck: [] },
      { type: "startNextMatch" },
      { type: "restartSession", firstDealer: 0 },
      { type: "bid", amount: 30, suit: null },
      { type: "bid", amount: 30, suit: "spades", style: null },
      { type: "bid", amount: 30.5, suit: "spades", style: "suitFirst" },
      { type: "bid", amount: "30", suit: "spades", style: "suitFirst" },
      { type: "bid", amount: 30, suit: "stars", style: "suitFirst" },
      { type: "bid", amount: 30, suit: "spades", style: "loud" },
      { type: "playCard", card: { suit: "spades", rank: "J", copy: 3 } },
      { type: "playCard", card: { suit: "spades", rank: "2", copy: 1 } },
      { type: "playCard", card: { ...card, hidden: true } },
      { type: "voteSurrender", vote: "maybe" },
      { type: "endMatch", resolution: { type: "award", team: "C" } },
      { type: "endMatch", resolution: { type: "award" } },
    ];
    for (const gameType of ["56", "28"] as const) {
      for (const action of invalid) {
        assert.equal(
          clientEngineActionSchemas[gameType].safeParse(action).success,
          false,
          `${gameType} ${JSON.stringify(action)}`,
        );
      }
    }
  });
});

describe("room commands", () => {
  it("accepts every room command in 56", () => {
    for (const command of roomCommands) {
      assert.deepEqual(roomCommandSchemas["56"].parse(command), command);
    }
  });

  it("accepts every room command in 28, with number-only bids", () => {
    const commands28: RoomCommand[] = [
      ...roomCommands.filter(
        (command) =>
          command.type !== "engineAction" || command.action.type !== "bid",
      ),
      { type: "engineAction", action: { type: "bid", amount: 14 } },
      { type: "engineAction", action: { type: "bid", amount: 28 } },
    ];
    assert.equal(commands28.length, roomCommands.length);
    for (const command of commands28) {
      assert.deepEqual(roomCommandSchemas["28"].parse(command), command);
    }
  });

  it("applies the 28 bid rule inside engineAction commands", () => {
    const bid = {
      type: "engineAction",
      action: { type: "bid", amount: 20, suit: "hearts" },
    };
    assert.equal(roomCommandSchemas["56"].safeParse(bid).success, true);
    assert.equal(roomCommandSchemas["28"].safeParse(bid).success, false);
  });

  it("rejects unknown commands, fields, seats, IDs and reactions", () => {
    const invalid: unknown[] = [
      { type: "startMatch" },
      { type: "takeSeat", seat: 8 },
      { type: "takeSeat", seat: -1 },
      { type: "takeSeat", seat: 1.5 },
      { type: "takeSeat" },
      { type: "leaveSeat", seat: 1 },
      { type: "setReady", ready: "yes" },
      { type: "hostMovePlayer", playerId: "", seat: 1 },
      { type: "hostMovePlayer", playerId: "a b", seat: 1 },
      { type: "hostMovePlayer", playerId: "x".repeat(65), seat: 1 },
      { type: "removePlayer", playerId: "p", reason: "rude" },
      { type: "sendReaction", reaction: "👍" },
      { type: "sendReaction", reaction: "Nice" },
      { type: "sendReaction", reaction: "hello", text: "hi" },
      { type: "engineAction", action: { type: "pass" }, seat: 2 },
      { type: "leaveRoom", playerId: "p" },
    ];
    for (const command of invalid) {
      assert.equal(
        roomCommandSchemas["56"].safeParse(command).success,
        false,
        JSON.stringify(command),
      );
    }
  });
});

describe("client messages", () => {
  it("wraps commands with a bounded command ID", () => {
    const message = {
      type: "command",
      commandId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      command: { type: "leaveSeat" },
    };
    assert.deepEqual(commandMessageSchemas["28"].parse(message), message);
    assert.deepEqual(clientMessageSchemas["56"].parse(message), message);
    for (const commandId of ["", "a".repeat(65), "id with space", 7]) {
      assert.equal(
        clientMessageSchemas["56"].safeParse({ ...message, commandId }).success,
        false,
      );
    }
    assert.equal(
      clientMessageSchemas["56"].safeParse({ ...message, extra: 1 }).success,
      false,
    );
  });

  it("accepts hello and rejects unknown message types", () => {
    assert.deepEqual(
      clientMessageSchemas["28"].parse({ type: "hello", token: "a.b" }),
      { type: "hello", token: "a.b" },
    );
    for (const message of [
      { type: "hello", token: "" },
      { type: "hello", token: "a".repeat(4_097) },
      { type: "action", action: { type: "pass" } },
    ]) {
      assert.equal(
        clientMessageSchemas["28"].safeParse(message).success,
        false,
      );
    }
  });
});
