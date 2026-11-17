import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertRoomInvariants,
  assertRoomTransition,
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
    // A pending transfer belongs to the current host while it is away.
    const awayHost = room({
      players: [
        { id: "a", seat: 0, connected: false },
        { id: "b", seat: 1 },
      ],
    });
    assertRoomInvariants(awayHost);
    assertRoomInvariants({
      ...awayHost,
      hostTransfer: { hostId: "a", deadline: 60_000 },
    });
    assert.equal(
      violation({
        ...awayHost,
        hostTransfer: { hostId: "zz", deadline: 60_000 },
      }),
      "invalidHostTransfer",
    );
    assert.equal(
      violation({
        ...awayHost,
        hostTransfer: { hostId: "a", deadline: Number.NaN },
      }),
      "invalidHostTransfer",
    );
    assert.equal(
      violation({
        ...awayHost,
        hostTransfer: { hostId: "b", deadline: 60_000 },
      }),
      "invalidHostTransfer",
    );
    assert.equal(
      violation({
        ...base(),
        hostTransfer: { hostId: "a", deadline: 60_000 },
      }),
      "invalidHostTransfer",
    );
  });

  it("allows a null host only while no player is connected", () => {
    assert.equal(violation({ ...base(), hostId: null }), "invalidHost");
    const empty = room({
      players: [
        { id: "a", seat: 0, connected: false },
        { id: "b", connected: false },
      ],
      hostId: null,
    });
    assertRoomInvariants(empty);
    assert.equal(
      violation({ ...empty, hostTransfer: { hostId: "a", deadline: 9_000 } }),
      "invalidHostTransfer",
    );
  });

  it("ties disconnect times and the expiry clock to presence", () => {
    const state = base();
    const players = state.players.map((entry) =>
      entry.id === "b" ? { ...entry, disconnectedAt: 2_000 } : entry,
    );
    assert.equal(violation({ ...state, players }), "invalidPresence");
    assert.equal(violation({ ...state, emptySince: 2_000 }), "invalidPresence");
    const empty = room({
      players: [{ id: "a", connected: false }],
    });
    assertRoomInvariants(empty);
    assert.equal(violation({ ...empty, emptySince: null }), "invalidPresence");
    // A crash may leave a disconnected identity without a timestamp.
    assertRoomInvariants({
      ...empty,
      players: empty.players.map((entry) => ({
        ...entry,
        disconnectedAt: null,
      })),
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

function transitionViolation(
  before: RoomSnapshot,
  after: RoomSnapshot,
): RoomInvariantCode {
  try {
    assertRoomTransition(before, after);
  } catch (error) {
    assert.ok(error instanceof RoomInvariantError);
    assert.equal(error.roomId, after.id);
    assert.equal(error.revision, after.revision);
    return error.code;
  }
  assert.fail("expected a transition invariant violation");
}

describe("assertRoomTransition", () => {
  it("starts a match only with every seat filled, connected and Ready", () => {
    const before = room({ players: fullTable({ ready: true }) });
    const started = room({
      stage: "active",
      players: fullTable({ ready: true }),
    });
    assertRoomTransition(before, started);
    assertRoomTransition(
      room({ stage: "matchOver", players: fullTable({ ready: true }) }),
      started,
    );
    const notReady = room({
      stage: "active",
      players: fullTable({ ready: true }).map((entry) =>
        entry.id === "c" ? { ...entry, ready: false } : entry,
      ),
    });
    assert.equal(transitionViolation(before, notReady), "invalidMatchStart");
    const away = room({
      stage: "active",
      players: fullTable({ ready: true }).map((entry) =>
        entry.id === "c" ? { ...entry, connected: false } : entry,
      ),
    });
    assert.equal(transitionViolation(before, away), "invalidMatchStart");
    const empty = room({
      stage: "active",
      players: fullTable({ ready: true }).slice(0, 3),
    });
    assert.equal(transitionViolation(before, empty), "invalidMatchStart");
    // Leaving an active match is not checked here.
    assertRoomTransition(
      started,
      room({ stage: "matchOver", players: fullTable() }),
    );
  });

  it("changes an active seat's identity only through replacement", () => {
    const playing = room({
      stage: "active",
      players: fullTable({ ready: true }),
    });
    assertRoomTransition(playing, playing);
    // The occupant left the room: the seat empties.
    const vacated: RoomSnapshot = {
      ...playing,
      players: playing.players.filter((entry) => entry.id !== "d"),
      seats: ["a", "b", "c", null],
    };
    assertRoomTransition(playing, vacated);
    // An identity that stays cannot be unseated or swapped mid-match.
    const unseated: RoomSnapshot = {
      ...vacated,
      players: playing.players.map((entry) =>
        entry.id === "d" ? { ...entry, seat: null, ready: false } : entry,
      ),
    };
    assert.equal(
      transitionViolation(playing, unseated),
      "invalidSeatTransition",
    );
    const swapped: RoomSnapshot = {
      ...playing,
      players: playing.players.map((entry) =>
        entry.id === "a"
          ? { ...entry, seat: 1, lastSeat: 1 }
          : entry.id === "b"
            ? { ...entry, seat: 0, lastSeat: 0 }
            : entry,
      ),
      seats: ["b", "a", "c", "d"],
    };
    assert.equal(
      transitionViolation(playing, swapped),
      "invalidSeatTransition",
    );

    // A new identity fills the empty seat unconfirmed.
    const stalled = room({
      stage: "active",
      players: [...fullTable({ ready: true }).slice(0, 3), { id: "n" }],
    });
    const claimed = room({
      stage: "active",
      players: [
        ...fullTable({ ready: true }).slice(0, 3),
        { id: "n", seat: 3 },
      ],
    });
    assertRoomTransition(stalled, claimed);
    const preconfirmed = room({
      stage: "active",
      players: [
        ...fullTable({ ready: true }).slice(0, 3),
        { id: "n", seat: 3, ready: true, replacementReady: true },
      ],
    });
    assert.equal(
      transitionViolation(stalled, preconfirmed),
      "invalidSeatTransition",
    );
    const replaced: RoomSnapshot = {
      ...claimed,
      players: claimed.players.map((entry) =>
        entry.id === "n" ? { ...entry, id: "m" } : entry,
      ),
      seats: ["a", "b", "c", "m"],
    };
    assert.equal(
      transitionViolation(claimed, replaced),
      "invalidSeatTransition",
    );
  });
});
