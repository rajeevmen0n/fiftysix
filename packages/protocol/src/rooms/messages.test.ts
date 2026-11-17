import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ActionResult,
  type AllowedEngineAction,
  act,
  allowedActions,
  allowedHostActions,
  buildDeck,
  type Card,
  type ClientEngineAction,
  type ClientSeatAction,
  type EngineConfig,
  type EngineEvent,
  type EngineState,
  legalCards,
  newSession,
  redactEvent,
  type Viewer,
  type ViewSettings,
  view,
} from "@fiftysix/engine";

import { clientEngineActionSchemas } from "./commands.js";
import type { RoomEvent } from "./events.js";
import { defaultStakeTiers } from "./http.js";
import { serverMessageSchema } from "./messages.js";
import type { RoomSettings } from "./model.js";
import type { RoomView } from "./views.js";

// Server messages are checked against real engine output: seeded sessions
// produce every view and redacted event that a room would send, and each one
// must parse inside its message envelope. Strictness tests then show that
// private fields cannot ride along.

/** mulberry32: a small deterministic PRNG for test data only. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(items: readonly T[], next: () => number): T {
  const item = items[Math.floor(next() * items.length)];
  assert.ok(item !== undefined);
  return item;
}

function shuffled(deck: readonly Card[], next: () => number): Card[] {
  const cards = [...deck];
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    const current = cards[index];
    const swap = cards[other];
    assert.ok(current !== undefined && swap !== undefined);
    cards[index] = swap;
    cards[other] = current;
  }
  return cards;
}

/** A concrete client action for one allowed engine capability. */
function clientAction(
  allowed: AllowedEngineAction,
  next: () => number,
): ClientSeatAction {
  switch (allowed.type) {
    case "bid": {
      const amount =
        allowed.range.minimum +
        Math.floor(
          next() * (allowed.range.maximum - allowed.range.minimum + 1),
        );
      if (allowed.suits.length === 0) {
        return { type: "bid", amount };
      }
      const suit = pick(allowed.suits, next);
      return suit === "noTrump"
        ? { type: "bid", amount, suit }
        : { type: "bid", amount, suit, style: pick(allowed.styles, next) };
    }
    case "placeCard":
    case "playCard":
      return { type: allowed.type, card: pick(allowed.cards, next) };
    case "voteSurrender":
      return { type: "voteSurrender", vote: pick(allowed.votes, next) };
    default:
      return { type: allowed.type };
  }
}

function settingsFor(config: EngineConfig, viewSettings: ViewSettings) {
  const common = {
    illegalPlayMode: config.illegalPlayMode,
    startingTokens: config.startingTokens,
    redealThreshold: config.redealThreshold,
    surrenderOption: config.surrenderOption,
    roundHistory: viewSettings.roundHistory,
    livePoints: viewSettings.livePoints,
    hostTransferWaitSeconds: 60,
  };
  const settings: RoomSettings =
    config.gameType === "28"
      ? {
          ...common,
          gameType: "28",
          playerCount: 4,
          includeEightsAndSevens: true,
          stakeTiers: [...defaultStakeTiers["28"]],
        }
      : {
          ...common,
          gameType: "56",
          playerCount: config.playerCount,
          includeEightsAndSevens: config.includeEightsAndSevens,
          stakeTiers: [...defaultStakeTiers["56"]],
        };
  return settings;
}

function roomView(
  settings: RoomSettings,
  revision: number,
  viewer: Viewer,
  state: EngineState,
  viewSettings: ViewSettings,
): RoomView {
  const seats = Array.from({ length: settings.playerCount }, (_, seat) => ({
    seat,
    team: seat % 2 === 0 ? ("A" as const) : ("B" as const),
    playerId: `player-${seat}`,
  }));
  return {
    roomCode: "K7MQ4P",
    revision,
    phase: "running",
    settings,
    hostId: "player-0",
    firstDealer: 0,
    gate: { type: "playing" },
    players: seats.map(({ seat, playerId }) => ({
      playerId,
      name: `Player ${seat}`,
      seat,
      connected: true,
      ready: false,
    })),
    seats,
    viewer:
      viewer.type === "seat"
        ? {
            type: "player",
            playerId: `player-${viewer.seat}`,
            seat: viewer.seat,
            lastSeat: viewer.seat,
          }
        : { type: "table" },
    engine: view(state, viewer, viewSettings),
    allowedRoomActions: [{ type: "sendReaction" }, { type: "leaveRoom" }],
    allowedHostActions:
      viewer.type === "table"
        ? [{ type: "endMatch", ...allowedHostActions(state) }]
        : [],
  };
}

