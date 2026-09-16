import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck, cardPoints } from "./cards.js";
import {
  dealCards,
  evolveAuctionStarted,
  evolveDealt,
  validateDeck,
} from "./deal.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { DealtEvent, EngineEvent, MatchEndedEvent } from "./events.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import { redealReason } from "./redeal.js";
import type {
  EngineState,
  MatchOutcome,
  MatchState,
  MatchSummary,
} from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type { Card, EngineConfig } from "./types.js";

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
          match: { ...match, hands: [first.slice(1), ...rest] },
        },
      }),
      "missingCardLocation",
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
    ): EngineState => ({
      ...base,
      tokens,
      matchLog: "summary" in phase ? [phase.summary] : [],
      phase,
    });

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

// ---------------------------------------------------------------------------
// E003: dealing and automatic redeals

/** Every deck size/player-count combination the rules allow (rules §3, §10.1). */
function dealableConfigs(): EngineConfig[] {
  return [
    config56(),
    config56({ includeEightsAndSevens: true }),
    config56({ playerCount: 6 }),
    config56({ playerCount: 8 }),
    config56({ playerCount: 8, includeEightsAndSevens: true }),
    config28(),
  ];
}

describe("dealCards", () => {
  it("deals one card at a time counter-clockwise from the dealer's right", () => {
    for (const config of dealableConfigs()) {
      const deck = buildDeck(config);
      const { playerCount } = config;
      for (const dealer of [0, playerCount - 1, Math.floor(playerCount / 2)]) {
        const hands = dealCards(deck, dealer, playerCount);

        assert.equal(hands.length, playerCount);
        for (const hand of hands) {
          assert.equal(hand.length, deck.length / playerCount);
        }
        assert.equal(
          hands.reduce((total, hand) => total + hand.length, 0),
          deck.length,
        );

        const firstSeat = (dealer + 1) % playerCount;
        const lastSeat = (dealer + deck.length) % playerCount;
        const firstHand = hands[firstSeat];
        const lastHand = hands[lastSeat];
        assert.ok(firstHand !== undefined && lastHand !== undefined);
        assert.deepEqual(firstHand[0], deck[0]);
        assert.deepEqual(lastHand[lastHand.length - 1], deck[deck.length - 1]);

        // Clones, not the caller's own card objects.
        assert.notEqual(firstHand[0], deck[0]);
      }
    }
  });

  it("does not mutate the input deck", () => {
    const config = config56();
    const deck = deepFreeze(buildDeck(config));
    dealCards(deck, 0, config.playerCount);
    assert.deepEqual(deck, buildDeck(config));
  });
});

describe("validateDeck", () => {
  it("accepts an exact multiset match for every dealable config", () => {
    for (const config of dealableConfigs()) {
      assert.equal(validateDeck(config, buildDeck(config)), null);
    }
  });

  it("rejects a deck missing a card", () => {
    const config = config56();
    const deck = buildDeck(config).slice(1);
    const result = validateDeck(config, deck);
    assert.equal(result?.code, "invalidDeck");
  });

  it("rejects a deck with an extra card", () => {
    const config = config56();
    const base = buildDeck(config);
    const extra = [...base, base[0] as Card];
    const result = validateDeck(config, extra);
    assert.equal(result?.code, "invalidDeck");
  });

  it("rejects a deck with a duplicate replacing a needed card", () => {
    const config = config56();
    const base = buildDeck(config);
    const duplicated = [...base.slice(0, -1), base[0] as Card];
    const result = validateDeck(config, duplicated);
    assert.equal(result?.code, "invalidDeck");
  });

  it("rejects a deck with a foreign card", () => {
    const config = config56();
    const base = buildDeck(config);
    const foreign: Card = {
      suit: "spades",
      rank: "6" as Card["rank"],
      copy: 1,
    };
    const withForeign = [...base.slice(0, -1), foreign];
    const result = validateDeck(config, withForeign);
    assert.equal(result?.code, "invalidDeck");
  });

  it("rejects a deck with a wrong copy number", () => {
    const config = config56();
    const base = buildDeck(config);
    const index = base.findIndex((card) => card.copy === 1);
    assert.ok(index >= 0);
    const wrongCopy = base.map((card, i) =>
      i === index ? { ...card, copy: 2 as const } : card,
    );
    const result = validateDeck(config, wrongCopy);
    assert.equal(result?.code, "invalidDeck");
  });

  it("does not include deck contents in rejection details", () => {
    const config = config56();
    const result = validateDeck(config, buildDeck(config).slice(1));
    assert.equal(result?.code, "invalidDeck");
    for (const value of Object.values(result?.details ?? {})) {
      assert.ok(
        typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "string",
      );
    }
  });
});

