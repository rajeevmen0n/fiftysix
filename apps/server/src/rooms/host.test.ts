import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrincipalScope } from "@fiftysix/protocol";

import {
  applyHostDeadline,
  chooseSuccessor,
  hostTransferDeadline,
  transferHost,
} from "./host.js";
import { connectPlayer, disconnectPlayer } from "./presence.js";
import { findPlayer } from "./snapshot.js";
import {
  acceptedState,
  config56,
  deepFreeze,
  fullTable,
  type PlayerFixture,
  rejectedCode,
  room,
} from "./test-helpers.js";
import type { PlayerRecord, RoomSnapshot } from "./types.js";

const host: PrincipalScope = { type: "player", playerId: "a" };
const table: PrincipalScope = { type: "table", hostControls: true };
const lockedTable: PrincipalScope = { type: "table", hostControls: false };

function sixSeats(players: PlayerFixture[]): RoomSnapshot {
  return deepFreeze(room({ config: config56(6), players }));
}

function record(state: RoomSnapshot, playerId: string): PlayerRecord {
  const found = findPlayer(state, playerId);
  assert.ok(found);
  return found;
}

describe("chooseSuccessor", () => {
  it("takes the next connected occupied seat counter-clockwise", () => {
    const state = sixSeats([
      { id: "h", seat: 2, connected: false },
      { id: "p", seat: 3, connected: false },
      { id: "q", seat: 5 },
      { id: "r", seat: 0 },
    ]);
    assert.equal(chooseSuccessor(state, record(state, "h")), "q");
    // The circle wraps past the last seat.
    const wrapped = sixSeats([
      { id: "h", seat: 4, connected: false },
      { id: "p", seat: 5, connected: false },
      { id: "q", seat: 1 },
      { id: "r", seat: 3 },
    ]);
    assert.equal(chooseSuccessor(wrapped, record(wrapped, "h")), "q");
  });

  it("starts from an unseated host's last seat", () => {
    const state = sixSeats([
      { id: "h", lastSeat: 3, connected: false },
      { id: "p", seat: 1 },
      { id: "q", seat: 5 },
    ]);
    assert.equal(chooseSuccessor(state, record(state, "h")), "q");
    // The new occupant of that last seat comes last in the circle.
    const reoccupied = sixSeats([
      { id: "h", lastSeat: 3, connected: false },
      { id: "p", seat: 3 },
      { id: "q", seat: 2 },
    ]);
    assert.equal(chooseSuccessor(reoccupied, record(reoccupied, "h")), "q");
    const onlyThere = sixSeats([
      { id: "h", lastSeat: 3, connected: false },
      { id: "p", seat: 3 },
      { id: "q" },
    ]);
    assert.equal(chooseSuccessor(onlyThere, record(onlyThere, "h")), "p");
  });

  it("falls back to the earliest-joined connected player", () => {
    const unseatedOnly = sixSeats([
      { id: "h", seat: 0, connected: false },
      { id: "p", seat: 1, connected: false },
      { id: "q" },
      { id: "r" },
    ]);
    assert.equal(chooseSuccessor(unseatedOnly, record(unseatedOnly, "h")), "q");
    // A host that never sat starts with the earliest-joined connected
    // player, seated or not.
    const neverSat = sixSeats([
      { id: "h", connected: false },
      { id: "p", connected: false },
      { id: "q" },
      { id: "r", seat: 4 },
    ]);
    assert.equal(chooseSuccessor(neverSat, record(neverSat, "h")), "q");
  });

  it("never chooses the former host and finds nobody when none is connected", () => {
    const connectedHost = sixSeats([{ id: "h", seat: 0 }, { id: "p" }]);
    assert.equal(
      chooseSuccessor(connectedHost, record(connectedHost, "h")),
      "p",
    );
    const alone = sixSeats([{ id: "h", seat: 0 }]);
    assert.equal(chooseSuccessor(alone, record(alone, "h")), null);
    const nobody = sixSeats([
      { id: "h", seat: 0, connected: false },
      { id: "p", seat: 1, connected: false },
    ]);
    assert.equal(chooseSuccessor(nobody, record(nobody, "h")), null);
  });
});

