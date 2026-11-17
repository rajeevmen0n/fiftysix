import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent, EventOfType } from "./events.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import { legalCards } from "./play.js";
import type { EngineState, MatchState, SurrenderState } from "./state.js";
import {
  decideSurrenderAction,
  evolveResultDecided,
  evolveSurrendered,
  evolveSurrenderFailed,
  evolveSurrenderProposed,
  evolveSurrenderVoted,
  losingTeamIfCertain,
  surrenderVoteStatus,
  totalPoints,
} from "./surrender.js";
import { deepFreeze } from "./test-helpers.js";
import type { Card, EngineConfig, Rank, Suit, Team } from "./types.js";

// E008: result certainty and the surrender vote (design §10.1, design.md §5).

function config56(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const playerCount = overrides.playerCount ?? 4;
  return {
    gameType: "56",
    playerCount,
    // 8 players get the 64-card deck (8 rounds); 4 and 6 play 48 cards.
    includeEightsAndSevens: playerCount === 8,
    illegalPlayMode: "block",
    startingTokens: 20,
    stakeTiers: [
      { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
      { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
      { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
    ],
    redealThreshold: 0,
    surrenderOption: "on",
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
    surrenderOption: "on",
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

/** A single-stage deck dealing `hands[seat]` to each seat, dealer 0. */
function deckFor(hands: Card[][]): Card[] {
  const playerCount = hands.length;
  const deck: Card[] = [];
  hands.forEach((held, seat) => {
    const offset = (seat - 1 + playerCount) % playerCount;
    held.forEach((card, index) => {
      deck[index * playerCount + offset] = card;
    });
  });
  return deck;
}

// 28, dealer 0 (the E007 play deal). Seat 1 bids, places the jack of hearts,
// and with first-legal play team A collects 16 of the first 19 points, so a
// bid of 16 is certainly lost after the fifth round, before the reveal.
const DEAL_28 = [
  ...deckFor([
    cards("SJ S9 S8 S7"),
    cards("HJ SA S10 SK"),
    cards("H9 HA H10 HK"),
    cards("HQ H8 H7 D9"),
  ]),
  ...deckFor([
    cards("DJ DK DA D10"),
    cards("SQ D7 C7 C8"),
    cards("CJ C9 CA C10"),
    cards("DQ D8 CK CQ"),
  ]),
];

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;
const host = { type: "host" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const bidNoTrump = (seatNumber: number, amount: number): EngineAction => ({
  type: "bid",
  amount,
  suit: "noTrump",
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
const play = (seatNumber: number, card: Card): EngineAction => ({
  type: "playCard",
  card,
  source: seat(seatNumber),
});
const ask = (seatNumber: number): EngineAction => ({
  type: "askReveal",
  source: seat(seatNumber),
});
const propose = (seatNumber: number): EngineAction => ({
  type: "proposeSurrender",
  source: seat(seatNumber),
});
const vote = (seatNumber: number, choice: "yes" | "no"): EngineAction => ({
  type: "voteSurrender",
  vote: choice,
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

interface Flow {
  state: EngineState;
  /** Events of the last accepted action. */
  events: EngineEvent[];
  /** Every event since `newSession`, in order. */
  log: EngineEvent[];
  initial: EngineState;
}

function start(config: EngineConfig): Flow {
  const started = newSession(config, 0);
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error("unreachable");
  }
  return {
    state: started.state,
    events: started.events,
    log: [...started.events],
    initial: started.state,
  };
}

/** Applies each action via `act`, asserting acceptance, replay, and invariants. */
function run(flow: Flow, actions: EngineAction[]): Flow {
  let { state, events } = flow;
  const log = [...flow.log];
  for (const action of actions) {
    const result = act(state, action);
    assert.equal(
      result.ok,
      true,
      `expected ${action.type} to be accepted: ${JSON.stringify(result.ok ? {} : result)}`,
    );
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const replayed = result.events.reduce(
      (current, event) => evolve(current, event),
      state,
    );
    assert.equal(JSON.stringify(replayed), JSON.stringify(result.state));
    assertEngineInvariants(result.state);
    state = result.state;
    events = result.events;
    log.push(...events);
  }
  return { state, events, log, initial: flow.initial };
}

function rejection(state: EngineState, action: EngineAction) {
  const before = JSON.stringify(state);
  const decision = decide(state, action);
  assert.equal(decision.ok, false, `expected ${action.type} to be rejected`);
  assert.deepEqual(act(state, action), decision);
  assert.equal(JSON.stringify(state), before);
  return decision.ok
    ? null
    : { code: decision.code, details: decision.details };
}

function notAllowed(action: EngineAction["type"], reason: string) {
  return { code: "actionNotAllowed", details: { action, reason } };
}

function matchOf(state: EngineState): MatchState {
  if (!("match" in state.phase)) {
    throw new Error("expected a match in progress");
  }
  return state.phase.match;
}

function surrenderOf(state: EngineState): SurrenderState {
  return matchOf(state).surrender;
}

function withSurrender(
  state: EngineState,
  surrender: SurrenderState,
): EngineState {
  const { phase } = state;
  if (!("match" in phase)) {
    throw new Error("expected a match in progress");
  }
  return {
    ...state,
    phase: { type: phase.type, match: { ...phase.match, surrender } },
  };
}

const types = (events: readonly EngineEvent[]) =>
  events.map((event) => event.type);

function only<T extends EngineEvent["type"]>(
  events: readonly EngineEvent[],
  type: T,
): EventOfType<T> {
  const found = events.filter(
    (event): event is EventOfType<T> => event.type === type,
  );
  assert.equal(found.length, 1, `expected one ${type} event`);
  return found[0] as EventOfType<T>;
}

/**
 * 56, dealt by seat 0 from the natural deck order, so seat 1 holds every
 * first-copy jack. With no trump and first-legal play, seat 1 leads and team
 * B wins every round. `bidder` 1 (team B) or 2 (team A) wins the auction at
 * `amount` no trump; the play is the same either way.
 */
function playing56(
  bidder: 1 | 2,
  amount: number,
  config: EngineConfig = config56(),
  calls?: EngineAction[],
): Flow {
  const { playerCount } = config;
  const passesAfter = (from: number) =>
    Array.from({ length: playerCount - 1 }, (_, index) =>
      pass((from + 1 + index) % playerCount),
    );
  const auction =
    calls ??
    (bidder === 1
      ? [bidNoTrump(1, amount), ...passesAfter(1)]
      : [pass(1), bidNoTrump(2, amount), ...passesAfter(2)]);
  const flow = run(start(config), [deal(buildDeck(config)), ...auction]);
  assert.equal(flow.state.phase.type, "play");
  return flow;
}

/** 28: seat 1 bids `amount`, places the jack of hearts, and everyone passes. */
function playing28(config: EngineConfig = config28(), amount = 16): Flow {
  const flow = run(start(config), [
    deal(DEAL_28),
    bid28(1, amount),
    pass(2),
    pass(3),
    pass(0),
    place(1, c("HJ")),
    pass(1),
    pass(2),
    pass(3),
    pass(0),
  ]);
  assert.equal(flow.state.phase.type, "play");
  return flow;
}

function turnOf(state: EngineState): number {
  const round = matchOf(state).currentRound;
  assert.ok(round !== null);
  return round.turn;
}

/** Plays the first legal card for whoever's turn it is, `count` times. */
function playCards(flow: Flow, count: number): Flow {
  let current = flow;
  for (let played = 0; played < count; played += 1) {
    const turn = turnOf(current.state);
    const [card] = legalCards(current.state, turn);
    assert.ok(card !== undefined);
    current = run(current, [play(turn, card)]);
  }
  return current;
}

function playRounds(flow: Flow, rounds: number): Flow {
  return playCards(flow, rounds * flow.state.config.playerCount);
}

function playToEnd(flow: Flow): Flow {
  let current = flow;
  while (current.state.phase.type === "play") {
    current = playCards(current, 1);
  }
  return current;
}

/** Plays rounds until the certainty check fires; returns that flow. */
function playUntilDecided(flow: Flow): Flow {
  let current = flow;
  while (!current.events.some((event) => event.type === "resultDecided")) {
    assert.equal(current.state.phase.type, "play");
    current = playCards(current, 1);
  }
  return current;
}

/**
 * An independent oracle over a whole event log (design §10.1): replays the
 * round points and requires `resultDecided(losingTeam)` directly after the
 * first `roundWon` that makes the result certain, and nowhere else. Returns
 * the zero-based round of the decision, or null.
 */
function certaintyRound(
  log: readonly EngineEvent[],
  biddingTeam: Team,
  amount: number,
  total: number,
): number | null {
  const defenders: Team = biddingTeam === "A" ? "B" : "A";
  const points = { A: 0, B: 0 };
  let rounds = 0;
  let decidedIn: number | null = null;
  log.forEach((event, index) => {
    const next = log[index + 1];
    if (event.type === "roundWon") {
      points[event.team] += event.points;
      rounds += 1;
      const uncollected = total - points.A - points.B;
      const losing =
        points[biddingTeam] >= amount
          ? defenders
          : points[biddingTeam] + uncollected < amount
            ? biddingTeam
            : null;
      if (decidedIn === null && losing !== null) {
        assert.deepEqual(next, { type: "resultDecided", losingTeam: losing });
        decidedIn = rounds - 1;
        return;
      }
    }
    if (next?.type === "resultDecided") {
      assert.fail(`unexpected resultDecided after ${event.type}`);
    }
  });
  if (log[0]?.type === "resultDecided") {
    assert.fail("unexpected leading resultDecided");
  }
  return decidedIn;
}

function invariantCode(state: EngineState): string | null {
  try {
    assertEngineInvariants(state);
    return null;
  } catch (error) {
    assert.ok(error instanceof EngineInvariantError);
    return error.code;
  }
}

// ---------------------------------------------------------------------------

describe("result certainty (design §10.1)", () => {
  it("the defenders lose once the bidding team has made its bid", () => {
    // Seat 1 (team B) bids 28; B collects 10, 4, 0, 10, 4.
    let flow = playing56(1, 28);
    for (let round = 0; round < 4; round += 1) {
      flow = playRounds(flow, 1);
      assert.equal(surrenderOf(flow.state).decided, null);
      assert.equal(losingTeamIfCertain(flow.state), null);
    }
    flow = playRounds(flow, 1);
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "roundWon",
      "resultDecided",
    ]);
    assert.deepEqual(flow.events[2], {
      type: "resultDecided",
      losingTeam: "A",
    });
    assert.deepEqual(matchOf(flow.state).points, { A: 0, B: 28 });
    assert.equal(surrenderOf(flow.state).decided, "A");

    // It stays set, and is never announced again.
    flow = playToEnd(flow);
    assert.equal(
      flow.log.filter((event) => event.type === "resultDecided").length,
      1,
    );
    assert.equal(certaintyRound(flow.log, "B", 28, 56), 4);
  });

  it("the bidding team loses once its bid is out of reach", () => {
    // Seat 2 (team A) bids 28 and takes nothing: B passes 28 points, the
    // most A could still have, in the seventh round.
    let flow = playing56(2, 28);
    flow = playRounds(flow, 6);
    assert.equal(surrenderOf(flow.state).decided, null);
    assert.deepEqual(matchOf(flow.state).points, { A: 0, B: 28 });
    flow = playRounds(flow, 1);
    assert.deepEqual(flow.events.at(-1), {
      type: "resultDecided",
      losingTeam: "A",
    });
    assert.equal(surrenderOf(flow.state).decided, "A");
    assert.equal(losingTeamIfCertain(flow.state), "A");
    assert.equal(certaintyRound(playToEnd(flow).log, "A", 28, 56), 6);
  });

  it("runs after the last round too, before the match is scored", () => {
    // 6 players, seat 1 bids 56: B reaches all 56 only in the last round.
    const flow = playToEnd(playing56(1, 56, config56({ playerCount: 6 })));
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "roundWon",
      "resultDecided",
      "matchEnded",
    ]);
    assert.deepEqual(flow.events[2], {
      type: "resultDecided",
      losingTeam: "A",
    });
    assert.deepEqual(only(flow.events, "matchEnded").summary.outcome, {
      type: "made",
    });
    assert.equal(flow.state.phase.type, "matchOver");
  });

  it("is checked after every round for every team size and both directions", () => {
    const cases = [
      { playerCount: 4, bidder: 1, round: 4 },
      { playerCount: 4, bidder: 2, round: 6 },
      { playerCount: 6, bidder: 1, round: 3 },
      { playerCount: 6, bidder: 2, round: 4 },
      { playerCount: 8, bidder: 1, round: 2 },
      { playerCount: 8, bidder: 2, round: 4 },
    ] as const;
    for (const { playerCount, bidder, round } of cases) {
      const config = config56({ playerCount });
      const flow = playToEnd(playing56(bidder, 28, config));
      const biddingTeam: Team = bidder === 1 ? "B" : "A";
      assert.equal(
        certaintyRound(flow.log, biddingTeam, 28, totalPoints(config)),
        round,
        `${playerCount} players, bidder ${bidder}`,
      );
    }
  });

  it("works on 28's point total with a hidden trump", () => {
    const config = config28();
    assert.equal(totalPoints(config), 28);
    let flow = playUntilDecided(playing28(config));
    assert.deepEqual(flow.events.at(-1), {
      type: "resultDecided",
      losingTeam: "B",
    });
    // Team A has 16 and B 3: B can reach at most 3 + 9 = 12.
    assert.deepEqual(matchOf(flow.state).points, { A: 16, B: 3 });
    assert.equal(matchOf(flow.state).revealedInRound, null);
    flow = playToEnd(flow);
    assert.equal(certaintyRound(flow.log, "B", 16, 28), 4);
  });

  it("is never recorded or announced when the option is off", () => {
    const config = config56({ surrenderOption: "off" });
    let flow = playRounds(playing56(1, 28, config), 5);
    assert.deepEqual(matchOf(flow.state).points, { A: 0, B: 28 });
    // The arithmetic still holds; the option only gates recording it.
    assert.equal(losingTeamIfCertain(flow.state), "A");
    assert.equal(surrenderOf(flow.state).decided, null);
    flow = playToEnd(flow);
    assert.ok(!flow.log.some((event) => event.type === "resultDecided"));
  });

  it("is null outside play", () => {
    const flow = start(config56());
    assert.equal(losingTeamIfCertain(flow.state), null);
    const auction = run(flow, [deal(buildDeck(config56()))]).state;
    assert.equal(losingTeamIfCertain(auction), null);
  });
});

describe("surrender proposal and vote (design §10.1, design.md §5)", () => {
  /** 4 players: seat 1 bids 28; after round 5 team A has certainly lost. */
  function decided4(config = config56()): Flow {
    const flow = playRounds(playing56(1, 28, config), 5);
    assert.equal(surrenderOf(flow.state).decided, "A");
    assert.equal(turnOf(flow.state), 1);
    return flow;
  }

  it("a losing-team seat proposes off its turn, counting as yes, and play pauses", () => {
    const flow = run(decided4(), [propose(2)]);
    assert.deepEqual(flow.events, [{ type: "surrenderProposed", seat: 2 }]);
    assert.deepEqual(surrenderOf(flow.state), {
      decided: "A",
      vote: { proposer: 2, yes: [2], no: [] },
      lastFailedRound: null,
    });

    // design §5: the vote pauses the game for everyone.
    const turn = turnOf(flow.state);
    assert.deepEqual(legalCards(flow.state, turn), []);
    const [card] = matchOf(flow.state).hands[turn] ?? [];
    assert.ok(card !== undefined);
    assert.deepEqual(rejection(flow.state, play(turn, card)), {
      code: "surrenderVoteRunning",
      details: {},
    });
    assert.deepEqual(rejection(flow.state, ask(turn)), {
      code: "surrenderVoteRunning",
      details: {},
    });
    assert.deepEqual(rejection(flow.state, propose(0)), {
      code: "surrenderVoteRunning",
      details: {},
    });
  });

  it("4 players: passes 2 of 2 and scores the defenders' surrender at the win stake", () => {
    const flow = run(decided4(), [propose(0), vote(2, "yes")]);
    assert.deepEqual(types(flow.events), [
      "surrenderVoted",
      "surrendered",
      "matchEnded",
    ]);
    assert.deepEqual(flow.events.slice(0, 2), [
      { type: "surrenderVoted", seat: 2, vote: "yes" },
      { type: "surrendered", team: "A" },
    ]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.outcome, { type: "surrendered", team: "A" });
    assert.deepEqual(summary.points, { A: 0, B: 28 });
    assert.deepEqual(summary.tokensMoved, { payer: "A", amount: 1 });
    assert.deepEqual(flow.state.tokens, { A: 19, B: 21 });
    assert.equal(flow.state.phase.type, "matchOver");
  });

  it("scores the losing side's stake with the contract's multiplier", () => {
    // Team A loses every case: as the bidder (loss stake 2) or as the
    // defenders (win stake 1).
    const cases = [
      {
        name: "bidding team, ×1",
        calls: [pass(1), bidNoTrump(2, 28), pass(3), pass(0), pass(1)],
        amount: 2,
      },
      {
        name: "bidding team, doubled",
        calls: [
          pass(1),
          bidNoTrump(2, 28),
          double(3),
          pass(0),
          pass(1),
          pass(2),
        ],
        amount: 4,
      },
      {
        name: "defenders, ×1",
        calls: [bidNoTrump(1, 28), pass(2), pass(3), pass(0)],
        amount: 1,
      },
      {
        name: "defenders, redoubled",
        calls: [bidNoTrump(1, 28), double(2), redouble(3)],
        amount: 4,
      },
    ];
    for (const { name, calls, amount } of cases) {
      let flow = playUntilDecided(playing56(1, 28, config56(), calls));
      assert.equal(surrenderOf(flow.state).decided, "A", name);
      flow = run(flow, [propose(0), vote(2, "yes")]);
      const { summary } = only(flow.events, "matchEnded");
      assert.deepEqual(summary.outcome, { type: "surrendered", team: "A" });
      assert.deepEqual(summary.tokensMoved, { payer: "A", amount }, name);
    }
  });

  it("fails on a no that makes passing impossible; play resumes until the next round", () => {
    let flow = run(decided4(), [propose(0), vote(2, "no")]);
    assert.deepEqual(flow.events, [
      { type: "surrenderVoted", seat: 2, vote: "no" },
      { type: "surrenderFailed" },
    ]);
    // The current round is the sixth (index 5).
    assert.equal(matchOf(flow.state).rounds.length, 5);
    assert.deepEqual(surrenderOf(flow.state), {
      decided: "A",
      vote: null,
      lastFailedRound: 5,
    });

    // Same-round lockout, for every member of the losing team.
    for (const member of [0, 2]) {
      assert.deepEqual(
        rejection(flow.state, propose(member)),
        notAllowed("proposeSurrender", "failedThisRound"),
      );
    }
    // Play resumes; still locked part-way through the round.
    flow = playCards(flow, 2);
    assert.deepEqual(
      rejection(flow.state, propose(2)),
      notAllowed("proposeSurrender", "failedThisRound"),
    );
    // The next round lifts the lockout.
    flow = playCards(flow, 2);
    assert.equal(matchOf(flow.state).rounds.length, 6);
    flow = run(flow, [propose(2)]);
    assert.deepEqual(surrenderOf(flow.state), {
      decided: "A",
      vote: { proposer: 2, yes: [2], no: [] },
      lastFailedRound: 5,
    });
    // A second failed vote records the new round.
    flow = run(flow, [vote(0, "no")]);
    assert.equal(surrenderOf(flow.state).lastFailedRound, 6);
  });

  it("6 players: passes at 2 of 3 and fails at 2 no votes", () => {
    const config = config56({ playerCount: 6 });
    const decided = playUntilDecided(playing56(1, 28, config));
    assert.equal(surrenderOf(decided.state).decided, "A");
    assert.equal(matchOf(decided.state).rounds.length, 4);

    // Yes from the second voter passes without waiting for the third.
    let flow = run(decided, [propose(4), vote(0, "yes")]);
    assert.deepEqual(types(flow.events), [
      "surrenderVoted",
      "surrendered",
      "matchEnded",
    ]);

    // One no leaves the vote open (1 yes + 1 outstanding can still reach 2).
    flow = run(decided, [propose(4), vote(0, "no")]);
    assert.deepEqual(flow.events, [
      { type: "surrenderVoted", seat: 0, vote: "no" },
    ]);
    assert.deepEqual(surrenderOf(flow.state).vote, {
      proposer: 4,
      yes: [4],
      no: [0],
    });
    assert.deepEqual(
      rejection(flow.state, vote(0, "yes")),
      notAllowed("voteSurrender", "alreadyVoted"),
    );
    const passed = run(flow, [vote(2, "yes")]);
    assert.deepEqual(only(passed.events, "matchEnded").summary.outcome, {
      type: "surrendered",
      team: "A",
    });
    const failed = run(flow, [vote(2, "no")]);
    assert.deepEqual(failed.events, [
      { type: "surrenderVoted", seat: 2, vote: "no" },
      { type: "surrenderFailed" },
    ]);
    assert.equal(failed.state.phase.type, "play");
  });

  it("8 players: passes at 3 of 4 and fails as soon as 2 vote no", () => {
    const config = config56({ playerCount: 8 });
    const decided = playUntilDecided(playing56(1, 28, config));
    assert.equal(surrenderOf(decided.state).decided, "A");

    // 3 of 4 passes before the last member votes.
    let flow = run(decided, [propose(6), vote(0, "yes")]);
    assert.deepEqual(types(flow.events), ["surrenderVoted"]);
    flow = run(flow, [vote(2, "yes")]);
    assert.deepEqual(types(flow.events), [
      "surrenderVoted",
      "surrendered",
      "matchEnded",
    ]);

    // 2 yes, 1 no: still open; the last vote decides it.
    flow = run(decided, [propose(6), vote(0, "yes"), vote(2, "no")]);
    assert.deepEqual(types(flow.events), ["surrenderVoted"]);
    assert.deepEqual(types(run(flow, [vote(4, "yes")]).events), [
      "surrenderVoted",
      "surrendered",
      "matchEnded",
    ]);
    assert.deepEqual(types(run(flow, [vote(4, "no")]).events), [
      "surrenderVoted",
      "surrenderFailed",
    ]);

    // 1 yes, 2 no: 1 yes + 1 outstanding can't reach 3, so it fails at once.
    flow = run(decided, [propose(6), vote(0, "no")]);
    assert.deepEqual(types(flow.events), ["surrenderVoted"]);
    flow = run(flow, [vote(2, "no")]);
    assert.deepEqual(types(flow.events), ["surrenderVoted", "surrenderFailed"]);
  });

  it("the vote thresholds are more than half of the team", () => {
    const status = (playerCount: number, yes: number[], no: number[]) =>
      surrenderVoteStatus({ proposer: yes[0] ?? 0, yes, no }, playerCount);
    assert.equal(status(4, [0], []), "open");
    assert.equal(status(4, [0, 2], []), "passed");
    assert.equal(status(4, [0], [2]), "failed");
    assert.equal(status(6, [0], [2]), "open");
    assert.equal(status(6, [0, 4], [2]), "passed");
    assert.equal(status(6, [0], [2, 4]), "failed");
    assert.equal(status(8, [0, 2], [4]), "open");
    assert.equal(status(8, [0, 2, 4], []), "passed");
    assert.equal(status(8, [0], [2, 4]), "failed");
  });

  it("a passing surrender can end the session", () => {
    // Team A has 2 tokens, bids 28 (loss stake 2), and surrenders.
    const config = config56({ startingTokens: 2 });
    let flow = playUntilDecided(playing56(2, 28, config));
    flow = run(flow, [propose(2), vote(0, "yes")]);
    assert.deepEqual(types(flow.events), [
      "surrenderVoted",
      "surrendered",
      "matchEnded",
      "sessionEnded",
    ]);
    assert.deepEqual(flow.events.at(-1), { type: "sessionEnded", winner: "B" });
    assert.equal(flow.state.phase.type, "sessionOver");
    assert.deepEqual(flow.state.tokens, { A: 0, B: 4 });
  });

  it("28: the surrender summary keeps an unrevealed trump hidden", () => {
    let flow = playUntilDecided(playing28());
    flow = run(flow, [propose(3), vote(1, "yes")]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.outcome, { type: "surrendered", team: "B" });
    assert.deepEqual(summary.contract?.trump, { type: "hidden" });
    // Bid 16: the bidding team pays its loss stake of 2.
    assert.deepEqual(summary.tokensMoved, { payer: "B", amount: 2 });
    assert.ok(!JSON.stringify(summary).includes("hearts"));
    assert.ok(!JSON.stringify(flow.state).includes("hearts"));
  });
});

describe("surrender: rejections", () => {
  it("rejects proposals before certainty, and from the winning team without revealing it", () => {
    const early = playRounds(playing56(1, 28), 1);
    const before = rejection(early.state, propose(0));
    assert.deepEqual(
      before,
      notAllowed("proposeSurrender", "resultNotDecided"),
    );
    assert.deepEqual(rejection(early.state, propose(1)), before);

    const decided = playRounds(early, 4);
    assert.equal(surrenderOf(decided.state).decided, "A");
    // The winning team gets exactly the rejection it got before certainty.
    for (const winner of [1, 3]) {
      assert.deepEqual(rejection(decided.state, propose(winner)), before);
    }
    assert.deepEqual(
      rejection(decided.state, vote(0, "yes")),
      notAllowed("voteSurrender", "noVoteRunning"),
    );
  });

  it("rejects opponents, the proposer, repeated votes, and malformed votes", () => {
    const voting = run(playRounds(playing56(1, 28), 5), [propose(0)]);
    for (const opponent of [1, 3]) {
      assert.deepEqual(
        rejection(voting.state, vote(opponent, "yes")),
        notAllowed("voteSurrender", "notOnLosingTeam"),
      );
      // The running vote is public, so naming the losing team leaks nothing.
      assert.deepEqual(
        rejection(voting.state, propose(opponent)),
        notAllowed("proposeSurrender", "notOnLosingTeam"),
      );
    }
    assert.deepEqual(
      rejection(voting.state, vote(0, "no")),
      notAllowed("voteSurrender", "alreadyVoted"),
    );
    for (const bad of ["maybe", null, true]) {
      const action = {
        type: "voteSurrender",
        vote: bad,
        source: seat(2),
      } as unknown as EngineAction;
      assert.deepEqual(
        rejection(voting.state, action),
        notAllowed("voteSurrender", "invalidVote"),
      );
    }
  });

  it("rejects every surrender action when the option is off", () => {
    const flow = playRounds(
      playing56(1, 28, config56({ surrenderOption: "off" })),
      5,
    );
    assert.equal(losingTeamIfCertain(flow.state), "A");
    for (const member of [0, 2]) {
      assert.deepEqual(
        rejection(flow.state, propose(member)),
        notAllowed("proposeSurrender", "surrenderOff"),
      );
      assert.deepEqual(
        rejection(flow.state, vote(member, "yes")),
        notAllowed("voteSurrender", "surrenderOff"),
      );
    }
  });

  it("rejects surrender actions outside play, and other actions in direct calls", () => {
    const config = config56();
    const auction = run(start(config), [deal(buildDeck(config))]).state;
    const over = run(playRounds(playing56(1, 28), 5), [
      propose(0),
      vote(2, "yes"),
    ]).state;
    for (const state of [auction, over]) {
      for (const action of [propose(0), vote(2, "yes")]) {
        assert.deepEqual(rejection(state, action), {
          code: "actionNotAllowed",
          details: { action: action.type, phase: state.phase.type },
        });
        assert.deepEqual(decideSurrenderAction(state, action), {
          ok: false,
          code: "actionNotAllowed",
          details: { action: action.type, phase: state.phase.type },
        });
      }
    }
    assert.deepEqual(decideSurrenderAction(playing56(1, 28).state, pass(1)), {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass" },
    });
  });
});

describe("surrender: host End match during a vote (design §10.2)", () => {
  it("restart cancels the vote with the match", () => {
    const voting = run(playRounds(playing56(1, 28), 5), [propose(0)]);
    const flow = run(voting, [restart]);
    assert.deepEqual(types(flow.events), ["matchEnded"]);
    assert.deepEqual(only(flow.events, "matchEnded").summary.outcome, {
      type: "restarted",
    });
    assert.deepEqual(flow.state.phase, {
      type: "awaitingDeal",
      reason: "restart",
    });
    assert.deepEqual(flow.state.tokens, { A: 20, B: 20 });
  });

  it("award scores the named winner", () => {
    const voting = run(playRounds(playing56(1, 28), 5), [propose(0)]);
    const flow = run(voting, [award("A")]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.outcome, { type: "awarded", team: "A" });
    assert.deepEqual(summary.tokensMoved, { payer: "B", amount: 2 });
    assert.equal(flow.state.phase.type, "matchOver");
  });
});

describe("surrender: replay, immutability, evolvers, and invariants", () => {
  it("replays the whole session log to the same state", () => {
    let flow = playRounds(playing56(1, 28), 5);
    flow = run(flow, [propose(0), vote(2, "no")]);
    flow = playRounds(flow, 1);
    flow = run(flow, [propose(2), vote(0, "yes")]);
    const replayed = flow.log
      .slice(1)
      .reduce((state, event) => evolve(state, event), flow.initial);
    assert.equal(JSON.stringify(replayed), JSON.stringify(flow.state));
    assert.deepEqual(JSON.parse(JSON.stringify(flow.state)), flow.state);
  });

  it("decide never mutates its inputs", () => {
    const voting = run(playRounds(playing56(1, 28), 5), [propose(0)]);
    const state = deepFreeze(structuredClone(voting.state));
    const actions = [vote(2, "yes"), vote(2, "no"), propose(2), vote(1, "no")];
    for (const action of actions) {
      const frozen = deepFreeze(structuredClone(action));
      const first = act(state, frozen);
      assert.deepEqual(act(state, frozen), first);
    }
    assert.equal(JSON.stringify(state), JSON.stringify(voting.state));
  });

  it("evolvers throw on misordered events (design §13.1)", () => {
    const decidedFlow = playRounds(playing56(1, 28), 5);
    const decided = decidedFlow.state;
    const voting = run(decidedFlow, [propose(0)]).state;
    const auction = run(start(config56()), [deal(buildDeck(config56()))]).state;

    assert.throws(() =>
      evolveResultDecided(decided, { type: "resultDecided", losingTeam: "A" }),
    );
    assert.throws(() =>
      evolveResultDecided(auction, { type: "resultDecided", losingTeam: "A" }),
    );
    assert.throws(() =>
      evolveSurrenderProposed(voting, { type: "surrenderProposed", seat: 2 }),
    );
    assert.throws(() =>
      evolveSurrenderVoted(decided, {
        type: "surrenderVoted",
        seat: 2,
        vote: "yes",
      }),
    );
    assert.throws(() =>
      evolveSurrenderVoted(voting, {
        type: "surrenderVoted",
        seat: 0,
        vote: "yes",
      }),
    );
    assert.throws(() =>
      evolveSurrenderFailed(decided, { type: "surrenderFailed" }),
    );
    assert.throws(() =>
      evolveSurrendered(voting, { type: "surrendered", team: "B" }),
    );
    assert.throws(() =>
      evolveSurrendered(decided, { type: "surrendered", team: "A" }),
    );
  });

  it("invariants reject surrender state that can't be reached", () => {
    const decidedFlow = playRounds(playing56(1, 28), 5);
    const decided = decidedFlow.state;
    const voting = run(decidedFlow, [propose(0)]).state;
    const off = playRounds(
      playing56(1, 28, config56({ surrenderOption: "off" })),
      5,
    ).state;
    const auction = run(start(config56()), [deal(buildDeck(config56()))]).state;
    const open = { decided: "A", vote: null, lastFailedRound: null } as const;

    const cases: [EngineState, string][] = [
      [withSurrender(decided, { ...open, decided: "B" }), "invalidSurrender"],
      [withSurrender(decided, { ...open, decided: null }), "invalidSurrender"],
      [withSurrender(off, open), "invalidSurrender"],
      [
        withSurrender(auction, { ...open, decided: null, lastFailedRound: 0 }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, {
          ...open,
          vote: { proposer: 0, yes: [0, 1], no: [] },
        }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, {
          ...open,
          vote: { proposer: 0, yes: [2], no: [] },
        }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, {
          ...open,
          vote: { proposer: 0, yes: [0], no: [0] },
        }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, {
          ...open,
          vote: { proposer: 0, yes: [0, 2], no: [] },
        }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, { ...open, lastFailedRound: 6 }),
        "invalidSurrender",
      ],
      [
        withSurrender(decided, {
          ...open,
          vote: { proposer: 0, yes: [0], no: [9] },
        }),
        "seatOutOfRange",
      ],
    ];
    assert.equal(invariantCode(voting), null);
    assert.equal(
      invariantCode(withSurrender(decided, { ...open, lastFailedRound: 5 })),
      null,
    );
    for (const [state, code] of cases) {
      assert.equal(invariantCode(state), code);
    }
  });
});