describe("redealReason", () => {
  const card = (
    suit: Card["suit"],
    rank: Card["rank"],
    copy: 1 | 2 = 1,
  ): Card => ({ suit, rank, copy });

  it("detects a team holding no Jack across its own seats", () => {
    const holdings: Card[][] = [
      [card("spades", "J")],
      [card("hearts", "Q"), card("hearts", "K")],
      [card("diamonds", "J")],
      [card("clubs", "Q"), card("clubs", "K")],
    ];
    assert.deepEqual(redealReason(holdings, 2), {
      type: "teamWithoutJack",
      team: "B",
    });
  });

  it("detects a low hand when every team holds a Jack", () => {
    const holdings: Card[][] = [
      [card("spades", "J")],
      [card("hearts", "J")],
      [card("spades", "A")],
      [card("hearts", "10")],
    ];
    assert.deepEqual(redealReason(holdings, 0), null);

    const lowHoldings: Card[][] = [
      [card("spades", "J")],
      [card("hearts", "J")],
      [card("spades", "A")],
      [card("hearts", "K"), card("hearts", "Q")],
    ];
    assert.deepEqual(redealReason(lowHoldings, 0), {
      type: "lowHand",
      seat: 3,
      points: 0,
    });
  });

  it("checks team-without-Jack before any low hand", () => {
    const holdings: Card[][] = [
      [card("spades", "J")],
      [card("hearts", "K"), card("hearts", "Q")],
      [card("diamonds", "J")],
      [card("clubs", "K"), card("clubs", "Q")],
    ];
    // Every seat is at or below the threshold, so a low hand exists too.
    assert.deepEqual(redealReason(holdings, 7), {
      type: "teamWithoutJack",
      team: "B",
    });
  });

  it("picks the lowest-indexed seat when several qualify", () => {
    const holdings: Card[][] = [
      [card("spades", "K"), card("spades", "Q")],
      [card("hearts", "K"), card("hearts", "Q")],
      [card("diamonds", "J"), card("diamonds", "9")],
      [card("clubs", "J"), card("clubs", "9")],
    ];
    assert.deepEqual(redealReason(holdings, 2), {
      type: "lowHand",
      seat: 0,
      points: 0,
    });
  });

  it("returns null when no team lacks a Jack and no hand is low", () => {
    const holdings: Card[][] = [
      [card("spades", "J")],
      [card("hearts", "J")],
      [card("spades", "A")],
      [card("hearts", "10")],
    ];
    assert.equal(redealReason(holdings, 0), null);
  });
});

