import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrincipalScope } from "@fiftysix/protocol";

import { applyHostDeadline } from "./host.js";
import { assertRoomInvariants, assertRoomTransition } from "./invariants.js";
import {
  connectPlayer,
  disconnectPlayer,
  leaveRoom,
  removePlayer,
} from "./presence.js";
import { readinessGate, setReady } from "./readiness.js";
import { takeSeat } from "./seating.js";
import {
  acceptedState,
  config56,
  deepFreeze,
  fullTable,
  player,
  rejectedCode,
  room,
} from "./test-helpers.js";
import type {
  CanonicalRoomEvent,
  DomainResult,
  RoomSnapshot,
} from "./types.js";

const host: PrincipalScope = { type: "player", playerId: "a" };
const table: PrincipalScope = { type: "table", hostControls: true };
const lockedTable: PrincipalScope = { type: "table", hostControls: false };

/** A started match with every seat filled, connected and Ready. */
const playing = (): RoomSnapshot =>
  deepFreeze(room({ stage: "active", players: fullTable({ ready: true }) }));

/** Applies one accepted transition and checks the transition invariants. */
function step(
  before: RoomSnapshot,
  result: DomainResult,
): RoomSnapshot & { events: CanonicalRoomEvent[] } {
  const after = acceptedState(result);
  assertRoomTransition(before, after);
  return after;
}

/**
 * Asserts an accepted departure: invariants hold, the identity is gone and
 * exactly its tokens are revoked.
 */
function departure(
  before: RoomSnapshot,
  result: DomainResult,
  playerId: string,
): RoomSnapshot & { events: CanonicalRoomEvent[] } {
  if (!result.ok) {
    assert.fail(`expected acceptance, got ${result.code}`);
  }
  assertRoomInvariants(result.state);
  assertRoomTransition(before, result.state);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state)), result.state);
  assert.deepEqual(result.effects, [{ type: "revokePlayerTokens", playerId }]);
  assert.ok(result.state.players.every((entry) => entry.id !== playerId));
  assert.ok(!result.state.seats.includes(playerId));
  return { ...result.state, events: result.events };
}

const disconnected = (state: RoomSnapshot, playerId: string, now: number) =>
  acceptedState(disconnectPlayer(state, playerId, now));