/** Parses `message` after a JSON round trip, as a client would receive it. */
function assertServerMessage(message: unknown): void {
  const wire: unknown = JSON.parse(JSON.stringify(message));
  const parsed = serverMessageSchema.safeParse(wire);
  assert.ok(
    parsed.success,
    parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)),
  );
  assert.deepEqual(parsed.data, wire);
}

interface Scenario {
  name: string;
  config: EngineConfig;
  viewSettings: ViewSettings;
  seed: number;
}

const base56: EngineConfig = {
  gameType: "56",
  playerCount: 4,
  includeEightsAndSevens: false,
  illegalPlayMode: "block",
  startingTokens: 4,
  stakeTiers: [...defaultStakeTiers["56"]],
  redealThreshold: 2,
  surrenderOption: "on",
};
const base28: EngineConfig = {
  ...base56,
  gameType: "28",
  includeEightsAndSevens: true,
  stakeTiers: [...defaultStakeTiers["28"]],
  redealThreshold: 1,
};

const scenarios: Scenario[] = [
  {
    name: "56, 4 players, Block, live points, full history",
    config: base56,
    viewSettings: { roundHistory: "full", livePoints: true },
    seed: 1,
  },
  {
    name: "56, 6 players, Auto-stop, no history",
    config: { ...base56, playerCount: 6, illegalPlayMode: "autoStop" },
    viewSettings: { roundHistory: "none", livePoints: false },
    seed: 2,
  },
  {
    name: "56, 8 players, 64 cards, last round",
    config: { ...base56, playerCount: 8, includeEightsAndSevens: true },
    viewSettings: { roundHistory: "last", livePoints: false },
    seed: 3,
  },
  {
    name: "28, Block, live points",
    config: base28,
    viewSettings: { roundHistory: "full", livePoints: true },
    seed: 4,
  },
  {
    name: "28, Auto-stop, last round",
    config: { ...base28, illegalPlayMode: "autoStop" },
    viewSettings: { roundHistory: "last", livePoints: false },
    seed: 5,
  },
];

function accepted(result: ActionResult): {
  state: EngineState;
  events: EngineEvent[];
} {
  assert.ok(result.ok, result.ok ? "" : result.code);
  return result;
}

