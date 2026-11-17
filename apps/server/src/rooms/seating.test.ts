import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrincipalScope } from "@fiftysix/protocol";

import {
  hostMovePlayer,
  hostSwapPlayers,
  leaveSeat,
  setFirstDealer,
  takeSeat,
} from "./seating.js";
import {
  acceptedState,
  deepFreeze,
  fullTable,
  rejectedCode,
  room,
} from "./test-helpers.js";
import type { RoomSnapshot } from "./types.js";

const host: PrincipalScope = { type: "player", playerId: "a" };
const table: PrincipalScope = { type: "table", hostControls: true };
const lockedTable: PrincipalScope = { type: "table", hostControls: false };

function readyFlags(state: RoomSnapshot): boolean[] {
  return state.players.map((entry) => entry.ready);
}

describe("takeSeat", () => {
  it("seats an unseated player while arranging without changing the input", () => {
    const before = deepFreeze(
      room({ players: [{ id: "a" }, { id: "b", seat: 2 }] }),
    );
    const after = acceptedState(takeSeat(before, "a", 1));
    assert.deepEqual(after.seats, [null, "a", "b", null]);
    assert.equal(after.players[0]?.seat, 1);
    assert.equal(after.players[0]?.lastSeat, 1);
    assert.deepEqual(after.events, [
      { type: "seatTaken", playerId: "a", seat: 1 },
    ]);
    assert.equal(before.players[0]?.seat, null);
  });

  it("moves a seated player directly and clears everyone's Ready", () => {
    const before = room({
      players: [
        { id: "a", seat: 0, ready: true },
        { id: "b", seat: 1, ready: true },
      ],
    });
    const after = acceptedState(takeSeat(before, "a", 3));
    assert.deepEqual(after.seats, [null, "b", null, "a"]);
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "a", seat: 0 },
      { type: "seatTaken", playerId: "a", seat: 3 },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(readyFlags(after), [false, false]);
  });

  it("lets a newcomer sit while arranging, clearing everyone's Ready", () => {
    const before = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0, ready: true },
          { id: "b", seat: 1, ready: true },
          { id: "n" },
        ],
      }),
    );
    const after = acceptedState(takeSeat(before, "n", 2));
    assert.deepEqual(after.events, [
      { type: "seatTaken", playerId: "n", seat: 2 },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(readyFlags(after), [false, false, false]);
    assert.deepEqual(readyFlags(before), [true, true, false]);
  });

  it("emits readinessCleared only when a Ready flag changed", () => {
    const after = acceptedState(
      takeSeat(room({ players: [{ id: "a" }] }), "a", 0),
    );
    assert.deepEqual(after.events, [
      { type: "seatTaken", playerId: "a", seat: 0 },
    ]);
  });

  it("rejects occupied, own, out-of-range seats and unknown players", () => {
    const state = room({ players: [{ id: "a", seat: 0 }, { id: "b" }] });
    assert.equal(rejectedCode(takeSeat(state, "b", 0)), "seat_occupied");
    assert.equal(rejectedCode(takeSeat(state, "a", 0)), "seat_occupied");
    assert.equal(rejectedCode(takeSeat(state, "b", 4)), "action_not_allowed");
    assert.equal(rejectedCode(takeSeat(state, "b", -1)), "action_not_allowed");
    assert.equal(rejectedCode(takeSeat(state, "zz", 1)), "action_not_allowed");
  });

  it("locks seated players once the session's first match has begun", () => {
    const players = [
      { id: "a", seat: 0 },
      { id: "b", seat: 1 },
      { id: "c", seat: 2 },
    ];
    for (const stage of ["active", "matchOver", "sessionOver"] as const) {
      const state = room({ stage, players });
      assert.equal(
        rejectedCode(takeSeat(state, "a", 3)),
        "seat_change_not_allowed",
        stage,
      );
    }
  });

  it("lets a newcomer claim one empty seat between matches, clearing Ready", () => {
    const state = room({
      stage: "matchOver",
      players: [
        { id: "a", seat: 0, ready: true },
        { id: "b", seat: 1, ready: true },
        { id: "c", seat: 2 },
        { id: "n" },
      ],
    });
    const after = acceptedState(takeSeat(state, "n", 3));
    assert.deepEqual(after.events, [
      { type: "seatTaken", playerId: "n", seat: 3 },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(readyFlags(after), [false, false, false, false]);
    // The claim locks the newcomer like everyone else.
    assert.equal(
      rejectedCode(leaveSeat(after, "n")),
      "seat_change_not_allowed",
    );
  });

  it("lets a replacement claim a vacated seat during a match, keeping confirmations", () => {
    const state = room({
      stage: "active",
      players: [
        { id: "a", seat: 0, ready: true },
        { id: "b", seat: 1, ready: true },
        { id: "c", seat: 2, ready: true },
        { id: "n" },
      ],
    });
    const after = acceptedState(takeSeat(state, "n", 3));
    assert.deepEqual(after.events, [
      { type: "seatTaken", playerId: "n", seat: 3 },
    ]);
    assert.deepEqual(readyFlags(after), [true, true, true, false]);
    assert.equal(
      rejectedCode(takeSeat(after, "n", 3)),
      "seat_change_not_allowed",
    );
  });

  it("rejects a newcomer's claim once the session is over", () => {
    const state = room({
      stage: "sessionOver",
      players: [{ id: "a", seat: 0 }, { id: "n" }],
    });
    assert.equal(
      rejectedCode(takeSeat(state, "n", 1)),
      "seat_change_not_allowed",
    );
  });
});