describe("disconnectPlayer", () => {
  it("keeps the identity, seat and Ready and records the time", () => {
    const before = deepFreeze(
      room({ stage: "matchOver", players: fullTable({ ready: true }) }),
    );
    const after = disconnected(before, "b", 5_000);
    assert.deepEqual(after.events, [
      { type: "playerDisconnected", playerId: "b" },
    ]);
    const b = after.players[1];
    assert.equal(b?.connected, false);
    assert.equal(b?.disconnectedAt, 5_000);
    assert.equal(b?.seat, 1);
    assert.equal(b?.ready, true);
    assert.equal(after.emptySince, null);
    assert.equal(after.hostTransfer, null);
    assert.equal(before.players[1]?.connected, true);
  });

  it("rejects an unknown or already disconnected identity", () => {
    const state = disconnected(playing(), "b", 5_000);
    assert.equal(
      rejectedCode(disconnectPlayer(state, "b", 6_000)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(disconnectPlayer(state, "zz", 6_000)),
      "action_not_allowed",
    );
  });

  it("stalls an active match once, however many seats go missing", () => {
    const before = playing();
    const first = step(before, disconnectPlayer(before, "b", 5_000));
    assert.deepEqual(first.events, [
      { type: "playerDisconnected", playerId: "b" },
      { type: "matchStalled" },
    ]);
    assert.equal(first.engine, before.engine);
    const second = step(first, disconnectPlayer(first, "c", 6_000));
    assert.deepEqual(second.events, [
      { type: "playerDisconnected", playerId: "c" },
    ]);
    assert.deepEqual(readinessGate(second), {
      type: "stalled",
      emptySeats: [],
      disconnected: ["b", "c"],
      notReady: [],
    });
  });

  it("starts the host transfer wait from the disconnect", () => {
    const config = { ...config56(), hostTransferWaitSeconds: 90 };
    const before = deepFreeze(room({ config, players: fullTable() }));
    const after = disconnected(before, "a", 5_000);
    assert.deepEqual(after.hostTransfer, { hostId: "a", deadline: 95_000 });
    assert.equal(after.hostId, "a");
    // Another player's disconnect leaves the host's deadline alone.
    const later = disconnected(after, "b", 7_000);
    assert.deepEqual(later.hostTransfer, { hostId: "a", deadline: 95_000 });
  });

  it("starts the expiry clock when the last player connection ends", () => {
    const state = deepFreeze(room({ players: [{ id: "a" }, { id: "b" }] }));
    const one = disconnected(state, "b", 5_000);
    assert.equal(one.emptySince, null);
    const none = disconnected(one, "a", 8_000);
    assert.equal(none.emptySince, 8_000);
  });
});

describe("connectPlayer", () => {
  it("restores a returning identity to its seat with its Ready", () => {
    const away = disconnected(
      deepFreeze(
        room({ stage: "matchOver", players: fullTable({ ready: true }) }),
      ),
      "c",
      5_000,
    );
    const back = acceptedState(connectPlayer(away, "c", 9_000));
    assert.deepEqual(back.events, [{ type: "playerConnected", playerId: "c" }]);
    const c = back.players[2];
    assert.equal(c?.connected, true);
    assert.equal(c?.disconnectedAt, null);
    assert.equal(c?.seat, 2);
    assert.equal(c?.ready, true);
    // An unseated identity returns unseated.
    const unseated = deepFreeze(
      room({ players: [{ id: "a" }, { id: "b", connected: false }] }),
    );
    const returned = acceptedState(connectPlayer(unseated, "b", 9_000));
    assert.equal(returned.players[1]?.seat, null);
  });

  it("rejects an unknown or already connected identity", () => {
    const state = playing();
    assert.equal(
      rejectedCode(connectPlayer(state, "a", 1)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(connectPlayer(state, "zz", 1)),
      "action_not_allowed",
    );
  });

  it("resumes an active match only when every seat is back", () => {
    const one = disconnected(playing(), "b", 5_000);
    const two = disconnected(one, "c", 6_000);
    const partly = step(two, connectPlayer(two, "b", 7_000));
    assert.deepEqual(partly.events, [
      { type: "playerConnected", playerId: "b" },
    ]);
    const resumed = step(partly, connectPlayer(partly, "c", 8_000));
    assert.deepEqual(resumed.events, [
      { type: "playerConnected", playerId: "c" },
      { type: "matchResumed" },
    ]);
    assert.deepEqual(readinessGate(resumed), { type: "playing" });
    assert.equal(resumed.engine, one.engine);
  });

  it("stops the expiry clock", () => {
    const empty = deepFreeze(
      room({ players: [{ id: "a", connected: false }] }),
    );
    assert.equal(empty.emptySince, 1_000);
    const back = acceptedState(connectPlayer(empty, "a", 9_000));
    assert.equal(back.emptySince, null);
  });

  it("cancels the host's pending transfer when it returns before the deadline", () => {
    const away = disconnected(
      deepFreeze(room({ players: fullTable() })),
      "a",
      0,
    );
    assert.deepEqual(away.hostTransfer, { hostId: "a", deadline: 60_000 });
    // Another player's return leaves the host's deadline in place.
    const other = acceptedState(
      connectPlayer(disconnected(away, "b", 1_000), "b", 2_000),
    );
    assert.deepEqual(other.hostTransfer, { hostId: "a", deadline: 60_000 });
    const back = acceptedState(connectPlayer(other, "a", 59_999));
    assert.deepEqual(back.events, [{ type: "playerConnected", playerId: "a" }]);
    assert.equal(back.hostId, "a");
    assert.equal(back.hostTransfer, null);
    // The timer callback is now stale.
    assert.equal(
      rejectedCode(applyHostDeadline(back, "a", 60_000)),
      "action_not_allowed",
    );
  });

  it("completes an elapsed transfer when the host returns before its callback", () => {
    const away = disconnected(
      deepFreeze(room({ players: fullTable() })),
      "a",
      0,
    );
    const late = acceptedState(connectPlayer(away, "a", 60_000));
    assert.deepEqual(late.events, [
      { type: "playerConnected", playerId: "a" },
      { type: "hostChanged", hostId: "b", reason: "waitElapsed" },
    ]);
    assert.equal(late.hostId, "b");
    assert.equal(late.hostTransfer, null);
    assert.equal(late.players[0]?.connected, true);
    assert.equal(
      rejectedCode(applyHostDeadline(late, "a", 60_000)),
      "action_not_allowed",
    );
  });

  it("keeps the role for a late host when nobody else is connected", () => {
    const alone = deepFreeze(
      room({ players: [{ id: "a" }, { id: "b", connected: false }] }),
    );
    const away = disconnected(alone, "a", 0);
    assert.equal(away.emptySince, 0);
    const late = acceptedState(connectPlayer(away, "a", 70_000));
    assert.deepEqual(late.events, [{ type: "playerConnected", playerId: "a" }]);
    assert.equal(late.hostId, "a");
    assert.equal(late.hostTransfer, null);
  });

  it("gives a pending host role to the next player to connect", () => {
    const empty = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0, connected: false },
          { id: "b", connected: false },
        ],
        hostId: null,
      }),
    );
    const claimed = acceptedState(connectPlayer(empty, "b", 9_000));
    assert.deepEqual(claimed.events, [
      { type: "playerConnected", playerId: "b" },
      { type: "hostChanged", hostId: "b", reason: "waitElapsed" },
    ]);
    assert.equal(claimed.hostId, "b");
    // The next arrival is an ordinary reconnect.
    const next = acceptedState(connectPlayer(claimed, "a", 9_500));
    assert.equal(next.hostId, "b");
    assert.deepEqual(next.events, [{ type: "playerConnected", playerId: "a" }]);
  });
});