describe("server messages carry real engine output", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const { config, viewSettings } = scenario;
      const next = random(scenario.seed);
      const settings = settingsFor(config, viewSettings);
      const viewers: Viewer[] = [
        { type: "table" },
        ...Array.from({ length: config.playerCount }, (_, seat) => ({
          type: "seat" as const,
          seat,
        })),
      ];
      const seenEvents = new Set<string>();
      const rejectionCodes = new Set<string>();
      const seenPhases = new Set<string>();
      let { state, events } = accepted(newSession(config, 0));
      let revision = 1;
      let lastCommand: ClientEngineAction | null = null;

      for (let step = 0; step < 500; step += 1) {
        seenPhases.add(state.phase.type);
        for (const viewer of viewers) {
          const roomEvents: RoomEvent[] = [];
          for (const event of events) {
            seenEvents.add(event.type);
            const redacted = redactEvent(event, viewer, viewSettings);
            if (redacted !== null) {
              roomEvents.push({ type: "engine", event: redacted });
            }
          }
          const current = roomView(
            settings,
            revision,
            viewer,
            state,
            viewSettings,
          );
          assertServerMessage({
            type: "update",
            revision,
            events: roomEvents,
            view: current,
            commandId: `command-${step}`,
          });
          if (step % 20 !== 0) {
            continue;
          }
          assertServerMessage({
            type: "helloAccepted",
            revision,
            view: current,
          });
          assertServerMessage({
            type: "commandRejected",
            commandId: `command-${step}`,
            source: "engine",
            code: "notYourTurn",
            details: { turn: current.engine?.turn ?? null },
            revision,
            view: current,
          });
        }

        const phase = state.phase.type;
        let result: ActionResult;
        if (phase === "sessionOver") {
          result = act(state, {
            type: "restartSession",
            source: { type: "system" },
            firstDealer: Math.floor(next() * config.playerCount),
          });
        } else if (phase === "awaitingDeal") {
          result = act(state, {
            type: "deal",
            source: { type: "system" },
            deck: shuffled(buildDeck(config), next),
          });
        } else if (phase === "matchOver") {
          result = act(state, {
            type: "startNextMatch",
            source: { type: "system" },
          });
        } else {
          const host = allowedHostActions(state);
          const options = Array.from(
            { length: config.playerCount },
            (_, seat) =>
              allowedActions(state, seat).map((allowed) => ({ seat, allowed })),
          ).flat();
          // Probe: a protocol-valid action from a random seat, usually one
          // the engine rejects. Its code and details must fit commandRejected.
          const probeSeat = Math.floor(next() * config.playerCount);
          const probe: ClientEngineAction =
            options.length > 0 && next() < 0.5
              ? clientAction(pick(options, next).allowed, next)
              : pick(probePool(config), next);
          const probeResult =
            probe.type === "endMatch"
              ? act(state, { ...probe, source: { type: "host" } })
              : act(state, {
                  ...probe,
                  source: { type: "seat", seat: probeSeat },
                });
          if (!probeResult.ok) {
            rejectionCodes.add(probeResult.code);
            assertServerMessage({
              type: "commandRejected",
              commandId: `probe-${step}`,
              source: "engine",
              code: probeResult.code,
              ...(probeResult.details === undefined
                ? {}
                : { details: probeResult.details }),
              revision,
              view: roomView(
                settings,
                revision,
                { type: "table" },
                state,
                viewSettings,
              ),
            });
          }
          if (next() < 0.01 && (host.restart || host.awardTeams.length > 0)) {
            const action: ClientEngineAction =
              host.awardTeams.length > 0 && next() < 0.5
                ? {
                    type: "endMatch",
                    resolution: {
                      type: "award",
                      team: pick(host.awardTeams, next),
                    },
                  }
                : { type: "endMatch", resolution: { type: "restart" } };
            lastCommand = action;
            result = act(state, { ...action, source: { type: "host" } });
          } else {
            assert.ok(options.length > 0, `no actions in ${phase}`);
            const passes = options.filter((o) => o.allowed.type === "pass");
            const choice =
              passes.length > 0 && next() < 0.7
                ? pick(passes, next)
                : pick(options, next);
            // Mostly legal cards, so Auto-stop matches also reach later rounds.
            const legal = legalCards(state, choice.seat);
            const allowed =
              choice.allowed.type === "playCard" &&
              legal.length > 0 &&
              next() < 0.9
                ? { ...choice.allowed, cards: legal }
                : choice.allowed;
            const action = clientAction(allowed, next);
            lastCommand = action;
            result = act(state, {
              ...action,
              source: { type: "seat", seat: choice.seat },
            });
          }
          assert.ok(lastCommand !== null);
          // Every action the engine offers must pass the protocol edge.
          assert.deepEqual(
            clientEngineActionSchemas[config.gameType].parse(lastCommand),
            lastCommand,
          );
        }
        ({ state, events } = accepted(result));
        revision += 1;
      }

      for (const type of [
        "dealt",
        "auctionEnded",
        "playStarted",
        "cardPlayed",
        "roundWon",
        "matchEnded",
        "sessionEnded",
        "sessionRestarted",
      ]) {
        assert.ok(seenEvents.has(type), type);
      }
      for (const type of ["auction", "play", "matchOver", "sessionOver"]) {
        assert.ok(seenPhases.has(type), type);
      }
      if (config.gameType === "28") {
        assert.ok(seenEvents.has("cardPlaced"));
      }
      // A malformed bid can pass the protocol only in 56 (engine spec §8.2).
      const expectedCodes =
        config.gameType === "56"
          ? ["notYourTurn", "actionNotAllowed", "invalidBid"]
          : ["notYourTurn", "actionNotAllowed"];
      for (const code of expectedCodes) {
        assert.ok(rejectionCodes.has(code), code);
      }
    });
  }
});

