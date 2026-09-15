import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent } from "./events.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import type { EngineState, MatchState, MatchSummary } from "./state.js";
import type { EngineConfig } from "./types.js";

function config56(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    gameType: "56",
    playerCount: 4,
    includeEightsAndSevens: false,
    illegalPlayMode: "block",
    startingTokens: 12,
    stakeTiers: [
      { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
      { fromBid: 40, toBid: 47, winStake: 2, lossStake: 3 },
      { fromBid: 48, toBid: 56, winStake: 3, lossStake: 4 },
    ],
    redealThreshold: 0,
    surrenderOption: "off",
    ...overrides,
  };
}

function config28(): EngineConfig {
  return {
    gameType: "28",
    playerCount: 4,
    includeEightsAndSevens: true,
    illegalPlayMode: "autoStop",
    startingTokens: 5,
    stakeTiers: [
      { fromBid: 14, toBid: 19, winStake: 1, lossStake: 2 },
      { fromBid: 20, toBid: 28, winStake: 2, lossStake: 3 },
    ],
    redealThreshold: 6,
    surrenderOption: "on",
  };
}

function started(config: EngineConfig, firstDealer: number) {
  const result = newSession(config, firstDealer);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertJsonSafe(value: unknown, path = "$"): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} must be a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonSafe(item, `${path}[${index}]`);
    });
    return;
  }
  assert.equal(typeof value, "object", `${path} must be JSON data`);
  assert.equal(
    Object.getPrototypeOf(value),
    Object.prototype,
    `${path} must be a plain object`,
  );
  for (const [key, child] of Object.entries(value as object)) {
    assertJsonSafe(child, `${path}.${key}`);
  }
}