describe("leaveRoom", () => {
  it("removes a seated identity permanently and clears Ready before a match", () => {
    const before = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0, ready: true },
          { id: "b", seat: 1, ready: true },
          { id: "c" },
        ],
      }),
    );
    const after = departure(before, leaveRoom(before, "b", 5_000), "b");
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "b", seat: 1 },
      { type: "playerLeft", playerId: "b", reason: "left" },
      { type: "readinessCleared" },
    ]);
    assert.deepEqual(after.seats, ["a", null, null, null]);
    assert.equal(after.players[0]?.ready, false);
    assert.equal(after.hostId, "a");
    assert.equal(before.players.length, 3);
  });

  it("clears nobody's Ready when an unseated identity leaves", () => {
    const before = deepFreeze(
      room({
        stage: "matchOver",
        players: [...fullTable({ ready: true }).slice(0, 3), { id: "n" }],
      }),
    );
    const after = departure(before, leaveRoom(before, "n", 5_000), "n");
    assert.deepEqual(after.events, [
      { type: "playerLeft", playerId: "n", reason: "left" },
    ]);
    assert.ok(after.players.every((entry) => entry.ready));
  });

  it("vacates an active seat, keeps its engine state and others' confirmations", () => {
    const before = playing();
    const after = departure(before, leaveRoom(before, "c", 5_000), "c");
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "c", seat: 2 },
      { type: "playerLeft", playerId: "c", reason: "left" },
      { type: "matchStalled" },
    ]);
    assert.equal(after.engine, before.engine);
    assert.ok(after.players.every((entry) => entry.ready));
    assert.deepEqual(readinessGate(after), {
      type: "stalled",
      emptySeats: [2],
      disconnected: [],
      notReady: [],
    });
  });

  it("transfers a departing host's role immediately", () => {
    const before = deepFreeze(
      room({
        config: config56(6),
        players: [
          { id: "a", seat: 2 },
          { id: "b", seat: 0 },
          { id: "c", seat: 4, connected: false },
          { id: "d", seat: 5 },
        ],
      }),
    );
    const after = departure(before, leaveRoom(before, "a", 5_000), "a");
    assert.deepEqual(after.events.at(-1), {
      type: "hostChanged",
      hostId: "d",
      reason: "hostDeparted",
    });
    assert.equal(after.hostId, "d");
    assert.equal(after.hostTransfer, null);
  });

  it("leaves host selection pending when the last connected player leaves", () => {
    const before = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0 },
          { id: "b", connected: false },
        ],
      }),
    );
    const after = departure(before, leaveRoom(before, "a", 5_000), "a");
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "a", seat: 0 },
      { type: "playerLeft", playerId: "a", reason: "left" },
      { type: "hostChanged", hostId: null, reason: "hostDeparted" },
    ]);
    assert.equal(after.hostId, null);
    assert.equal(after.emptySince, 5_000);
    // The last identity leaving empties the room.
    const gone = departure(after, leaveRoom(after, "b", 6_000), "b");
    assert.deepEqual(gone.players, []);
    assert.equal(gone.emptySince, 5_000);
  });

  it("rejects an unknown identity", () => {
    assert.equal(
      rejectedCode(leaveRoom(playing(), "zz", 1)),
      "action_not_allowed",
    );
  });
});