describe("deal action", () => {
  const system = { type: "system" } as const;

  /**
   * Reorders a 4-player deck so every Jack lands on the two seats that are
   * the dealer's right and the seat two to their right (both team B when the
   * dealer is seat 0), leaving team A with none — a deterministic
   * `teamWithoutJack` fixture without relying on any particular shuffle.
   */
  function noJackForTeamADeck(config: EngineConfig): Card[] {
    const deck = buildDeck(config);
    const jacks = deck.filter((c) => c.rank === "J");
    const rest = deck.filter((c) => c.rank !== "J");
    const result: Card[] = [];
    let jackIndex = 0;
    let restIndex = 0;
    for (let k = 0; k < deck.length; k += 1) {
      const bSlot = k % 4 === 0 || k % 4 === 2;
      const next =
        bSlot && jackIndex < jacks.length
          ? jacks[jackIndex++]
          : rest[restIndex++];
      assert.ok(next !== undefined);
      result.push(next);
    }
    return result;
  }

  it("56: deals the full deck and starts the auction when there is no redeal", () => {
    const config = config56();
    const { state } = started(config, 0);
    const deck = buildDeck(config);
    const hands = dealCards(deck, 0, config.playerCount);
    // Sanity: this natural deck order does not itself trigger a redeal.
    assert.equal(redealReason(hands, config.redealThreshold), null);

    const action: EngineAction = { type: "deal", source: system, deck };
    const result = act(state, action);
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }

    assert.deepEqual(result.events, [
      { type: "dealt", stage: "full", hands, undealt: null },
      { type: "auctionStarted", stage: "56", firstTurn: 1, minBid: 28 },
    ]);
    assert.equal(result.state.phase.type, "auction");
    if (result.state.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.state.phase.match.hands, hands);
    assert.equal(result.state.phase.match.undealt, null);
    assert.deepEqual(result.state.phase.match.auction, {
      stage: "56",
      calls: [],
      turn: 1,
      highBid: null,
      doubledBy: null,
      redoubled: false,
      consecutivePasses: 0,
      carriedBid: null,
    });
    assertEngineInvariants(result.state);

    const replayed = result.events.reduce<EngineState>(
      (current, event) => evolve(current, event),
      state,
    );
    assert.deepEqual(replayed, result.state);
  });

  it("56: redeals on a team without a Jack, keeping the same dealer and tokens, without logging it", () => {
    const config = config56({ redealThreshold: 13 });
    const { state } = started(config, 0);
    const deck = noJackForTeamADeck(config);
    const hands = dealCards(deck, 0, config.playerCount);
    const handPoints = hands.map((hand) =>
      hand.reduce((total, c) => total + cardPoints(c), 0),
    );
    // Sanity: a low hand also exists, to prove team-without-Jack still wins.
    const threshold = Math.max(...handPoints);
    assert.deepEqual(redealReason(hands, threshold), {
      type: "teamWithoutJack",
      team: "A",
    });

    const action: EngineAction = { type: "deal", source: system, deck };
    const result = act(state, action);
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }

    const reason = { type: "teamWithoutJack" as const, team: "A" as const };
    const summary: MatchSummary = {
      dealer: 0,
      contract: null,
      points: { A: 0, B: 0 },
      tokensMoved: null,
      tokens: { A: config.startingTokens, B: config.startingTokens },
      outcome: { type: "redealt", reason },
    };
    assert.deepEqual(result.events, [
      { type: "dealt", stage: "full", hands, undealt: null },
      { type: "redealt", reason },
      { type: "matchEnded", summary },
    ]);
    assert.deepEqual(result.state, {
      config,
      tokens: { A: config.startingTokens, B: config.startingTokens },
      dealer: 0,
      matchLog: [],
      pastSessions: [],
      phase: { type: "awaitingDeal", reason: "redeal" },
    });
    assertEngineInvariants(result.state);

    const replayed = result.events.reduce<EngineState>(
      (current, event) => evolve(current, event),
      state,
    );
    assert.deepEqual(replayed, result.state);
  });

  it("56: redeals on a low hand when every team holds a Jack", () => {
    const config = config56({ playerCount: 6, redealThreshold: 8 });
    const { state } = started(config, 1);
    const deck = buildDeck(config);
    const hands = dealCards(deck, 1, config.playerCount);
    const reason = redealReason(hands, config.redealThreshold);
    assert.equal(reason?.type, "lowHand");

    const action: EngineAction = { type: "deal", source: system, deck };
    const result = act(state, action);
    assert.equal(result.ok, true);
    if (!result.ok || result.state.phase.type !== "awaitingDeal") {
      throw new Error("unreachable");
    }
    assert.equal(result.state.phase.reason, "redeal");
    assert.equal(result.state.dealer, 1);
    assert.deepEqual(result.state.tokens, state.tokens);
    assert.deepEqual(result.state.matchLog, []);
    assertEngineInvariants(result.state);
  });

  it("rejects an invalid deck without changing state", () => {
    const config = config56();
    const { state } = started(config, 0);
    const badDeck = buildDeck(config).slice(1);
    const action: EngineAction = {
      type: "deal",
      source: system,
      deck: badDeck,
    };

    assert.deepEqual(decide(state, action), {
      ok: false,
      code: "invalidDeck",
      details: {
        expectedCount: buildDeck(config).length,
        actualCount: badDeck.length,
      },
    });
    const result = act(state, action);
    assert.equal(result.ok, false);
  });

  it("28: deals only the first four cards per seat and does not check for a redeal", () => {
    const config = config28();
    const { state } = started(config, 0);
    const deck = buildDeck(config);
    const firstHands = dealCards(deck.slice(0, 16), 0, config.playerCount);
    const undealt = dealCards(deck.slice(16), 0, config.playerCount);

    // Sanity: the first four cards alone would already call for a redeal
    // (team A holds no Jack in them), proving the check really is skipped.
    assert.deepEqual(redealReason(firstHands, config.redealThreshold), {
      type: "teamWithoutJack",
      team: "A",
    });

    const action: EngineAction = { type: "deal", source: system, deck };
    const result = act(state, action);
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }

    assert.deepEqual(result.events, [
      { type: "dealt", stage: "first", hands: firstHands, undealt },
      { type: "auctionStarted", stage: "28-first", firstTurn: 1, minBid: 14 },
    ]);
    assert.equal(result.state.phase.type, "auction");
    if (result.state.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.state.phase.match.hands, firstHands);
    assert.deepEqual(result.state.phase.match.undealt, undealt);
    assert.equal(result.state.phase.match.auction?.stage, "28-first");
    assert.equal(result.state.phase.match.auction?.turn, 1);
    assertEngineInvariants(result.state);

    const replayed = result.events.reduce<EngineState>(
      (current, event) => evolve(current, event),
      state,
    );
    assert.deepEqual(replayed, result.state);
  });
});