/** Protocol-valid actions that are often wrong for the current state. */
function probePool(config: EngineConfig): ClientEngineAction[] {
  const card: Card = { suit: "hearts", rank: "J", copy: 1 };
  const pool: ClientEngineAction[] = [
    { type: "pass" },
    { type: "double" },
    { type: "redouble" },
    { type: "askReveal" },
    { type: "placeCard", card },
    { type: "playCard", card },
    { type: "proposeSurrender" },
    { type: "voteSurrender", vote: "yes" },
    { type: "endMatch", resolution: { type: "award", team: "A" } },
  ];
  if (config.gameType === "28") {
    pool.push({ type: "bid", amount: 13 }, { type: "bid", amount: 29 });
  } else {
    pool.push(
      { type: "bid", amount: 30 },
      { type: "bid", amount: 30, suit: "spades" },
      { type: "bid", amount: 30, suit: "noTrump", style: "suitFirst" },
      { type: "bid", amount: 57, suit: "noTrump" },
    );
  }
  for (const action of pool) {
    assert.ok(
      clientEngineActionSchemas[config.gameType].safeParse(action).success,
    );
  }
  return pool;
}

describe("server message strictness", () => {
  const settings = settingsFor(base56, {
    roundHistory: "last",
    livePoints: false,
  });
  const state = accepted(
    act(accepted(newSession(base56, 0)).state, {
      type: "deal",
      source: { type: "system" },
      deck: shuffled(buildDeck(base56), random(9)),
    }),
  ).state;
  const viewSettings: ViewSettings = {
    roundHistory: "last",
    livePoints: false,
  };
  const seatView = roomView(
    settings,
    3,
    { type: "seat", seat: 1 },
    state,
    viewSettings,
  );
  const tableView = roomView(
    settings,
    3,
    { type: "table" },
    state,
    viewSettings,
  );
  const hello = (roomView: unknown) => ({
    type: "helloAccepted",
    revision: 3,
    view: roomView,
  });
  const accepts = (message: unknown) =>
    serverMessageSchema.safeParse(JSON.parse(JSON.stringify(message))).success;

  it("accepts the unmodified views", () => {
    assert.equal(accepts(hello(seatView)), true);
    assert.equal(accepts(hello(tableView)), true);
  });

  it("rejects private engine fields in a view", () => {
    assert.ok(seatView.engine !== null && tableView.engine !== null);
    const hand =
      seatView.engine.viewer.type === "seat" ? seatView.engine.viewer.hand : [];
    const leaks: unknown[] = [
      { ...seatView, engine: { ...seatView.engine, hands: [hand] } },
      { ...seatView, engine: { ...seatView.engine, undealt: null } },
      { ...seatView, engine: { ...seatView.engine, deck: hand } },
      {
        ...tableView,
        engine: {
          ...tableView.engine,
          viewer: { type: "table", hand },
        },
      },
      {
        ...seatView,
        engine: {
          ...seatView.engine,
          faceDown: { owner: 1, visibility: "hidden", card: hand[0] },
        },
      },
      {
        ...seatView,
        engine: {
          ...seatView.engine,
          viewer: { ...seatView.engine.viewer, otherHands: [hand] },
        },
      },
    ];
    for (const leak of leaks) {
      assert.equal(accepts(hello(leak)), false);
    }
  });

  it("rejects credentials and private room state in a view", () => {
    const player = seatView.players[0];
    assert.ok(player !== undefined);
    const leaks: unknown[] = [
      { ...seatView, token: "selector.secret" },
      { ...seatView, players: [{ ...player, pin: "1234" }] },
      { ...seatView, players: [{ ...player, pinHash: "x" }] },
      { ...seatView, players: [{ ...player, lastReactionAt: 1 }] },
      { ...seatView, settings: { ...seatView.settings, tablePin: "1234" } },
      { ...seatView, viewer: { ...seatView.viewer, token: "t" } },
      { ...seatView, hostTransfer: { hostId: "player-0", deadline: 1 } },
    ];
    for (const leak of leaks) {
      assert.equal(accepts(hello(leak)), false);
    }
  });

  it("rejects unredacted engine events", () => {
    const update = (event: unknown) => ({
      type: "update",
      revision: 3,
      events: [{ type: "engine", event }],
      view: tableView,
    });
    const hand = [{ suit: "spades", rank: "J", copy: 1 }];
    assert.equal(
      accepts(
        update({
          type: "dealt",
          stage: "full",
          hand: null,
          cardCounts: [12, 12, 12, 12],
        }),
      ),
      true,
    );
    for (const event of [
      { type: "dealt", stage: "full", hands: [hand], undealt: null },
      { type: "dealt", stage: "first", hand, cardCounts: [4], undealt: [hand] },
      {
        type: "auctionEnded",
        contract: {
          bidder: 0,
          team: "A",
          amount: 20,
          trump: { type: "hidden", suit: "spades", card: hand[0] },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
      {
        type: "matchEnded",
        summary: {
          dealer: 0,
          contract: {
            bidder: 0,
            team: "A",
            amount: 20,
            trump: { type: "hidden", suit: "spades" },
            style: null,
            multiplier: 1,
            forced: false,
          },
          points: { A: 0, B: 0 },
          tokensMoved: null,
          tokens: { A: 1, B: 1 },
          outcome: { type: "restarted" },
        },
      },
      { type: "deal", deck: hand },
    ]) {
      assert.equal(accepts(update(event)), false, JSON.stringify(event));
    }
  });

  it("requires the message and view revisions to match", () => {
    assert.equal(accepts({ ...hello(seatView), revision: 4 }), false);
  });

  it("carries room and engine rejections and terminal revocations", () => {
    const rejected = {
      type: "commandRejected",
      commandId: "c-1",
      revision: 3,
      view: seatView,
    };
    assert.equal(
      accepts({ ...rejected, source: "room", code: "reaction_rate_limited" }),
      true,
    );
    assert.equal(
      accepts({
        ...rejected,
        source: "engine",
        code: "illegalPlay",
        details: { kind: "didNotFollowSuit" },
      }),
      true,
    );
    assert.equal(
      accepts({ ...rejected, source: "room", code: "illegalPlay" }),
      false,
    );
    for (const details of [{ nested: { card: "hidden" } }, { cards: ["J"] }]) {
      assert.equal(
        accepts({
          ...rejected,
          source: "engine",
          code: "notYourTurn",
          details,
        }),
        false,
      );
    }
    assert.equal(
      accepts({
        ...rejected,
        source: "room",
        code: "seat_occupied",
        details: { seat: 2, reason: "taken", retry: false, other: null },
      }),
      true,
    );
    assert.equal(
      accepts({ ...rejected, source: "engine", code: "seat_occupied" }),
      false,
    );
    for (const reason of [
      "signed_in_elsewhere",
      "removed",
      "left_room",
      "room_expired",
    ]) {
      assert.equal(accepts({ type: "accessRevoked", reason }), true);
    }
    assert.equal(accepts({ type: "accessRevoked", reason: "kicked" }), false);
    assert.equal(accepts({ type: "error", code: "invalid_token" }), true);
  });

  it("carries every room event shape", () => {
    const player = seatView.players[0];
    assert.ok(player !== undefined);
    const events: RoomEvent[] = [
      { type: "playerJoined", player: { ...player, seat: null, ready: false } },
      { type: "playerLeft", playerId: "player-1", reason: "left" },
      { type: "playerLeft", playerId: "player-1", reason: "removed" },
      { type: "seatTaken", playerId: "player-1", seat: 1 },
      { type: "seatLeft", playerId: "player-1", seat: 1 },
      { type: "playerMoved", playerId: "player-1", from: null, to: 2 },
      {
        type: "playersSwapped",
        first: "player-1",
        firstSeat: 2,
        second: "player-2",
        secondSeat: 1,
      },
      { type: "firstDealerChanged", seat: 3 },
      { type: "readyChanged", playerId: "player-1", ready: true },
      { type: "readinessCleared" },
      { type: "playerConnected", playerId: "player-1" },
      { type: "playerDisconnected", playerId: "player-1" },
      { type: "matchStalled" },
      { type: "matchResumed" },
      { type: "hostChanged", hostId: "player-2", reason: "waitElapsed" },
      { type: "hostChanged", hostId: null, reason: "hostDeparted" },
      { type: "reactionSent", playerId: "player-1", reaction: "oneMoment" },
      { type: "sessionReset", firstDealer: 2 },
    ];
    assert.equal(
      accepts({ type: "update", revision: 3, events, view: seatView }),
      true,
    );
    for (const event of [
      { type: "reactionSent", playerId: "player-1", reaction: "free text" },
      { type: "playerJoined", player: { ...player, pin: "1234" } },
      {
        type: "hostChanged",
        hostId: "player-2",
        reason: "waitElapsed",
        deadline: 5,
      },
    ]) {
      assert.equal(
        accepts({
          type: "update",
          revision: 3,
          events: [event],
          view: seatView,
        }),
        false,
      );
    }
  });
});