describe("removePlayer", () => {
  it("requires host controls", () => {
    const state = deepFreeze(room({ players: [{ id: "a" }, { id: "b" }] }));
    const guest: PrincipalScope = { type: "player", playerId: "b" };
    assert.equal(rejectedCode(removePlayer(state, guest, "a", 1)), "not_host");
    assert.equal(
      rejectedCode(removePlayer(state, lockedTable, "b", 1)),
      "not_host",
    );
    assert.equal(
      rejectedCode(removePlayer(state, host, "zz", 1)),
      "action_not_allowed",
    );
  });

  it("removes anyone before, between and after matches", () => {
    for (const stage of ["arranging", "matchOver", "sessionOver"] as const) {
      const before = deepFreeze(room({ stage, players: fullTable() }));
      const after = departure(before, removePlayer(before, host, "c", 1), "c");
      assert.deepEqual(after.events.slice(0, 2), [
        { type: "seatLeft", playerId: "c", seat: 2 },
        { type: "playerLeft", playerId: "c", reason: "removed" },
      ]);
    }
  });

  it("lets a host player leave only through Leave room", () => {
    const state = deepFreeze(room({ players: fullTable() }));
    assert.equal(
      rejectedCode(removePlayer(state, host, "a", 1)),
      "player_not_removable",
    );
    // A Table view with host controls may remove the host player.
    const after = departure(state, removePlayer(state, table, "a", 1), "a");
    assert.deepEqual(after.events.at(-1), {
      type: "hostChanged",
      hostId: "b",
      reason: "hostDeparted",
    });
  });

  it("removes only a disconnected player during an active match", () => {
    const before = playing();
    assert.equal(
      rejectedCode(removePlayer(before, host, "d", 1)),
      "player_not_removable",
    );
    const stalled = disconnected(before, "d", 5_000);
    const after = departure(
      stalled,
      removePlayer(stalled, host, "d", 6_000),
      "d",
    );
    assert.deepEqual(after.events, [
      { type: "seatLeft", playerId: "d", seat: 3 },
      { type: "playerLeft", playerId: "d", reason: "removed" },
    ]);
    assert.equal(after.engine, before.engine);
    assert.ok(after.players.every((entry) => entry.ready));
  });

  it("clears a removed host's pending transfer and passes the role on", () => {
    const away = disconnected(playing(), "a", 5_000);
    assert.notEqual(away.hostTransfer, null);
    const after = departure(away, removePlayer(away, table, "a", 6_000), "a");
    assert.equal(after.hostId, "b");
    assert.equal(after.hostTransfer, null);
    assert.equal(
      rejectedCode(applyHostDeadline(after, "a", 65_000)),
      "action_not_allowed",
    );
  });

  it("starts the expiry clock when a Table view removes the last connection", () => {
    const before = deepFreeze(
      room({ players: [{ id: "a", connected: false }, { id: "b" }] }),
    );
    const after = departure(
      before,
      removePlayer(before, table, "b", 7_000),
      "b",
    );
    assert.equal(after.emptySince, 7_000);
    assert.equal(after.hostId, "a");
  });
});

describe("stalled replacement", () => {
  it("lets a new identity take the empty seat and resume after Ready", () => {
    const start = playing();
    const away = step(start, disconnectPlayer(start, "d", 5_000));
    const removed = departure(away, removePlayer(away, host, "d", 6_000), "d");
    // A new identity joins unseated (the access service creates it).
    const joined: RoomSnapshot = deepFreeze({
      ...removed,
      players: [...removed.players, player({ id: "n" }, 9)],
    });
    assertRoomInvariants(joined);
    const seated = step(joined, takeSeat(joined, "n", 3));
    assert.deepEqual(seated.events, [
      { type: "seatTaken", playerId: "n", seat: 3 },
    ]);
    assert.deepEqual(readinessGate(seated), {
      type: "stalled",
      emptySeats: [],
      disconnected: [],
      notReady: ["n"],
    });
    const resumed = step(seated, setReady(seated, "n", true));
    assert.deepEqual(resumed.events, [
      { type: "readyChanged", playerId: "n", ready: true },
      { type: "matchResumed" },
    ]);
    // The seat-owned engine state never moved.
    assert.equal(resumed.engine, start.engine);
  });

  it("does not resume while another seat is still missing", () => {
    const start = playing();
    const one = disconnected(start, "c", 5_000);
    const two = disconnected(one, "d", 5_000);
    const removed = departure(two, removePlayer(two, host, "d", 6_000), "d");
    const joined: RoomSnapshot = deepFreeze({
      ...removed,
      players: [...removed.players, player({ id: "n" }, 9)],
    });
    const seated = step(joined, takeSeat(joined, "n", 3));
    const confirmed = step(seated, setReady(seated, "n", true));
    assert.deepEqual(confirmed.events, [
      { type: "readyChanged", playerId: "n", ready: true },
    ]);
    const resumed = step(confirmed, connectPlayer(confirmed, "c", 7_000));
    assert.deepEqual(resumed.events, [
      { type: "playerConnected", playerId: "c" },
      { type: "matchResumed" },
    ]);
  });
});
