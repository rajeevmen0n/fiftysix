import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck, cardPoints } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent } from "./events.js";
import { decideHostAction } from "./host-actions.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import { scoreMatch } from "./scoring.js";
import { teamOf } from "./seats.js";
import { decideSessionAction } from "./session.js";
import type {
  CompletedRound,
  EngineState,
  MatchState,
  MatchSummary,
  RoundPlay,
  ScoredOutcome,
  SummaryContract,
} from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type {
  Card,
  EngineConfig,
  Rank,
  Suit,
  Team,
  TokenBalances,
} from "./types.js";

// E006: scoring, host End match, and session transitions.

/** The default stake tiers from rules §7.1. */
function config56(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    gameType: "56",
    playerCount: 4,
    includeEightsAndSevens: false,
    illegalPlayMode: "block",
    startingTokens: 20,
    stakeTiers: [
      { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
      { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
      { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
    ],
    redealThreshold: 0,
    surrenderOption: "off",
    ...overrides,
  };
}

function config28(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    gameType: "28",
    playerCount: 4,
    includeEightsAndSevens: true,
    illegalPlayMode: "block",
    startingTokens: 10,
    stakeTiers: [
      { fromBid: 14, toBid: 19, winStake: 1, lossStake: 2 },
      { fromBid: 20, toBid: 27, winStake: 2, lossStake: 3 },
      { fromBid: 28, toBid: 28, winStake: 3, lossStake: 4 },
    ],
    redealThreshold: 1,
    surrenderOption: "off",
    ...overrides,
  };
}

const SUIT_CODES: Readonly<Record<string, Suit>> = {
  S: "spades",
  H: "hearts",
  D: "diamonds",
  C: "clubs",
};

/** `c("HJ")` is the jack of hearts. */
function c(code: string): Card {
  const suit = SUIT_CODES[code.slice(0, 1)];
  assert.ok(suit !== undefined);
  return { suit, rank: code.slice(1) as Rank, copy: 1 };
}

const cards = (codes: string): Card[] => codes.split(" ").map(c);

/** A 28 deck dealing `first[seat]` then `second[seat]` to each seat. */
function deckFor(dealer: number, first: Card[][], second: Card[][]): Card[] {
  const deck: Card[] = [];
  for (const [base, holdings] of [
    [0, first],
    [16, second],
  ] as const) {
    holdings.forEach((held, seat) => {
      const offset = (seat - dealer - 1 + 8) % 4;
      held.forEach((card, index) => {
        deck[base + index * 4 + offset] = card;
      });
    });
  }
  assert.equal(deck.length, 32);
  return deck;
}

// Seat 1 holds the jack of hearts in its first four cards; no redeal.
const FIRST_28 = [
  cards("SJ S9 HA H10"),
  cards("HJ H9 DA D10"),
  cards("DJ D9 CA C10"),
  cards("CJ C9 SA S10"),
];
const SECOND_28 = [
  cards("DK DQ C8 C7"),
  cards("CK CQ S8 S7"),
  cards("SK SQ H8 H7"),
  cards("HK HQ D8 D7"),
];

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;
const host = { type: "host" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const bid56 = (seatNumber: number, amount: number): EngineAction => ({
  type: "bid",
  amount,
  suit: "spades",
  style: "numberFirst",
  source: seat(seatNumber),
});
const bid28 = (seatNumber: number, amount: number): EngineAction => ({
  type: "bid",
  amount,
  source: seat(seatNumber),
});
const pass = (seatNumber: number): EngineAction => ({
  type: "pass",
  source: seat(seatNumber),
});
const double = (seatNumber: number): EngineAction => ({
  type: "double",
  source: seat(seatNumber),
});
const redouble = (seatNumber: number): EngineAction => ({
  type: "redouble",
  source: seat(seatNumber),
});
const place = (seatNumber: number, card: Card): EngineAction => ({
  type: "placeCard",
  card,
  source: seat(seatNumber),
});
const restart: EngineAction = {
  type: "endMatch",
  resolution: { type: "restart" },
  source: host,
};
const award = (team: Team): EngineAction => ({
  type: "endMatch",
  resolution: { type: "award", team },
  source: host,
});
const startNextMatch: EngineAction = { type: "startNextMatch", source: system };
const restartSession = (firstDealer: number): EngineAction => ({
  type: "restartSession",
  firstDealer,
  source: system,
});

function newState(config: EngineConfig, dealer = 0): EngineState {
  const started = newSession(config, dealer);
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error("unreachable");
  }
  return started.state;
}

interface Flow {
  state: EngineState;
  /** Events of the last accepted action. */
  events: EngineEvent[];
}

/** Applies each action via `act`, asserting acceptance, replay, and invariants. */
function run(state: EngineState, actions: EngineAction[]): Flow {
  let current = state;
  let events: EngineEvent[] = [];
  for (const action of actions) {
    const result = act(current, action);
    assert.equal(
      result.ok,
      true,
      `expected ${action.type} to be accepted: ${JSON.stringify(result.ok ? {} : result)}`,
    );
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const replayed = result.events.reduce(
      (acc, event) => evolve(acc, event),
      current,
    );
    assert.equal(JSON.stringify(replayed), JSON.stringify(result.state));
    assertEngineInvariants(result.state);
    current = result.state;
    events = result.events;
  }
  return { state: current, events };
}

function rejection(state: EngineState, action: EngineAction) {
  const decision = decide(state, action);
  assert.equal(decision.ok, false, `expected ${action.type} to be rejected`);
  assert.deepEqual(act(state, action), decision);
  return decision.ok
    ? null
    : { code: decision.code, details: decision.details };
}

function matchOf(state: EngineState): MatchState {
  if (!("match" in state.phase)) {
    throw new Error("expected a match in progress");
  }
  return state.phase.match;
}

function withMatch(state: EngineState, match: MatchState): EngineState {
  const { phase } = state;
  if (!("match" in phase)) {
    throw new Error("expected a match in progress");
  }
  return { ...state, phase: { type: phase.type, match } };
}

/** A 56 match in play, dealt by `dealer` from the natural deck order. */
function playing56(
  calls: EngineAction[],
  config: EngineConfig = config56(),
  dealer = 0,
): EngineState {
  const state = run(newState(config, dealer), [
    deal(buildDeck(config)),
    ...calls,
  ]).state;
  assert.equal(state.phase.type, "play");
  return state;
}

/** A 28 match in play with seat 1's unrevealed hidden trump (hearts). */
function playing28Hidden(config: EngineConfig = config28()): EngineState {
  const state = run(newState(config, 0), [
    deal(deckFor(0, FIRST_28, SECOND_28)),
    bid28(1, 18),
    double(2),
    redouble(3),
    place(1, c("HJ")),
  ]).state;
  assert.equal(state.phase.type, "play");
  return state;
}

/**
 * Hand-builds finished rounds on a match in play (card play itself is E007):
 * each round takes the first card of every hand in turn order from its
 * leader, and is won by the next seat in `winners`, who leads the next round.
 */
function withRounds(
  state: EngineState,
  winners: readonly number[],
): EngineState {
  const match = matchOf(state);
  const { playerCount } = state.config;
  const hands = match.hands.map((hand) => [...hand]);
  const rounds: CompletedRound[] = [];
  const points = { A: 0, B: 0 };
  let leader = match.currentRound?.leader ?? 0;
  for (const winner of winners) {
    const plays: RoundPlay[] = [];
    for (let offset = 0; offset < playerCount; offset += 1) {
      const player = (leader + offset) % playerCount;
      const card = hands[player]?.shift();
      assert.ok(card !== undefined);
      plays.push({ seat: player, card, fromFaceDown: false });
    }
    const roundPoints = plays.reduce(
      (total, play) => total + cardPoints(play.card),
      0,
    );
    rounds.push({ leader, plays, winner, points: roundPoints });
    points[teamOf(winner)] += roundPoints;
    leader = winner;
  }
  const next = withMatch(state, {
    ...match,
    hands,
    rounds,
    points,
    currentRound: {
      leader,
      plays: [],
      turn: leader,
      leadSuit: null,
      revealedThisRound: false,
      revealAskedBy: null,
    },
  });
  assertEngineInvariants(next);
  return next;
}

function withTokens(state: EngineState, tokens: TokenBalances): EngineState {
  const next = { ...state, tokens };
  assertEngineInvariants(next);
  return next;
}

function withVote(state: EngineState): EngineState {
  const match = matchOf(state);
  const next = withMatch(state, {
    ...match,
    surrender: {
      decided: "B",
      vote: { proposer: 1, yes: [1], no: [] },
      lastFailedRound: null,
    },
  });
  assertEngineInvariants(next);
  return next;
}

function contract56(multiplier: 1 | 2 | 4, amount = 30): SummaryContract {
  return {
    bidder: 1,
    team: "B",
    amount,
    trump: { type: "suit", suit: "spades" },
    style: "numberFirst",
    multiplier,
    forced: false,
  };
}

/** Seat 1 (team B) bids `amount` spades, with the given double state. */
function calls56(multiplier: 1 | 2 | 4, amount = 30): EngineAction[] {
  switch (multiplier) {
    case 1:
      return [bid56(1, amount), pass(2), pass(3), pass(0)];
    case 2:
      return [bid56(1, amount), double(2), pass(3), pass(0), pass(1)];
    case 4:
      return [bid56(1, amount), double(2), redouble(3)];
  }
}

function applyEvents(state: EngineState, events: EngineEvent[]): EngineState {
  const next = events.reduce((acc, event) => evolve(acc, event), state);
  assertEngineInvariants(next);
  return next;
}

// ---------------------------------------------------------------------------

describe("scoreMatch: who pays (design §10.3)", () => {
  // Bid 30 by team B: win stake 1, loss stake 2, before the multiplier.
  const rows: {
    name: string;
    outcome: ScoredOutcome;
    winners: number[];
    payer: Team;
    stake: "win" | "loss";
  }[] = [
    {
      name: "made",
      outcome: { type: "made" },
      winners: Array(12).fill(1),
      payer: "A",
      stake: "win",
    },
    {
      name: "failed",
      outcome: { type: "failed" },
      winners: Array(12).fill(0),
      payer: "B",
      stake: "loss",
    },
    {
      name: "disqualified bidding-team seat",
      outcome: { type: "disqualified", seat: 3, kind: "didNotFollowSuit" },
      winners: [1, 0],
      payer: "B",
      stake: "loss",
    },
    {
      name: "disqualified defender",
      outcome: { type: "disqualified", seat: 2, kind: "ledTrumpEarly" },
      winners: [0],
      payer: "A",
      stake: "win",
    },
    {
      name: "surrendered by the defenders",
      outcome: { type: "surrendered", team: "A" },
      winners: Array(6).fill(3),
      payer: "A",
      stake: "win",
    },
    {
      name: "surrendered by the bidding team",
      outcome: { type: "surrendered", team: "B" },
      winners: Array(6).fill(2),
      payer: "B",
      stake: "loss",
    },
    {
      name: "awarded to the bidding team",
      outcome: { type: "awarded", team: "B" },
      winners: [],
      payer: "A",
      stake: "win",
    },
    {
      name: "awarded to the defenders",
      outcome: { type: "awarded", team: "A" },
      winners: [0, 1],
      payer: "B",
      stake: "loss",
    },
  ];

  for (const row of rows) {
    it(`${row.name}: ${row.payer} pays the ${row.stake} stake at ×1, ×2, and ×4`, () => {
      for (const multiplier of [1, 2, 4] as const) {
        const state = withRounds(playing56(calls56(multiplier)), row.winners);
        const { points } = matchOf(state);
        const amount = (row.stake === "win" ? 1 : 2) * multiplier;
        const tokens = {
          A: 20 + (row.payer === "A" ? -amount : amount),
          B: 20 + (row.payer === "B" ? -amount : amount),
        };
        const summary: MatchSummary = {
          dealer: 0,
          contract: contract56(multiplier),
          points: { A: points.A, B: points.B },
          tokensMoved: { payer: row.payer, amount },
          tokens,
          outcome: row.outcome,
        };

        const events = scoreMatch(deepFreeze(state), row.outcome);
        assert.deepEqual(events, [{ type: "matchEnded", summary }]);

        const after = applyEvents(state, events);
        assert.deepEqual(after, {
          ...state,
          tokens,
          matchLog: [summary],
          phase: { type: "matchOver", summary },
        });
      }
    });
  }

  it("uses the contract's tier: a redoubled 56 wins 12 or loses 16", () => {
    const made = withRounds(playing56(calls56(4, 56)), Array(12).fill(3));
    const [madeEnded] = scoreMatch(made, { type: "made" });
    assert.equal(madeEnded?.type, "matchEnded");
    assert.deepEqual(
      madeEnded?.type === "matchEnded" && madeEnded.summary.tokensMoved,
      { payer: "A", amount: 12 },
    );

    const failed = withRounds(playing56(calls56(4, 56)), [1, 0]);
    const events = scoreMatch(failed, { type: "failed" });
    assert.deepEqual(
      events.map((event) => event.type),
      ["matchEnded"],
    );
    assert.deepEqual(
      events[0]?.type === "matchEnded" && events[0].summary.tokens,
      { A: 36, B: 4 },
    );

    // A 40–55 bid: win 2, loss 3.
    const tier2 = playing56(calls56(2, 40));
    const [awarded] = scoreMatch(tier2, { type: "awarded", team: "A" });
    assert.deepEqual(
      awarded?.type === "matchEnded" && awarded.summary.tokensMoved,
      { payer: "B", amount: 6 },
    );
  });

  it("scores a forced bid at its tier and multiplier 1", () => {
    const state = playing56([pass(1), pass(2), pass(3), pass(0)]);
    const [ended] = scoreMatch(state, { type: "awarded", team: "A" });
    assert.ok(ended?.type === "matchEnded");
    assert.deepEqual(ended.summary.contract, {
      bidder: 1,
      team: "B",
      amount: 28,
      trump: { type: "noTrump" },
      style: null,
      multiplier: 1,
      forced: true,
    });
    assert.deepEqual(ended.summary.tokensMoved, { payer: "B", amount: 2 });
  });

  it("throws for a state not in play or a made/failed result its points contradict", () => {
    const state = playing56(calls56(1));
    assert.throws(() => scoreMatch(state, { type: "made" }));
    assert.throws(() =>
      scoreMatch(withRounds(state, Array(12).fill(1)), { type: "failed" }),
    );
    assert.throws(() =>
      scoreMatch(newState(config56()), { type: "awarded", team: "A" }),
    );
  });
});

describe("scoring: capped payment and session end", () => {
  it("caps the payment at what the payer holds; team A wins the session", () => {
    const state = withTokens(
      withRounds(playing56(calls56(4)), Array(12).fill(0)),
      { A: 37, B: 3 },
    );
    const events = scoreMatch(state, { type: "failed" });
    const summary: MatchSummary = {
      dealer: 0,
      contract: contract56(4),
      points: { A: 56, B: 0 },
      tokensMoved: { payer: "B", amount: 3 },
      tokens: { A: 40, B: 0 },
      outcome: { type: "failed" },
    };
    assert.deepEqual(events, [
      { type: "matchEnded", summary },
      { type: "sessionEnded", winner: "A" },
    ]);
    const after = applyEvents(state, events);
    assert.deepEqual(after.phase, {
      type: "sessionOver",
      winner: "A",
      summary,
    });
    assert.deepEqual(after.matchLog, [summary]);
    assert.deepEqual(after.tokens, { A: 40, B: 0 });
  });

  it("team B wins the session when an exact award payment empties team A", () => {
    const state = withTokens(playing56(calls56(1)), { A: 1, B: 39 });
    const { state: after, events } = run(state, [award("B")]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["matchEnded", "sessionEnded"],
    );
    assert.deepEqual(events[1], { type: "sessionEnded", winner: "B" });
    assert.equal(after.phase.type, "sessionOver");
    assert.deepEqual(after.tokens, { A: 0, B: 40 });
    assert.equal(after.dealer, 0);
  });

  it("a scored match leaving both teams above 0 enters matchOver", () => {
    const { state, events } = run(playing56(calls56(2)), [award("A")]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["matchEnded"],
    );
    assert.equal(state.phase.type, "matchOver");
    assert.deepEqual(state.tokens, { A: 24, B: 16 });
  });
});

describe("host endMatch(restart) (design §10.2)", () => {
  function expectRestart(
    state: EngineState,
    contract: SummaryContract | null,
  ): EngineState {
    const summary: MatchSummary = {
      dealer: state.dealer,
      contract,
      points: { ...matchOf(state).points },
      tokensMoved: null,
      tokens: { ...state.tokens },
      outcome: { type: "restarted" },
    };
    const { state: after, events } = run(state, [restart]);
    assert.deepEqual(events, [{ type: "matchEnded", summary }]);
    assert.deepEqual(after, {
      config: state.config,
      tokens: state.tokens,
      dealer: state.dealer,
      matchLog: [...state.matchLog, summary],
      pastSessions: state.pastSessions,
      phase: { type: "awaitingDeal", reason: "restart" },
    });
    return after;
  }

  const hidden16: SummaryContract = {
    bidder: 1,
    team: "B",
    amount: 16,
    trump: { type: "hidden" },
    style: null,
    multiplier: 1,
    forced: false,
  };
  const deck28 = deckFor(0, FIRST_28, SECOND_28);
  const firstAuctionWon = [
    deal(deck28),
    bid28(1, 16),
    pass(2),
    pass(3),
    pass(0),
  ];

  it("56 auction: no contract, no tokens moved, same dealer deals again", () => {
    const config = config56();
    const auction = run(newState(config, 2), [
      deal(buildDeck(config)),
      bid56(3, 30),
    ]).state;
    const after = expectRestart(auction, null);

    const redealt = run(after, [deal(buildDeck(config))]);
    assert.deepEqual(redealt.events[1], {
      type: "auctionStarted",
      stage: "56",
      firstTurn: 3,
      minBid: 28,
    });
  });

  it("28 first auction and its placement: no contract exists yet", () => {
    const auction = run(newState(config28()), [deal(deck28), bid28(1, 16)]);
    assert.equal(auction.state.phase.type, "auction");
    expectRestart(auction.state, null);

    const placing = run(newState(config28()), firstAuctionWon).state;
    assert.equal(placing.phase.type, "placingCard");
    expectRestart(placing, null);
  });

  it("28 second auction: logs the public first-auction contract, even after a second-auction double", () => {
    const second = run(newState(config28()), [
      ...firstAuctionWon,
      place(1, c("HJ")),
    ]).state;
    assert.equal(matchOf(second).auction?.stage, "28-second");
    const after = expectRestart(second, hidden16);
    assert.ok(!JSON.stringify(after).includes("hearts"));

    const doubled = run(second, [pass(1), double(2)]).state;
    assert.equal(matchOf(doubled).auction?.doubledBy, 2);
    expectRestart(doubled, hidden16);
  });

  it("28 placement after the second auction: logs the first-auction contract", () => {
    const placing = run(newState(config28()), [
      ...firstAuctionWon,
      place(1, c("HJ")),
      pass(1),
      bid28(2, 21),
      pass(3),
      pass(0),
      pass(1),
    ]).state;
    assert.equal(placing.phase.type, "placingCard");
    assert.equal(matchOf(placing).faceDown, null);
    expectRestart(placing, hidden16);
  });

  it("a forced 14 carried into the second auction logs no trump", () => {
    const second = run(newState(config28()), [
      deal(deck28),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
    ]).state;
    assert.equal(matchOf(second).auction?.stage, "28-second");
    expectRestart(second, {
      bidder: 1,
      team: "B",
      amount: 14,
      trump: { type: "noTrump" },
      style: null,
      multiplier: 1,
      forced: true,
    });
  });

  it("play: logs the contract and points so far without moving tokens", () => {
    const state = withRounds(playing56(calls56(2)), [1, 2]);
    assert.ok(matchOf(state).points.A > 0 || matchOf(state).points.B > 0);
    expectRestart(state, contract56(2));

    expectRestart(playing28Hidden(), {
      bidder: 1,
      team: "B",
      amount: 18,
      trump: { type: "hidden" },
      style: null,
      multiplier: 4,
      forced: false,
    });
  });

  it("during a surrender vote: cancels the vote with the match", () => {
    const voting = withVote(
      playing56(calls56(1), config56({ surrenderOption: "on" })),
    );
    expectRestart(voting, contract56(1));
  });

  it("is rejected outside a match in progress", () => {
    const fresh = newState(config56());
    const restarted = run(playing56(calls56(1)), [restart]).state;
    const over = run(playing56(calls56(1)), [award("A")]).state;
    const sessionOver = run(
      withTokens(playing56(calls56(1)), { A: 38, B: 2 }),
      [award("A")],
    ).state;
    for (const state of [fresh, restarted, over, sessionOver]) {
      assert.deepEqual(rejection(state, restart), {
        code: "actionNotAllowed",
        details: { action: "endMatch", phase: state.phase.type },
      });
      assert.deepEqual(decideHostAction(state, restart), {
        ok: false,
        code: "actionNotAllowed",
        details: {
          action: "endMatch",
          resolution: "restart",
          phase: state.phase.type,
        },
      });
    }
  });

  it("rejects a malformed resolution", () => {
    const state = playing56(calls56(1));
    const malformed = [
      { type: "cancel" },
      { type: "award" },
      { type: "award", team: "C" },
      null,
      "restart",
    ];
    for (const resolution of malformed) {
      const action = {
        type: "endMatch",
        resolution,
        source: host,
      } as unknown as EngineAction;
      assert.deepEqual(rejection(state, action), {
        code: "actionNotAllowed",
        details: { action: "endMatch", reason: "invalidResolution" },
      });
    }
    assert.deepEqual(decideHostAction(state, pass(1)), {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass" },
    });
  });
});

describe("host endMatch(award) (design §10.2)", () => {
  it("is available only once play has started", () => {
    const config = config56();
    const auction = run(newState(config), [deal(buildDeck(config))]).state;
    const placing = run(newState(config28()), [
      deal(deckFor(0, FIRST_28, SECOND_28)),
      bid28(1, 16),
      pass(2),
      pass(3),
      pass(0),
    ]).state;
    const second = run(placing, [place(1, c("HJ"))]).state;

    for (const state of [auction, placing, second]) {
      assert.deepEqual(rejection(state, award("A")), {
        code: "actionNotAllowed",
        details: {
          action: "endMatch",
          resolution: "award",
          phase: state.phase.type,
        },
      });
    }
    assert.deepEqual(rejection(newState(config), award("A")), {
      code: "actionNotAllowed",
      details: { action: "endMatch", phase: "awaitingDeal" },
    });
  });

  it("scores the named winner in play, keeping the dealer", () => {
    // Dealer 3: seat 0 (team A) bids; awarding team B makes team A pay its
    // loss stake.
    const state = playing56(
      [bid56(0, 30), pass(1), pass(2), pass(3)],
      config56(),
      3,
    );
    const { state: after, events } = run(state, [award("B")]);
    assert.equal(events.length, 1);
    const [ended] = events;
    assert.ok(ended?.type === "matchEnded");
    assert.deepEqual(ended.summary.outcome, { type: "awarded", team: "B" });
    assert.deepEqual(ended.summary.tokensMoved, { payer: "A", amount: 2 });
    assert.equal(ended.summary.dealer, 3);
    assert.equal(after.dealer, 3);
    assert.deepEqual(after.tokens, { A: 18, B: 22 });
  });

  it("is available during a surrender vote", () => {
    const voting = withVote(
      playing56(calls56(1), config56({ surrenderOption: "on" })),
    );
    const { state } = run(voting, [award("A")]);
    assert.equal(state.phase.type, "matchOver");
    assert.deepEqual(state.tokens, { A: 22, B: 18 });
  });
});

describe("hidden trump in summaries (design §10.3, §11.2)", () => {
  it("erases an unrevealed 28 trump's suit and card before emitting or storing", () => {
    const state = playing28Hidden();
    const faceDown = matchOf(state).faceDown;
    assert.deepEqual(faceDown, { owner: 1, card: c("HJ") });

    const { state: after, events } = run(state, [award("A")]);
    const [ended] = events;
    assert.ok(ended?.type === "matchEnded");
    assert.deepEqual(ended.summary.contract?.trump, { type: "hidden" });
    assert.ok(!JSON.stringify(events).includes("hearts"));
    assert.ok(!JSON.stringify(after).includes("hearts"));
    // Loss stake 2 at ×4 for the bidding team, from 10 tokens.
    assert.deepEqual(ended.summary.tokensMoved, { payer: "B", amount: 8 });
  });

  it("records a trump revealed during play as its suit", () => {
    const state = playing28Hidden();
    const match = matchOf(state);
    const revealed = withMatch(state, {
      ...match,
      hands: match.hands.map((hand, index) =>
        index === 1 ? [...hand, c("HJ")] : hand,
      ),
      faceDown: null,
      revealedInRound: 0,
      currentRound: match.currentRound && {
        ...match.currentRound,
        revealedThisRound: true,
      },
    });
    assertEngineInvariants(revealed);

    const [ended] = scoreMatch(revealed, { type: "awarded", team: "B" });
    assert.ok(ended?.type === "matchEnded");
    assert.deepEqual(ended.summary.contract?.trump, {
      type: "suit",
      suit: "hearts",
    });
  });
});

describe("session transitions (design §10.4)", () => {
  it("startNextMatch rotates the deal to the dealer's right for 4, 6, and 8 players", () => {
    for (const playerCount of [4, 6, 8] as const) {
      const config = config56({ playerCount });
      for (const dealer of [1, playerCount - 1]) {
        const first = (dealer + 1) % playerCount;
        const passes = Array.from({ length: playerCount - 1 }, (_, offset) =>
          pass((first + 1 + offset) % playerCount),
        );
        const scored = run(
          playing56([bid56(first, 30), ...passes], config, dealer),
          [award(teamOf(first))],
        ).state;
        assert.equal(scored.phase.type, "matchOver");

        const next = (dealer + 1) % playerCount;
        const { state, events } = run(scored, [startNextMatch]);
        assert.deepEqual(events, [{ type: "nextMatchStarted", dealer: next }]);
        assert.deepEqual(state, {
          ...scored,
          dealer: next,
          phase: { type: "awaitingDeal", reason: "nextMatch" },
        });

        const dealt = run(state, [deal(buildDeck(config))]);
        assert.deepEqual(dealt.events[1], {
          type: "auctionStarted",
          stage: "56",
          firstTurn: (next + 1) % playerCount,
          minBid: 28,
        });
      }
    }
  });

  it("startNextMatch and restartSession are rejected outside their phase", () => {
    const fresh = newState(config56());
    const play = playing56(calls56(1));
    const matchOver = run(play, [award("A")]).state;
    const sessionOver = run(withTokens(play, { A: 38, B: 2 }), [
      award("A"),
    ]).state;

    for (const state of [fresh, play, sessionOver]) {
      assert.deepEqual(rejection(state, startNextMatch), {
        code: "actionNotAllowed",
        details: { action: "startNextMatch", phase: state.phase.type },
      });
      assert.deepEqual(decideSessionAction(state, startNextMatch), {
        ok: false,
        code: "actionNotAllowed",
        details: { action: "startNextMatch", phase: state.phase.type },
      });
    }
    for (const state of [fresh, play, matchOver]) {
      assert.deepEqual(rejection(state, restartSession(0)), {
        code: "actionNotAllowed",
        details: { action: "restartSession", phase: state.phase.type },
      });
      assert.deepEqual(decideSessionAction(state, restartSession(0)), {
        ok: false,
        code: "actionNotAllowed",
        details: { action: "restartSession", phase: state.phase.type },
      });
    }
    assert.deepEqual(decideSessionAction(sessionOver, pass(0)), {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass" },
    });
  });

  it("restartSession archives the winner and final tokens, resets balances and log, and validates the dealer", () => {
    const config = config56({ playerCount: 6 });
    const play = playing56(
      [bid56(1, 30), pass(2), pass(3), pass(4), pass(5), pass(0)],
      config,
    );
    const sessionOver = run(withTokens(play, { A: 1, B: 39 }), [
      award("B"),
    ]).state;
    assert.equal(sessionOver.phase.type, "sessionOver");
    assert.equal(sessionOver.matchLog.length, 1);

    for (const bad of [-1, 6, 1.5, Number.NaN, "2" as unknown]) {
      assert.deepEqual(rejection(sessionOver, restartSession(bad as number)), {
        code: "invalidSeat",
        details: { field: "firstDealer", minimum: 0, maximum: 5 },
      });
    }

    const { state, events } = run(sessionOver, [restartSession(4)]);
    assert.deepEqual(events, [{ type: "sessionRestarted", firstDealer: 4 }]);
    assert.deepEqual(state, {
      config: sessionOver.config,
      tokens: { A: 20, B: 20 },
      dealer: 4,
      matchLog: [],
      pastSessions: [{ winner: "B", tokens: { A: 0, B: 40 } }],
      phase: { type: "awaitingDeal", reason: "firstDeal" },
    });

    // A second finished session appends to the archive.
    const secondPlay = playing56(
      [bid56(5, 30), pass(0), pass(1), pass(2), pass(3), pass(4)],
      config,
      4,
    );
    const secondOver = run(
      withTokens(
        { ...secondPlay, pastSessions: state.pastSessions },
        { A: 39, B: 1 },
      ),
      [award("A")],
    ).state;
    const restarted = run(secondOver, [restartSession(0)]).state;
    assert.deepEqual(restarted.pastSessions, [
      { winner: "B", tokens: { A: 0, B: 40 } },
      { winner: "A", tokens: { A: 40, B: 0 } },
    ]);
  });

  it("evolvers throw instead of silently rewriting state on a phase mismatch (design §13.1)", () => {
    const config = config56();
    const state = newState(config, 0);
    assert.equal(state.phase.type, "awaitingDeal");

    const events: EngineEvent[] = [
      { type: "sessionEnded", winner: "A" },
      { type: "nextMatchStarted", dealer: 1 },
      { type: "sessionRestarted", firstDealer: 1 },
    ];

    for (const event of events) {
      assert.throws(() => evolve(state, event));
    }
  });
});

describe("E006 invariants", () => {
  function invariantCode(state: EngineState): string | null {
    try {
      assertEngineInvariants(state);
      return null;
    } catch (error) {
      assert.ok(error instanceof EngineInvariantError);
      return error.code;
    }
  }

  it("ties token balances, finished-match summaries, and the archive together", () => {
    const over = run(playing56(calls56(1)), [award("A")]).state;
    assert.equal(invariantCode(over), null);
    if (over.phase.type !== "matchOver") {
      throw new Error("unreachable");
    }
    const { summary } = over.phase;

    assert.equal(
      invariantCode({ ...over, tokens: { A: 22, B: 19 } }),
      "invalidTokens",
    );
    assert.equal(invariantCode({ ...over, matchLog: [] }), "invalidSummary");
    assert.equal(
      invariantCode({
        ...over,
        matchLog: [{ ...summary, tokensMoved: null }],
        phase: {
          type: "matchOver",
          summary: { ...summary, tokensMoved: null },
        },
      }),
      "invalidSummary",
    );
    const restartedSummary: MatchSummary = {
      ...summary,
      outcome: { type: "restarted" },
    };
    assert.equal(
      invariantCode({
        ...over,
        matchLog: [restartedSummary],
        phase: { type: "matchOver", summary: restartedSummary },
      }),
      "invalidSummary",
    );
    assert.equal(
      invariantCode({
        ...over,
        phase: { type: "awaitingDeal", reason: "firstDeal" },
      }),
      "invalidSummary",
    );

    const fresh = newState(config56());
    assert.equal(
      invariantCode({ ...fresh, tokens: { A: 20, B: 0 } }),
      "invalidTokens",
    );
    assert.equal(
      invariantCode({
        ...fresh,
        pastSessions: [{ winner: "A", tokens: { A: 39, B: 1 } }],
      }),
      "invalidTokens",
    );
  });
});

describe("E006 replay and immutability", () => {
  it("replaying every event from newSession reproduces each final state, with frozen inputs", () => {
    const scenarios: {
      config: EngineConfig;
      dealer: number;
      actions: EngineAction[];
    }[] = [
      {
        // 56: restart, then scored matches until team B runs out, then a new session.
        config: config56({ startingTokens: 3 }),
        dealer: 3,
        actions: [
          deal(buildDeck(config56())),
          bid56(0, 30),
          restart,
          deal(buildDeck(config56())),
          bid56(0, 30),
          pass(1),
          pass(2),
          pass(3),
          award("A"), // B pays win 1 → A 4, B 2
          startNextMatch, // dealer 0
          deal(buildDeck(config56())),
          bid56(1, 30),
          pass(2),
          pass(3),
          pass(0),
          award("A"), // B pays loss 2 → A 6, B 0
          restartSession(2),
          deal(buildDeck(config56())),
        ],
      },
      {
        // 28: restart in the second auction, then an awarded hidden-trump match.
        config: config28(),
        dealer: 0,
        actions: [
          deal(deckFor(0, FIRST_28, SECOND_28)),
          bid28(1, 16),
          pass(2),
          pass(3),
          pass(0),
          place(1, c("HJ")),
          pass(1),
          double(2),
          restart,
          deal(deckFor(0, FIRST_28, SECOND_28)),
          bid28(1, 18),
          double(2),
          redouble(3),
          place(1, c("HJ")),
          award("B"), // A pays win 1 × 4 → A 6, B 14
          startNextMatch,
          deal(deckFor(1, FIRST_28, SECOND_28)),
        ],
      },
    ];

    for (const { config, dealer, actions } of scenarios) {
      const started = newSession(deepFreeze(config), dealer);
      assert.equal(started.ok, true);
      if (!started.ok) {
        throw new Error("unreachable");
      }
      const initial = deepFreeze(started.state);
      let state = initial;
      const log: EngineEvent[] = [];
      for (const action of actions) {
        const before = JSON.stringify(state);
        const frozen = deepFreeze(structuredClone(action));
        const result = act(state, frozen);
        assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result));
        if (!result.ok) {
          throw new Error("unreachable");
        }
        assert.deepEqual(act(state, frozen), result);
        assert.equal(JSON.stringify(state), before);
        assertEngineInvariants(result.state);
        log.push(...deepFreeze(result.events));
        state = deepFreeze(result.state);
      }

      const replayed = log.reduce(
        (current, event) => evolve(current, event),
        initial,
      );
      assert.equal(JSON.stringify(replayed), JSON.stringify(state));
      const fromJson = (
        JSON.parse(JSON.stringify(log)) as EngineEvent[]
      ).reduce(
        (current, event) => evolve(current, event),
        JSON.parse(JSON.stringify(initial)) as EngineState,
      );
      assert.equal(JSON.stringify(fromJson), JSON.stringify(state));
      assert.equal(state.phase.type, "auction");
    }
  });
});