describe("leaveSeat", () => {
  it("unseats while arranging, keeps lastSeat and clears Ready", () => {
    const before = deepFreeze(
      room({
        players: [
          { id: "a", seat: 2, ready: true },
          { id: "b", seat: 1, ready: true },
        ],
      }),
    );
    const after = acceptedState(leaveSeat(before, "a"));
    assert.equal(after.players[0]?.seat, null);
    assert.equal(after.players[0]?.lastSeat, 2);
    assert.equal(after.seats[2], null);
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "a", seat: 2 },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(readyFlags(after), [false, false]);
  });

  it("rejects an unseated player and every running stage", () => {
    assert.equal(
      rejectedCode(leaveSeat(room({ players: [{ id: "a" }] }), "a")),
      "not_seated",
    );
    assert.equal(
      rejectedCode(leaveSeat(room({ players: [{ id: "a" }] }), "zz")),
      "action_not_allowed",
    );
    for (const stage of ["active", "matchOver", "sessionOver"] as const) {
      const state = room({ stage, players: fullTable() });
      assert.equal(
        rejectedCode(leaveSeat(state, "b")),
        "seat_change_not_allowed",
        stage,
      );
    }
  });
});

describe("hostMovePlayer", () => {
  it("requires host controls", () => {
    const state = deepFreeze(room({ players: [{ id: "a" }, { id: "b" }] }));
    const guest: PrincipalScope = { type: "player", playerId: "b" };
    assert.equal(
      rejectedCode(hostMovePlayer(state, guest, "b", 0)),
      "not_host",
    );
    assert.equal(
      rejectedCode(hostMovePlayer(state, lockedTable, "b", 0)),
      "not_host",
    );
    const pending = deepFreeze(room({ players: [{ id: "a" }], hostId: null }));
    assert.equal(
      rejectedCode(hostMovePlayer(pending, host, "a", 0)),
      "not_host",
    );
    acceptedState(hostMovePlayer(state, table, "b", 0));
  });

  it("moves unseated and seated players to empty seats while arranging", () => {
    const state = deepFreeze(
      room({ players: [{ id: "a", seat: 0, ready: true }, { id: "b" }] }),
    );
    const seated = acceptedState(hostMovePlayer(state, host, "b", 3));
    assert.equal(state.players[1]?.seat, null);
    assert.equal(state.players[0]?.ready, true);
    assert.deepEqual(seated.events, [
      { type: "playerMoved", playerId: "b", from: null, to: 3 },
      { type: "readinessCleared" },
    ]);
    const moved = acceptedState(
      hostMovePlayer(deepFreeze(seated), host, "a", 1),
    );
    assert.deepEqual(moved.seats, [null, "a", null, "b"]);
    assert.deepEqual(moved.events, [
      { type: "playerMoved", playerId: "a", from: 0, to: 1 },
    ]);
  });

  it("rejects occupied, own and bad seats and unknown players", () => {
    const state = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0 },
          { id: "b", seat: 1 },
        ],
      }),
    );
    assert.equal(
      rejectedCode(hostMovePlayer(state, host, "b", 0)),
      "seat_occupied",
    );
    assert.equal(
      rejectedCode(hostMovePlayer(state, host, "b", 1)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(hostMovePlayer(state, host, "b", 4)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(hostMovePlayer(state, host, "zz", 2)),
      "action_not_allowed",
    );
  });

  it("rearranges between matches but never during a match or after the session", () => {
    const players = [
      { id: "a", seat: 0, ready: true },
      { id: "b", seat: 1, ready: true },
      { id: "c", seat: 2, ready: true },
    ];
    const before = deepFreeze(room({ stage: "matchOver", players }));
    const between = acceptedState(hostMovePlayer(before, host, "c", 3));
    assert.deepEqual(readyFlags(before), [true, true, true]);
    assert.deepEqual(readyFlags(between), [false, false, false]);
    for (const stage of ["active", "sessionOver"] as const) {
      assert.equal(
        rejectedCode(
          hostMovePlayer(deepFreeze(room({ stage, players })), host, "c", 3),
        ),
        "seat_change_not_allowed",
        stage,
      );
    }
  });
});