describe("newSession", () => {
  it("creates equal balances, the first dealer, and awaitingDeal(firstDeal)", () => {
    const cases: [EngineConfig, number][] = [
      [config56(), 0],
      [config56({ playerCount: 6 }), 5],
      [config56({ playerCount: 8, includeEightsAndSevens: true }), 7],
      [config28(), 2],
    ];

    for (const [config, firstDealer] of cases) {
      const { state, events } = started(config, firstDealer);
      const tokens = { A: config.startingTokens, B: config.startingTokens };

      assert.deepEqual(events, [
        { type: "sessionStarted", firstDealer, tokens },
      ]);
      assert.deepEqual(state, {
        config,
        tokens,
        dealer: firstDealer,
        matchLog: [],
        pastSessions: [],
        phase: { type: "awaitingDeal", reason: "firstDeal" },
      });
      assertEngineInvariants(state);
    }
  });

  it("rejects an invalid config", () => {
    const invalid: EngineConfig[] = [
      config56({ playerCount: 6, includeEightsAndSevens: true }),
      config56({ startingTokens: 0 }),
      config56({ redealThreshold: 14 }),
      { ...config28(), playerCount: 6 },
    ];
    for (const config of invalid) {
      const result = newSession(config, 0);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, "invalidConfig");
    }
  });

  it("rejects a missing or non-object config without throwing", () => {
    for (const config of [null, undefined, 56, "56", [], true]) {
      const result = newSession(config as unknown as EngineConfig, 0);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, "invalidConfig");
    }
  });

  it("rejects a first dealer that is not a whole seat number in range", () => {
    for (const firstDealer of [-1, 4, 1.5, Number.NaN, "0" as unknown]) {
      const result = newSession(config56(), firstDealer as number);
      assert.deepEqual(result, {
        ok: false,
        code: "invalidSeat",
        details: { field: "firstDealer", minimum: 0, maximum: 3 },
      });
    }
    assert.equal(
      newSession(config56({ playerCount: 8, includeEightsAndSevens: true }), 7)
        .ok,
      true,
    );
    assert.equal(!newSession(config28(), 4).ok, true);
  });

  it("does not mutate or retain the caller's config", () => {
    const config = deepFreeze(config56());
    const before = JSON.stringify(config);
    const { state } = started(config, 1);

    assert.equal(JSON.stringify(config), before);
    assert.notEqual(state.config, config);
    assert.notEqual(state.config.stakeTiers, config.stakeTiers);

    const mutable = config56();
    const other = started(mutable, 1).state;
    (mutable.stakeTiers[0] as { winStake: number }).winStake = 99;
    mutable.startingTokens = 1;
    assert.equal(other.config.stakeTiers[0]?.winStake, 1);
    assert.equal(other.config.startingTokens, 12);
  });

  it("is deterministic across duplicate calls", () => {
    const first = newSession(config28(), 3);
    const second = newSession(config28(), 3);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe("state and events", () => {
  it("round-trip through JSON unchanged", () => {
    for (const config of [config56(), config28()]) {
      const { state, events } = started(config, 1);
      assertJsonSafe(state);
      assertJsonSafe(events);
      assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
      assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
    }
  });

  it("replays sessionStarted to the exact newSession state", () => {
    const { state, events } = started(config56({ playerCount: 6 }), 4);
    const unrelated: EngineState = {
      ...started(config56({ playerCount: 6 }), 2).state,
      tokens: { A: 3, B: 21 },
      pastSessions: [{ winner: "A", tokens: { A: 24, B: 0 } }],
    };

    const replayed = events.reduce<EngineState>(
      (current, event) => evolve(current, event),
      deepFreeze(unrelated),
    );
    assert.equal(JSON.stringify(replayed), JSON.stringify(state));

    const fromJson = (
      JSON.parse(JSON.stringify(events)) as EngineEvent[]
    ).reduce<EngineState>(
      (current, event) => evolve(current, event),
      JSON.parse(JSON.stringify(state)) as EngineState,
    );
    assert.equal(JSON.stringify(fromJson), JSON.stringify(state));
  });
});

describe("decide and act", () => {
  const seat = (value: number) => ({ type: "seat", seat: value }) as const;
  const host = { type: "host" } as const;
  const system = { type: "system" } as const;

  function rejection(state: EngineState, action: unknown) {
    const decision = decide(state, action as EngineAction);
    const result = act(state, action as EngineAction);
    assert.equal(decision.ok, false);
    assert.deepEqual(result, decision);
    return decision;
  }

  function rejectionCode(state: EngineState, action: unknown) {
    const decision = rejection(state, action);
    return decision.ok ? null : decision.code;
  }

  it("rejects source/action mismatches", () => {
    const { state } = started(config56(), 0);
    const mismatches: [unknown, string][] = [
      [
        {
          type: "bid",
          amount: 28,
          suit: "spades",
          style: "numberFirst",
          source: host,
        },
        "seat",
      ],
      [{ type: "pass", source: system }, "seat"],
      [
        {
          type: "playCard",
          card: { suit: "spades", rank: "J", copy: 1 },
          source: host,
        },
        "seat",
      ],
      [{ type: "voteSurrender", vote: "yes", source: system }, "seat"],
      [
        { type: "endMatch", resolution: { type: "restart" }, source: seat(0) },
        "host",
      ],
      [
        { type: "endMatch", resolution: { type: "restart" }, source: system },
        "host",
      ],
      [
        { type: "deal", deck: buildDeck(state.config), source: seat(1) },
        "system",
      ],
      [{ type: "deal", deck: buildDeck(state.config), source: host }, "system"],
      [{ type: "startNextMatch", source: seat(2) }, "system"],
      [{ type: "restartSession", firstDealer: 0, source: host }, "system"],
      [{ type: "pass" }, "seat"],
      [{ type: "pass", source: null }, "seat"],
      [{ type: "pass", source: "seat" }, "seat"],
    ];

    for (const [action, expectedSource] of mismatches) {
      assert.deepEqual(rejection(state, action), {
        ok: false,
        code: "actionNotAllowed",
        details: {
          action: (action as { type: string }).type,
          expectedSource,
        },
      });
    }
  });

  it("rejects seat sources outside the table", () => {
    const { state } = started(config56({ playerCount: 6 }), 0);
    for (const bad of [-1, 6, 2.5, Number.NaN, "1", null]) {
      const action = { type: "pass", source: { type: "seat", seat: bad } };
      assert.deepEqual(rejection(state, action), {
        ok: false,
        code: "invalidSeat",
        details: { minimum: 0, maximum: 5 },
      });
    }
  });

  it("rejects unknown actions and actions outside their phase", () => {
    const { state } = started(config56(), 0);
    assert.equal(rejectionCode(state, null), "actionNotAllowed");
    assert.equal(
      rejectionCode(state, { type: "toString", source: system }),
      "actionNotAllowed",
    );
    assert.equal(
      rejectionCode(state, { type: "shuffle", source: system }),
      "actionNotAllowed",
    );

    assert.deepEqual(decide(state, { type: "pass", source: seat(1) }), {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass", phase: "awaitingDeal" },
    });
    assert.deepEqual(
      decide(state, { type: "startNextMatch", source: system }),
      {
        ok: false,
        code: "actionNotAllowed",
        details: { action: "startNextMatch", phase: "awaitingDeal" },
      },
    );
    assert.deepEqual(
      rejection(state, {
        type: "endMatch",
        resolution: { type: "restart" },
        source: host,
      }),
      {
        ok: false,
        code: "actionNotAllowed",
        details: { action: "endMatch", phase: "awaitingDeal" },
      },
    );
  });

  it("never mutates inputs and gives the same result for duplicate calls", () => {
    const state = deepFreeze(started(config28(), 0).state);
    const actions: EngineAction[] = [
      deepFreeze({
        type: "deal",
        deck: buildDeck(state.config),
        source: system,
      }),
      deepFreeze({ type: "bid", amount: 14, source: seat(1) }),
      deepFreeze({ type: "restartSession", firstDealer: 2, source: system }),
    ];
    const stateJson = JSON.stringify(state);

    for (const action of actions) {
      const actionJson = JSON.stringify(action);
      const first = act(state, action);
      const second = act(state, action);
      assert.deepEqual(first, second);
      assert.deepEqual(decide(state, action), decide(state, action));
      assert.equal(JSON.stringify(state), stateJson);
      assert.equal(JSON.stringify(action), actionJson);
    }
  });
});

describe("assertEngineInvariants", () => {
  function auctionState(): EngineState {
    const config = config56();
    const hands: ReturnType<typeof buildDeck>[] = [[], [], [], []];
    buildDeck(config).forEach((card, index) => {
      hands[(1 + index) % 4]?.push(card);
    });
    const match: MatchState = {
      hands,
      undealt: null,
      auction: {
        stage: "56",
        calls: [],
        turn: 1,
        highBid: null,
        doubledBy: null,
        redoubled: false,
        consecutivePasses: 0,
        carriedBid: null,
      },
      contract: null,
      faceDown: null,
      revealedInRound: null,
      rounds: [],
      currentRound: null,
      trumpPlayed: false,
      points: { A: 0, B: 0 },
      surrender: { decided: null, vote: null, lastFailedRound: null },
    };
    return { ...started(config, 0).state, phase: { type: "auction", match } };
  }

  function invariantCode(state: EngineState): string | null {
    try {
      assertEngineInvariants(state);
      return null;
    } catch (error) {
      assert.ok(error instanceof EngineInvariantError);
      assert.equal(error.message, `Engine invariant violated: ${error.code}`);
      return error.code;
    }
  }

  it("accepts a consistent match state", () => {
    assert.equal(invariantCode(auctionState()), null);
  });

  it("identifies each violation by code without exposing state", () => {
    const base = auctionState();
    if (base.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    const match = base.phase.match;
    const [first = [], ...rest] = match.hands;
    const duplicate = first[0];
    assert.ok(duplicate !== undefined);

    assert.equal(invariantCode({ ...base, dealer: 4 }), "dealerOutOfRange");
    assert.equal(
      invariantCode({ ...base, tokens: { A: -1, B: 3 } }),
      "invalidTokens",
    );
    assert.equal(
      invariantCode({ ...base, phase: { type: "play", match } }),
      "phaseMatchMismatch",
    );
    assert.equal(
      invariantCode({
        ...base,
        phase: {
          type: "auction",
          match: { ...match, hands: [first, ...rest, [duplicate]] },
        },
      }),
      "invalidSeatArrays",
    );
    assert.equal(
      invariantCode({
        ...base,
        phase: {
          type: "auction",
          match: { ...match, hands: [[...first, duplicate], ...rest] },
        },
      }),
      "duplicateCardLocation",
    );
    assert.equal(
      invariantCode({
        ...base,
        phase: {
          type: "auction",
          match: {
            ...match,
            auction: match.auction && { ...match.auction, turn: 4 },
          },
        },
      }),
      "seatOutOfRange",
    );
    assert.equal(
      invariantCode({
        ...base,
        matchLog: [
          {
            dealer: 0,
            contract: {
              bidder: 1,
              team: "B",
              amount: 14,
              trump: { type: "hidden", suit: "spades" } as never,
              style: null,
              multiplier: 1,
              forced: false,
            },
            points: { A: 0, B: 0 },
            tokensMoved: null,
            tokens: { A: 12, B: 12 },
            outcome: { type: "restarted" },
          },
        ],
      }),
      "summaryLeaksHiddenTrump",
    );

    const summary: MatchSummary = {
      dealer: 0,
      contract: {
        bidder: 1,
        team: "B",
        amount: 28,
        trump: { type: "noTrump" },
        style: null,
        multiplier: 1,
        forced: false,
      },
      points: { A: 30, B: 26 },
      tokensMoved: { payer: "B", amount: 2 },
      tokens: { A: 14, B: 10 },
      outcome: { type: "failed" },
    };
    const over = (
      tokens: { A: number; B: number },
      phase: EngineState["phase"],
    ): EngineState => ({ ...base, tokens, phase });

    assert.equal(
      invariantCode(over({ A: 14, B: 10 }, { type: "matchOver", summary })),
      null,
    );
    assert.equal(
      invariantCode(
        over(
          { A: 14, B: 10 },
          {
            type: "matchOver",
            summary: {
              ...summary,
              contract: summary.contract && { ...summary.contract, team: "A" },
            },
          },
        ),
      ),
      "contractTeamMismatch",
    );
    assert.equal(
      invariantCode(over({ A: 13, B: 11 }, { type: "matchOver", summary })),
      "invalidTokens",
    );
    const final = { ...summary, tokens: { A: 24, B: 0 } };
    assert.equal(
      invariantCode(
        over({ A: 24, B: 0 }, { type: "matchOver", summary: final }),
      ),
      "invalidTokens",
    );
    assert.equal(
      invariantCode(
        over(
          { A: 24, B: 0 },
          {
            type: "sessionOver",
            winner: "A",
            summary: final,
          },
        ),
      ),
      null,
    );
    assert.equal(
      invariantCode(
        over(
          { A: 24, B: 0 },
          {
            type: "sessionOver",
            winner: "B",
            summary: final,
          },
        ),
      ),
      "invalidTokens",
    );
    assert.equal(
      invariantCode(
        over({ A: 24, B: 0 }, { type: "sessionOver", winner: "A", summary }),
      ),
      "invalidTokens",
    );
  });
});