describe("transferHost", () => {
  it("requires host controls", () => {
    const state = deepFreeze(room({ players: fullTable() }));
    const guest: PrincipalScope = { type: "player", playerId: "b" };
    assert.equal(rejectedCode(transferHost(state, guest, "c", 1)), "not_host");
    assert.equal(
      rejectedCode(transferHost(state, lockedTable, "c", 1)),
      "not_host",
    );
  });

  it("hands the role to any other seated player at any time", () => {
    for (const stage of [
      "arranging",
      "active",
      "matchOver",
      "sessionOver",
    ] as const) {
      const before = deepFreeze(room({ stage, players: fullTable() }));
      const after = acceptedState(transferHost(before, host, "c", 1));
      assert.deepEqual(after.events, [
        { type: "hostChanged", hostId: "c", reason: "handedOver" },
      ]);
      assert.equal(after.hostId, "c");
      assert.equal(after.hostTransfer, null);
      assert.equal(before.hostId, "a");
      // The former host does not keep host controls.
      assert.equal(rejectedCode(transferHost(after, host, "b", 2)), "not_host");
    }
  });

  it("rejects unseated, unknown and current-host targets", () => {
    const state = deepFreeze(
      room({ players: [{ id: "a", seat: 0 }, { id: "b" }] }),
    );
    for (const target of ["b", "zz", "a"]) {
      assert.equal(
        rejectedCode(transferHost(state, host, target, 1)),
        "invalid_host_target",
      );
    }
  });

  it("replaces an away host's pending transfer", () => {
    const away = acceptedState(
      disconnectPlayer(deepFreeze(room({ players: fullTable() })), "a", 0),
    );
    const after = acceptedState(transferHost(away, table, "b", 1_000));
    assert.equal(after.hostId, "b");
    assert.equal(after.hostTransfer, null);
    assert.equal(
      rejectedCode(applyHostDeadline(after, "a", 60_000)),
      "action_not_allowed",
    );
  });

  it("starts a disconnected target's transfer wait at the handover", () => {
    const state = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0 },
          { id: "b", seat: 1, connected: false },
          { id: "c", seat: 2 },
        ],
      }),
    );
    const after = acceptedState(transferHost(state, host, "b", 4_000));
    assert.deepEqual(after.hostTransfer, { hostId: "b", deadline: 64_000 });
    const moved = acceptedState(applyHostDeadline(after, "b", 64_000));
    assert.equal(moved.hostId, "c");
    // A Table view can name a host while selection is pending.
    const pending = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0, connected: false },
          { id: "b", seat: 1, connected: false },
        ],
        hostId: null,
      }),
    );
    const named = acceptedState(transferHost(pending, table, "b", 4_000));
    assert.equal(named.hostId, "b");
    assert.deepEqual(named.hostTransfer, { hostId: "b", deadline: 64_000 });
  });
});

describe("applyHostDeadline", () => {
  const away = () =>
    acceptedState(
      disconnectPlayer(
        deepFreeze(
          room({
            config: config56(6),
            players: [
              { id: "a", seat: 3 },
              { id: "b", seat: 0 },
              { id: "c", seat: 5 },
            ],
          }),
        ),
        "a",
        1_000,
      ),
    );

  it("moves the role to the successor when the committed deadline elapses", () => {
    const state = away();
    assert.equal(
      state.hostTransfer?.deadline,
      hostTransferDeadline(state, 1_000),
    );
    const after = acceptedState(applyHostDeadline(state, "a", 61_000));
    assert.deepEqual(after.events, [
      { type: "hostChanged", hostId: "c", reason: "waitElapsed" },
    ]);
    assert.equal(after.hostId, "c");
    assert.equal(after.hostTransfer, null);
    // The former host does not regain the role on return.
    const back = acceptedState(connectPlayer(after, "a", 70_000));
    assert.equal(back.hostId, "c");
    assert.deepEqual(back.events, [{ type: "playerConnected", playerId: "a" }]);
  });

  it("ignores stale callbacks", () => {
    const state = away();
    assert.equal(
      rejectedCode(applyHostDeadline(state, "a", 60_999)),
      "action_not_allowed",
    );
    assert.equal(
      rejectedCode(applyHostDeadline(state, "b", 61_000)),
      "action_not_allowed",
    );
    const back = acceptedState(connectPlayer(state, "a", 30_000));
    assert.equal(
      rejectedCode(applyHostDeadline(back, "a", 61_000)),
      "action_not_allowed",
    );
    // A later disconnect commits a new deadline; the old callback is stale.
    const again = acceptedState(disconnectPlayer(back, "a", 40_000));
    assert.equal(
      rejectedCode(applyHostDeadline(again, "a", 61_000)),
      "action_not_allowed",
    );
    acceptedState(applyHostDeadline(again, "a", 100_000));
  });

  it("leaves selection pending when nobody is connected", () => {
    const state = deepFreeze(
      room({
        players: [
          { id: "a", seat: 0 },
          { id: "b", seat: 1, connected: false },
        ],
      }),
    );
    const away = acceptedState(disconnectPlayer(state, "a", 0));
    const pending = acceptedState(applyHostDeadline(away, "a", 60_000));
    assert.deepEqual(pending.events, [
      { type: "hostChanged", hostId: null, reason: "waitElapsed" },
    ]);
    assert.equal(pending.hostId, null);
    assert.equal(pending.hostTransfer, null);
    // Whoever connects first, the former host included, receives the role.
    for (const first of ["a", "b"]) {
      const claimed = acceptedState(connectPlayer(pending, first, 90_000));
      assert.equal(claimed.hostId, first);
    }
  });
});
