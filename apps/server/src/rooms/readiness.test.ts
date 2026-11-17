import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearAllReady,
  readinessGate,
  readinessGateIsOpen,
  setReady,
} from "./readiness.js";
import { takeSeat } from "./seating.js";
import {
  acceptedState,
  deepFreeze,
  fullTable,
  rejectedCode,
  room,
} from "./test-helpers.js";

describe("setReady", () => {
  it("toggles a seated player's Ready before and between matches", () => {
    for (const stage of [
      "arranging",
      "restartArranging",
      "matchOver",
    ] as const) {
      const before = deepFreeze(room({ stage, players: fullTable() }));
      const ready = acceptedState(setReady(before, "b", true));
      assert.deepEqual(ready.events, [
        { type: "readyChanged", playerId: "b", ready: true },
      ]);
      assert.equal(ready.players[1]?.ready, true);
      assert.equal(ready.players[1]?.replacementReady, false);
      assert.equal(before.players[1]?.ready, false);
      const unready = acceptedState(setReady(ready, "b", false));
      assert.equal(unready.players[1]?.ready, false);
    }
  });

  it("rejects unseated players, unchanged values and unknown players", () => {
    const state = room({
      players: [{ id: "a", seat: 0, ready: true }, { id: "b" }],
    });
    assert.equal(rejectedCode(setReady(state, "b", true)), "not_seated");
    assert.equal(rejectedCode(setReady(state, "a", true)), "not_readyable");
    assert.equal(
      rejectedCode(setReady(state, "zz", true)),
      "action_not_allowed",
    );
  });

  it("rejects Ready once the session is over", () => {
    const state = room({ stage: "sessionOver", players: fullTable() });
    assert.equal(rejectedCode(setReady(state, "a", true)), "not_readyable");
  });

  it("keeps existing match confirmations: nobody withdraws during a match", () => {
    const state = room({
      stage: "active",
      players: fullTable({ ready: true }),
    });
    assert.equal(rejectedCode(setReady(state, "a", false)), "not_readyable");
    assert.equal(rejectedCode(setReady(state, "a", true)), "not_readyable");
  });

  it("requires only a new replacement's Ready to resume", () => {
    const stalled = room({
      stage: "active",
      players: [
        { id: "a", seat: 0, ready: true },
        { id: "b", seat: 1, ready: true },
        { id: "c", seat: 2, ready: true },
        { id: "n" },
      ],
    });
    assert.deepEqual(readinessGate(stalled), {
      type: "stalled",
      emptySeats: [3],
      disconnected: [],
      notReady: [],
    });
    const seated = acceptedState(takeSeat(stalled, "n", 3));
    assert.deepEqual(readinessGate(seated), {
      type: "stalled",
      emptySeats: [],
      disconnected: [],
      notReady: ["n"],
    });
    const resumed = acceptedState(setReady(seated, "n", true));
    assert.deepEqual(resumed.events, [
      { type: "readyChanged", playerId: "n", ready: true },
      { type: "matchResumed" },
    ]);
    assert.equal(resumed.players[3]?.replacementReady, true);
    assert.deepEqual(readinessGate(resumed), { type: "playing" });
    assert.equal(rejectedCode(setReady(resumed, "n", false)), "not_readyable");
  });
});

describe("clearAllReady", () => {
  it("clears Ready and replacement confirmations and reports the change", () => {
    const before = deepFreeze(
      room({
        stage: "active",
        players: fullTable({ ready: true, replacementReady: false }).map(
          (entry, index) => ({ ...entry, replacementReady: index === 3 }),
        ),
      }),
    );
    const result = clearAllReady(before);
    assert.deepEqual(result.events, [{ type: "readinessCleared" }]);
    for (const entry of result.state.players) {
      assert.equal(entry.ready, false);
      assert.equal(entry.replacementReady, false);
    }
    assert.equal(before.players[0]?.ready, true);
  });

  it("returns the same snapshot and no event when nobody is Ready", () => {
    const state = room({ players: fullTable() });
    const result = clearAllReady(state);
    assert.equal(result.state, state);
    assert.deepEqual(result.events, []);
  });
});

describe("readinessGate", () => {
  it("waits for seats, connections and Ready before the first match", () => {
    const state = room({
      players: [
        { id: "a", seat: 0, ready: true },
        { id: "b", seat: 2 },
        { id: "c", connected: false },
      ],
    });
    const gate = readinessGate(state);
    assert.deepEqual(gate, {
      type: "readiness",
      emptySeats: [1, 3],
      disconnected: ["c"],
      notReady: ["b"],
    });
    assert.equal(readinessGateIsOpen(gate), false);
  });

  it("opens when every seat is filled, connected and Ready", () => {
    for (const stage of [
      "arranging",
      "restartArranging",
      "matchOver",
    ] as const) {
      const gate = readinessGate(
        room({ stage, players: fullTable({ ready: true }) }),
      );
      assert.deepEqual(gate, {
        type: "readiness",
        emptySeats: [],
        disconnected: [],
        notReady: [],
      });
      assert.equal(readinessGateIsOpen(gate), true, stage);
    }
  });

  it("keeps Ready through a disconnect but stays closed until reconnection", () => {
    const players = fullTable({ ready: true }).map((entry) =>
      entry.id === "c" ? { ...entry, connected: false } : entry,
    );
    const gate = readinessGate(room({ stage: "matchOver", players }));
    assert.deepEqual(gate, {
      type: "readiness",
      emptySeats: [],
      disconnected: ["c"],
      notReady: [],
    });
    assert.equal(readinessGateIsOpen(gate), false);
  });

  it("reports a stall for a disconnected seat during a match", () => {
    const players = fullTable({ ready: true }).map((entry) =>
      entry.id === "b" ? { ...entry, connected: false } : entry,
    );
    const gate = readinessGate(room({ stage: "active", players }));
    assert.deepEqual(gate, {
      type: "stalled",
      emptySeats: [],
      disconnected: ["b"],
      notReady: [],
    });
    assert.equal(readinessGateIsOpen(gate), false);
    assert.deepEqual(
      readinessGate(
        room({ stage: "active", players: fullTable({ ready: true }) }),
      ),
      { type: "playing" },
    );
  });

  it("reports the end of the session", () => {
    const gate = readinessGate(
      room({ stage: "sessionOver", players: fullTable() }),
    );
    assert.deepEqual(gate, { type: "sessionOver" });
    assert.equal(readinessGateIsOpen(gate), false);
  });
});