describe("evolveMatchEnded", () => {
  function redealSummary(config: EngineConfig, dealer: number): MatchSummary {
    return {
      dealer,
      contract: null,
      points: { A: 0, B: 0 },
      tokensMoved: null,
      tokens: { A: config.startingTokens, B: config.startingTokens },
      outcome: {
        type: "redealt",
        reason: { type: "teamWithoutJack", team: "A" },
      },
    };
  }

  /**
   * A redeal always ends a match that is in progress: `evolveDealt` opens the
   * auction and `evolveRedealt` is a transient no-op, so `matchEnded(redealt)`
   * lands on an `auction` phase, never on `awaitingDeal`.
   */
  function dealtState(config: EngineConfig): EngineState {
    const { state } = started(config, 0);
    const seats = config.playerCount;
    const hands: Card[][] = Array.from({ length: seats }, () => []);
    buildDeck(config).forEach((card, index) => {
      hands[(1 + index) % seats]?.push(card);
    });

    if (config.gameType !== "28") {
      const next = evolve(state, {
        type: "dealt",
        stage: "full",
        hands,
        undealt: null,
      });
      assert.equal(next.phase.type, "auction");
      return next;
    }

    // 28 deals in two stages; a redeal is only detected after the second.
    const half = hands.map((hand) => hand.length / 2);
    const first = evolve(state, {
      type: "dealt",
      stage: "first",
      hands: hands.map((hand, index) => hand.slice(0, half[index])),
      undealt: hands.map((hand, index) => hand.slice(half[index])),
    });
    const second = evolve(first, {
      type: "dealt",
      stage: "second",
      hands: hands.map((hand, index) => hand.slice(half[index])),
      undealt: null,
    });
    assert.equal(second.phase.type, "auction");
    return second;
  }

  it("design §10.3: appends a 28 automatic redeal to matchLog but not a 56 one", () => {
    const config56Value = config56();
    const state56 = dealtState(config56Value);
    const summary56 = redealSummary(config56Value, 0);
    const result56 = evolve(state56, {
      type: "matchEnded",
      summary: summary56,
    });
    assert.deepEqual(result56, {
      ...state56,
      matchLog: [],
      phase: { type: "awaitingDeal", reason: "redeal" },
    });
    assertEngineInvariants(result56);

    const config28Value = config28();
    const state28 = dealtState(config28Value);
    const summary28 = redealSummary(config28Value, 0);
    const result28 = evolve(state28, {
      type: "matchEnded",
      summary: summary28,
    });
    assert.deepEqual(result28, {
      ...state28,
      matchLog: [summary28],
      phase: { type: "awaitingDeal", reason: "redeal" },
    });
    assertEngineInvariants(result28);
  });

  it("throws on a redeal with no match in progress", () => {
    const config = config56();
    const { state } = started(config, 0);
    assert.equal(state.phase.type, "awaitingDeal");
    assert.throws(() =>
      evolve(state, { type: "matchEnded", summary: redealSummary(config, 0) }),
    );
  });

  it("throws for a scored or restarted outcome with no match in progress", () => {
    const config = config56();
    const { state } = started(config, 0);
    const base = {
      dealer: 0 as const,
      contract: null,
      points: { A: 0, B: 0 },
      tokensMoved: null,
      tokens: { A: config.startingTokens, B: config.startingTokens },
    };
    const outcomes: MatchOutcome[] = [
      { type: "made" },
      { type: "failed" },
      { type: "disqualified", seat: 0, kind: "didNotFollowSuit" },
      { type: "surrendered", team: "A" },
      { type: "awarded", team: "A" },
      { type: "restarted" },
    ];

    for (const outcome of outcomes) {
      const event: MatchEndedEvent = {
        type: "matchEnded",
        summary: { ...base, outcome },
      };
      assert.throws(() => evolve(state, event));
    }
  });
});

describe("evolveAuctionStarted", () => {
  it("throws instead of silently returning state unchanged on a phase mismatch (design §13.1)", () => {
    const config = config56();
    const { state } = started(config, 0);
    assert.equal(state.phase.type, "awaitingDeal");

    assert.throws(() =>
      evolveAuctionStarted(state, {
        type: "auctionStarted",
        stage: "56",
        firstTurn: 1,
        minBid: 28,
      }),
    );
  });
});

describe("evolveDealt", () => {
  it("throws for a 28 second deal without a live match to merge into", () => {
    const config = config28();
    const { state } = started(config, 0);
    const deck = buildDeck(config);
    const hands = dealCards(deck.slice(16), 0, config.playerCount);

    const event: DealtEvent = {
      type: "dealt",
      stage: "second",
      hands,
      undealt: null,
    };

    assert.throws(() => evolveDealt(state, event));
  });
});
