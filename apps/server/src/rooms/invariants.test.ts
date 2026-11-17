import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertRoomInvariants,
  type RoomInvariantCode,
  RoomInvariantError,
} from "./invariants.js";
import { config56, engineIn, fullTable, player, room } from "./test-helpers.js";
import type { RoomSnapshot } from "./types.js";

function violation(state: RoomSnapshot): RoomInvariantCode {
  try {
    assertRoomInvariants(state);
  } catch (error) {
    assert.ok(error instanceof RoomInvariantError);
    assert.equal(
      error.message,
      `room ${state.id} revision ${state.revision}: invariant ${error.code} violated`,
    );
    assert.equal(error.roomId, state.id);
    assert.equal(error.revision, state.revision);
    return error.code;
  }
  assert.fail("expected an invariant violation");
}

const base = (): RoomSnapshot =>
  room({
    players: [
      { id: "a", seat: 0, ready: true },
      { id: "b", seat: 1 },
      { id: "c", lastSeat: 2 },
    ],
  });

describe("assertRoomInvariants", () => {
  it("accepts consistent rooms in every stage", () => {
    assertRoomInvariants(base());
    assertRoomInvariants(room({ players: [], hostId: null }));
    for (const stage of [
      "restartArranging",
      "active",
      "matchOver",
      "sessionOver",
    ] as const) {
      assertRoomInvariants(room({ stage, players: fullTable() }));
    }
    assertRoomInvariants(
      room({
        stage: "active",
        players: fullTable({ ready: true, replacementReady: true }),
      }),
    );
    assertRoomInvariants(
      room({ config: config56(8), players: [{ id: "a", seat: 7 }] }),
    );
  });

  it("checks the room identity, revision and timestamps", () => {
    assert.equal(violation({ ...base(), id: "" }), "invalidRoomIdentity");
    assert.equal(
      violation({ ...base(), code: "K7MQ40" }),
      "invalidRoomIdentity",
    );
    assert.equal(violation({ ...base(), revision: -1 }), "invalidRoomIdentity");
    assert.equal(violation({ ...base(), createdAt: 1.5 }), "invalidTimestamp");
    assert.equal(violation({ ...base(), emptySince: -3 }), "invalidTimestamp");
  });

  it("enforces the identity cap and seat count", () => {
    const state = room({ players: fullTable() });
    assert.equal(
      violation({
        ...state,
        players: [...state.players, player({ id: "e" }, 9)],
      }),
      "identityCapExceeded",
    );
    assert.equal(
      violation({ ...state, seats: [...state.seats, null] }),
      "invalidSeatCount",
    );
  });

  it("requires valid, unique IDs, canonical unique names and join order", () => {
    const state = base();
    const [a, b, c] = state.players as [
      RoomSnapshot["players"][number],
      RoomSnapshot["players"][number],
      RoomSnapshot["players"][number],
    ];
    const withPlayers = (players: RoomSnapshot["players"]): RoomSnapshot => ({
      ...state,
      players,
    });
    assert.equal(
      violation(withPlayers([a, b, { ...c, id: "bad id" }])),
      "invalidPlayerId",
    );
    assert.equal(
      violation(withPlayers([a, b, { ...c, id: "b" }])),
      "duplicatePlayerId",
    );
    assert.equal(
      violation(withPlayers([a, b, { ...c, displayName: " padded" }])),
      "invalidName",
    );
    assert.equal(
      violation(
        withPlayers([a, b, { ...c, displayName: "", normalizedName: "" }]),
      ),
      "invalidName",
    );
    // The input cap is not re-checked: a stored canonical name stays valid.
    const long = "x".repeat(40);
    assertRoomInvariants(
      withPlayers([a, b, { ...c, displayName: long, normalizedName: long }]),
    );
    assert.equal(
      violation(withPlayers([a, b, { ...c, normalizedName: "Player c" }])),
      "invalidName",
    );
    assert.equal(
      violation(
        withPlayers([
          a,
          b,
          { ...c, displayName: "PLAYER B", normalizedName: "player b" },
        ]),
      ),
      "duplicateName",
    );
    assert.equal(
      violation(withPlayers([a, b, { ...c, joinOrder: 1 }])),
      "invalidJoinOrder",
    );
  });

  it("keeps the seat map bidirectional and in range", () => {
    const state = base();
    assert.equal(
      violation({ ...state, seats: ["a", "b", "zz", null] }),
      "seatMismatch",
    );
    assert.equal(
      violation({ ...state, seats: ["a", "b", "a", null] }),
      "seatMismatch",
    );
    assert.equal(
      violation({ ...state, seats: ["a", null, null, null] }),
      "seatMismatch",
    );
    const players = state.players.map((entry) =>
      entry.id === "c" ? { ...entry, seat: 4, lastSeat: 4 } : entry,
    );
    assert.equal(violation({ ...state, players }), "seatOutOfRange");
    const stale = state.players.map((entry) =>
      entry.id === "a" ? { ...entry, lastSeat: 3 } : entry,
    );
    assert.equal(violation({ ...state, players: stale }), "invalidLastSeat");
    assert.equal(
      violation({ ...state, firstDealer: 4 }),
      "firstDealerOutOfRange",
    );
  });

  it("allows Ready only for seated players and replacement state only mid-match", () => {
    const state = base();
    const unseatedReady = state.players.map((entry) =>
      entry.id === "c" ? { ...entry, ready: true } : entry,
    );
    assert.equal(
      violation({ ...state, players: unseatedReady }),
      "invalidReadiness",
    );
    const replacementWhileArranging = state.players.map((entry) =>
      entry.id === "a" ? { ...entry, replacementReady: true } : entry,
    );
    assert.equal(
      violation({ ...state, players: replacementWhileArranging }),
      "invalidReplacementState",
    );
    assert.equal(
      violation(
        room({
          stage: "active",
          players: fullTable({ ready: false, replacementReady: true }),
        }),
      ),
      "invalidReplacementState",
    );
    assert.equal(
      violation(
        room({ stage: "sessionOver", players: fullTable({ ready: true }) }),
      ),
      "invalidReadiness",
    );
  });

  it("requires the host and a pending transfer to name current identities", () => {
    assert.equal(violation({ ...base(), hostId: "zz" }), "invalidHost");
    assert.equal(
      violation({
        ...base(),
        hostTransfer: { hostId: "zz", deadline: 60_000 },
      }),
      "invalidHostTransfer",
    );
    assert.equal(
      violation({
        ...base(),
        hostTransfer: { hostId: "a", deadline: Number.NaN },
      }),
      "invalidHostTransfer",
    );
    assertRoomInvariants({
      ...base(),
      hostTransfer: { hostId: "a", deadline: 60_000 },
    });
  });

  it("checks PIN credential shapes", () => {
    const pin = {
      salt: "c2FsdA",
      digest: "ZGlnZXN0",
      failures: 0,
      lockedUntil: null,
    };
    assertRoomInvariants({ ...base(), tablePin: pin });
    assert.equal(
      violation({ ...base(), tablePin: { ...pin, failures: -1 } }),
      "invalidPin",
    );
    const players = base().players.map((entry) =>
      entry.id === "a" ? { ...entry, pin: { ...pin, digest: "" } } : entry,
    );
    assert.equal(violation({ ...base(), players }), "invalidPin");
  });

  it("matches the room phase, engine phase and engine seat count", () => {
    const config = config56();
    assert.equal(
      violation({ ...base(), engine: engineIn(config, "active") }),
      "phaseEngineMismatch",
    );
    assert.equal(
      violation({
        ...base(),
        phase: { type: "arranging", pending: "restart" },
        engine: engineIn(config, "matchOver"),
      }),
      "phaseEngineMismatch",
    );
    assert.equal(
      violation({ ...base(), phase: { type: "running" } }),
      "phaseEngineMismatch",
    );
    assert.equal(
      violation({
        ...room({ stage: "active", players: fullTable() }),
        engine: engineIn(config56(6), "active"),
      }),
      "engineConfigMismatch",
    );
  });
});
