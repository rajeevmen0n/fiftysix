// Test-only fixtures for the pure room policy. Never imported by production
// code (index.ts does not export from here).

import assert from "node:assert/strict";
import {
  act,
  buildDeck,
  type EngineConfig,
  type EngineState,
  type MatchSummary,
  newSession,
} from "@fiftysix/engine";

import { assertRoomInvariants } from "./invariants.js";
import { nameComparisonKey } from "./names.js";
import type {
  CanonicalRoomEvent,
  DomainResult,
  PlayerRecord,
  RoomConfig,
  RoomSnapshot,
} from "./types.js";

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function config56(playerCount: 4 | 6 | 8 = 4): RoomConfig {
  return {
    gameType: "56",
    playerCount,
    includeEightsAndSevens: false,
    illegalPlayMode: "block",
    startingTokens: 10,
    stakeTiers: [
      { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
      { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
      { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
    ],
    redealThreshold: 2,
    surrenderOption: "off",
    roundHistory: "last",
    livePoints: false,
    hostTransferWaitSeconds: 60,
  };
}

function engineConfig(config: RoomConfig): EngineConfig {
  return {
    gameType: config.gameType,
    playerCount: config.playerCount,
    includeEightsAndSevens: config.includeEightsAndSevens,
    illegalPlayMode: config.illegalPlayMode,
    startingTokens: config.startingTokens,
    stakeTiers: config.stakeTiers,
    redealThreshold: config.redealThreshold,
    surrenderOption: config.surrenderOption,
  };
}

const restartedSummary = (dealer: number): MatchSummary => ({
  dealer,
  contract: null,
  points: { A: 0, B: 0 },
  tokensMoved: null,
  tokens: { A: 10, B: 0 },
  outcome: { type: "restarted" },
});

export type EngineStage = "active" | "matchOver" | "sessionOver";

/** A real engine state in the requested stage (dealt, or at a summary). */
export function engineIn(
  config: RoomConfig,
  stage: EngineStage,
  firstDealer = 0,
): EngineState {
  const session = newSession(engineConfig(config), firstDealer);
  if (!session.ok) {
    throw new Error(`fixture session rejected: ${session.code}`);
  }
  if (stage === "matchOver") {
    return {
      ...session.state,
      phase: { type: "matchOver", summary: restartedSummary(firstDealer) },
    };
  }
  if (stage === "sessionOver") {
    return {
      ...session.state,
      phase: {
        type: "sessionOver",
        winner: "A",
        summary: restartedSummary(firstDealer),
      },
    };
  }
  const dealt = act(session.state, {
    type: "deal",
    source: { type: "system" },
    deck: buildDeck(engineConfig(config)),
  });
  if (!dealt.ok) {
    throw new Error(`fixture deal rejected: ${dealt.code}`);
  }
  return dealt.state;
}

export interface PlayerFixture {
  id: string;
  name?: string;
  seat?: number | null;
  lastSeat?: number | null;
  ready?: boolean;
  connected?: boolean;
  replacementReady?: boolean;
}

export function player(
  fixture: PlayerFixture,
  joinOrder: number,
): PlayerRecord {
  const name = fixture.name ?? `Player ${fixture.id}`;
  const seat = fixture.seat ?? null;
  const connected = fixture.connected ?? true;
  return {
    id: fixture.id,
    displayName: name,
    normalizedName: nameComparisonKey(name),
    pin: null,
    joinOrder,
    seat,
    lastSeat: fixture.lastSeat ?? seat,
    ready: fixture.ready ?? false,
    connected,
    disconnectedAt: connected ? null : 1_000,
    replacementReady: fixture.replacementReady ?? false,
    lastReactionAt: null,
  };
}

export type RoomStageFixture =
  | "arranging"
  | "restartArranging"
  | "active"
  | "matchOver"
  | "sessionOver";

export interface RoomFixture {
  config?: RoomConfig;
  stage?: RoomStageFixture;
  players: PlayerFixture[];
  hostId?: string | null;
  firstDealer?: number;
}

/** A consistent room snapshot built from compact player fixtures. */
export function room(fixture: RoomFixture): RoomSnapshot {
  const config = fixture.config ?? config56();
  const stage = fixture.stage ?? "arranging";
  const players = fixture.players.map((entry, index) => player(entry, index));
  const seats: Array<string | null> = Array.from(
    { length: config.playerCount },
    () => null,
  );
  for (const entry of players) {
    if (entry.seat !== null) {
      seats[entry.seat] = entry.id;
    }
  }
  const firstDealer = fixture.firstDealer ?? 0;
  const engine =
    stage === "arranging"
      ? null
      : engineIn(
          config,
          stage === "restartArranging" ? "sessionOver" : stage,
          firstDealer,
        );
  return {
    id: "room-1",
    code: "K7MQ4P",
    revision: 3,
    config,
    phase:
      stage === "arranging"
        ? { type: "arranging", pending: "initial" }
        : stage === "restartArranging"
          ? { type: "arranging", pending: "restart" }
          : { type: "running" },
    players,
    seats,
    hostId:
      fixture.hostId === undefined ? (players[0]?.id ?? null) : fixture.hostId,
    hostTransfer: null,
    firstDealer,
    engine,
    tablePin: null,
    createdAt: 500,
    // The expiry clock runs while no player is connected (rooms spec §6.4).
    emptySince: players.some((entry) => entry.connected) ? null : 1_000,
  };
}

/** Four players filling a 4-seat table in seat order. */
export function fullTable(
  overrides: Partial<PlayerFixture> = {},
): PlayerFixture[] {
  return ["a", "b", "c", "d"].map((id, seat) => ({ id, seat, ...overrides }));
}

/**
 * Asserts an accepted transition with at least one event, no effects and a
 * snapshot that satisfies every invariant; returns the snapshot and events.
 */
export function acceptedState(
  result: DomainResult,
): RoomSnapshot & { events: CanonicalRoomEvent[] } {
  if (!result.ok) {
    assert.fail(`expected acceptance, got ${result.code}`);
  }
  assertRoomInvariants(result.state);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state)), result.state);
  assert.deepEqual(result.effects, []);
  assert.ok(result.events.length > 0);
  return { ...result.state, events: result.events };
}

/** Asserts a rejection and returns its code. */
export function rejectedCode(result: DomainResult): string {
  if (result.ok) {
    assert.fail("expected a rejection");
  }
  return result.code;
}