describe("hostSwapPlayers", () => {
  it("swaps two seated players and clears Ready", () => {
    const before = deepFreeze(
      room({
        stage: "matchOver",
        players: fullTable({ ready: true }),
      }),
    );
    const after = acceptedState(hostSwapPlayers(before, table, "a", "d"));
    assert.deepEqual(after.seats, ["d", "b", "c", "a"]);
    assert.equal(after.players[0]?.lastSeat, 3);
    assert.equal(after.players[3]?.lastSeat, 0);
    assert.deepEqual(after.events, [
      {
        type: "playersSwapped",
        first: "a",
        firstSeat: 3,
        second: "d",
        secondSeat: 0,
      },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(readyFlags(after), [false, false, false, false]);
  });

  it("rejects non-hosts, unseated or identical players and active play", () => {
    const state = room({ players: [{ id: "a", seat: 0 }, { id: "b" }] });
    const guest: PrincipalScope = { type: "player", playerId: "b" };
    assert.equal(
      rejectedCode(hostSwapPlayers(state, guest, "a", "b")),
      "not_host",
    );
    assert.equal(
      rejectedCode(hostSwapPlayers(state, host, "a", "b")),
      "not_seated",
    );
    assert.equal(
      rejectedCode(hostSwapPlayers(state, host, "a", "a")),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(hostSwapPlayers(state, host, "a", "zz")),
      "action_not_allowed",
    );
    for (const stage of ["active", "sessionOver"] as const) {
      assert.equal(
        rejectedCode(
          hostSwapPlayers(
            room({ stage, players: fullTable() }),
            host,
            "a",
            "b",
          ),
        ),
        "seat_change_not_allowed",
        stage,
      );
    }
  });
});

describe("setFirstDealer", () => {
  it("changes the first dealer while arranging and clears Ready", () => {
    const before = deepFreeze(
      room({
        players: [{ id: "a", seat: 0, ready: true }],
        firstDealer: 1,
      }),
    );
    const after = acceptedState(setFirstDealer(before, host, 3));
    assert.equal(after.firstDealer, 3);
    assert.deepEqual(after.events, [
      { type: "firstDealerChanged", seat: 3 },
      { type: "readinessCleared" },
    ]);
    assert.equal(before.firstDealer, 1);
  });

  it("works in a restarted session's arranging phase", () => {
    const state = room({
      stage: "restartArranging",
      players: [{ id: "a" }],
      firstDealer: 2,
    });
    assert.equal(acceptedState(setFirstDealer(state, table, 0)).firstDealer, 0);
  });

  it("rejects non-hosts, unchanged or bad seats, and running rooms", () => {
    const state = room({ players: [{ id: "a" }, { id: "b" }], firstDealer: 1 });
    const guest: PrincipalScope = { type: "player", playerId: "b" };
    assert.equal(rejectedCode(setFirstDealer(state, guest, 2)), "not_host");
    assert.equal(
      rejectedCode(setFirstDealer(state, host, 1)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(setFirstDealer(state, host, 4)),
      "action_not_allowed",
    );
    for (const stage of ["active", "matchOver", "sessionOver"] as const) {
      assert.equal(
        rejectedCode(
          setFirstDealer(room({ stage, players: fullTable() }), host, 2),
        ),
        "action_not_allowed",
        stage,
      );
    }
  });
});
