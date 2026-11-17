import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent, EventOfType } from "./events.js";
import { faceDownIsForced, revealBlocker } from "./hidden-trump.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import {
  countingTrumpSuit,
  decidePlayAction,
  evolveCardPlayed,
  evolveDisqualified,
  evolveRoundWon,
  legalCards,
  roundWinner,
} from "./play.js";
import type {
  Contract,
  CurrentRound,
  EngineState,
  MatchState,
} from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type { Card, EngineConfig, Rank, Suit, Team } from "./types.js";

// E007: card play, the hidden-trump reveal, and disqualification.

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

/** `c("HJ")` is the first jack of hearts; `c("HJ'")` the second copy (56). */
function c(code: string): Card {
  const suit = SUIT_CODES[code.slice(0, 1)];
  assert.ok(suit !== undefined);
  const second = code.endsWith("'");
  const rank = code.slice(1, second ? -1 : undefined) as Rank;
  return { suit, rank, copy: second ? 2 : 1 };
}

const cards = (codes: string): Card[] => codes.split(" ").map(c);

/** A single-stage deck dealing `hands[seat]` to each seat (design §7). */
function deckFor(dealer: number, hands: Card[][]): Card[] {
  const playerCount = hands.length;
  const deck: Card[] = [];
  hands.forEach((held, seat) => {
    const offset = (seat - dealer - 1 + 2 * playerCount) % playerCount;
    held.forEach((card, index) => {
      deck[index * playerCount + offset] = card;
    });
  });
  return deck;
}

/** A 28 deck dealing `first[seat]` and then `second[seat]` to each seat. */
function deck28(first: Card[][], second: Card[][]): Card[] {
  const deck = [...deckFor(0, first), ...deckFor(0, second)];
  assert.equal(deck.length, 32);
  return deck;
}

// 56, dealer 0, seat 1 bids and leads. Seat 0 holds the second copy of every
// spade; seat 2 holds no diamonds and seat 3 no hearts or spades.
const DEAL_56 = deckFor(0, [
  cards("SJ' S9' SA' S10' SK' SQ' H9' HA' H10' HK' HQ' CQ'"),
  cards("SJ S9 HJ HA H10 DJ D9 DA D10 DK DQ CK"),
  cards("HJ' H9 HK HQ SA S10 SK SQ CJ C9 CA C10"),
  cards("DJ' D9' DA' D10' DK' DQ' CQ CJ' C9' CA' C10' CK'"),
]);

// 56, dealer 0: seat 1, the first leader, holds nothing but spades.
const DEAL_56_ALL_SPADES = deckFor(0, [
  cards("HJ H9 HA H10 HK HQ HJ' H9' HA' H10' HK' HQ'"),
  cards("SJ S9 SA S10 SK SQ SJ' S9' SA' S10' SK' SQ'"),
  cards("DJ D9 DA D10 DK DQ DJ' D9' DA' D10' DK' DQ'"),
  cards("CJ C9 CA C10 CK CQ CJ' C9' CA' C10' CK' CQ'"),
]);

// 28, dealer 0. Seat 1 bids, places the jack of hearts face down, and holds
// no other heart. Seats 2 and 3 hold no spades; seat 0 holds no hearts or
// clubs.
const FIRST_28 = [
  cards("SJ S9 S8 S7"),
  cards("HJ SA S10 SK"),
  cards("H9 HA H10 HK"),
  cards("HQ H8 H7 D9"),
];
const SECOND_28 = [
  cards("DJ DK DA D10"),
  cards("SQ D7 C7 C8"),
  cards("CJ C9 CA C10"),
  cards("DQ D8 CK CQ"),
];
const DEAL_28 = deck28(FIRST_28, SECOND_28);

// Like DEAL_28, but seat 1 also holds the seven of hearts (swapped with
// seat 3's eight of clubs).
const DEAL_28_SPARE_TRUMP = deck28(
  [FIRST_28[0], FIRST_28[1], FIRST_28[2], cards("HQ H8 C8 D9")] as Card[][],
  [SECOND_28[0], cards("SQ D7 C7 H7"), SECOND_28[2], SECOND_28[3]] as Card[][],
);

// 28, dealer 0: seat 1 holds every club and places the ten of clubs; no one
// else can follow clubs.
const DEAL_28_ALL_CLUBS = deck28(
  [
    cards("SJ S9 SA S10"),
    cards("CJ C9 CA C10"),
    cards("HJ H9 HA H10"),
    cards("DJ D9 DA D10"),
  ],
  [
    cards("SK SQ S8 S7"),
    cards("CK CQ C8 C7"),
    cards("HK HQ H8 H7"),
    cards("DK DQ D8 D7"),
  ],
);

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const bid56 = (
  seatNumber: number,
  amount: number,
  suit: Suit | "noTrump" = "spades",
): EngineAction =>
  suit === "noTrump"
    ? { type: "bid", amount, suit, source: seat(seatNumber) }
    : {
        type: "bid",
        amount,
        suit,
        style: "numberFirst",
        source: seat(seatNumber),
      };
const bid28 = (seatNumber: number, amount: number): EngineAction => ({
  type: "bid",
  amount,
  source: seat(seatNumber),
});
const pass = (seatNumber: number): EngineAction => ({
  type: "pass",
  source: seat(seatNumber),
});
const place = (seatNumber: number, card: Card): EngineAction => ({
  type: "placeCard",
  card,
  source: seat(seatNumber),
});
const play = (seatNumber: number, code: string | Card): EngineAction => ({
  type: "playCard",
  card: typeof code === "string" ? c(code) : code,
  source: seat(seatNumber),
});
const ask = (seatNumber: number): EngineAction => ({
  type: "askReveal",
  source: seat(seatNumber),
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

function roundOf(state: EngineState): CurrentRound {
  const round = matchOf(state).currentRound;
  assert.ok(round !== null);
  return round;
}

function withMatch(state: EngineState, match: MatchState): EngineState {
  const { phase } = state;
  if (phase.type !== "play") {
    throw new Error("expected play");
  }
  return { ...state, phase: { type: "play", match } };
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

/** 56: seat 1 wins the auction at `amount` in `suit`; seat 1 leads. */
function playing56(
  config: EngineConfig = config56(),
  deck: readonly Card[] = DEAL_56,
  suit: Suit | "noTrump" = "spades",
): Flow {
  const { playerCount } = config;
  const passes = Array.from({ length: playerCount - 1 }, (_, index) =>
    pass((index + 2) % playerCount),
  );
  const flow = run(start(config), [deal(deck), bid56(1, 28, suit), ...passes]);
  assert.equal(flow.state.phase.type, "play");
  return flow;
}

/**
 * 28: seat 1 bids 16, places `faceDown`, and the second auction passes out,
 * so seat 1's hidden trump stands. Seat 1 leads.
 */
function playing28(
  config: EngineConfig = config28(),
  deck: readonly Card[] = DEAL_28,
  faceDown = "HJ",
): Flow {
  const flow = run(start(config), [
    deal(deck),
    bid28(1, 16),
    pass(2),
    pass(3),
    pass(0),
    place(1, c(faceDown)),
    pass(1),
    pass(2),
    pass(3),
    pass(0),
  ]);
  assert.equal(flow.state.phase.type, "play");
  return flow;
}

/** Plays the first legal card for whoever's turn it is until play ends. */
function autoPlay(flow: Flow): Flow {
  let current = flow;
  while (current.state.phase.type === "play") {
    const { turn } = roundOf(current.state);
    const [card] = legalCards(current.state, turn);
    assert.ok(card !== undefined);
    current = run(current, [play(turn, card)]);
  }
  return current;
}

const autoStop = { illegalPlayMode: "autoStop" } as const;

// ---------------------------------------------------------------------------

describe("play: following suit and free discards (design §9.2, rules §6.1)", () => {
  it("must follow the lead suit; without it, any card — trump or not — may be played", () => {
    let flow = playing56();
    flow = run(flow, [play(1, "HJ")]);
    assert.deepEqual(roundOf(flow.state).leadSuit, "hearts");
    assert.deepEqual(flow.events, [
      { type: "cardPlayed", seat: 1, card: c("HJ"), fromFaceDown: false },
    ]);

    // Seat 2 holds hearts.
    assert.deepEqual(legalCards(flow.state, 2), cards("HJ' H9 HK HQ"));
    assert.deepEqual(rejection(flow.state, play(2, "CJ")), {
      code: "illegalPlay",
      details: { kind: "didNotFollowSuit" },
    });
    flow = run(flow, [play(2, "HJ'")]);

    // Seat 3 holds no hearts: its whole hand is legal.
    assert.equal(legalCards(flow.state, 3).length, 12);
    flow = run(flow, [play(3, "CQ"), play(0, "HQ'")]);
    // Identical cards (rules §6.2): the jack played first wins.
    assert.deepEqual(flow.events.slice(1), [
      { type: "roundWon", seat: 1, team: "B", points: 6 },
    ]);

    // Round 2: seat 2 has no diamonds and may trump; seat 0 may discard
    // without trumping while holding trump.
    flow = run(flow, [play(1, "DJ")]);
    assert.equal(legalCards(flow.state, 2).length, 11);
    flow = run(flow, [play(2, "SQ"), play(3, "DQ'")]);
    assert.equal(legalCards(flow.state, 0).length, 11);
    flow = run(flow, [play(0, "CQ'")]);
    assert.deepEqual(flow.events.slice(1), [
      { type: "roundWon", seat: 2, team: "A", points: 3 },
    ]);
    const match = matchOf(flow.state);
    assert.deepEqual(match.points, { A: 3, B: 6 });
    assert.equal(match.rounds.length, 2);
    assert.equal(match.trumpPlayed, true);
  });

  it("the winner leads the next round and the reveal-turn flags clear", () => {
    const flow = run(playing56(), [
      play(1, "DJ"),
      play(2, "SQ"),
      play(3, "DQ'"),
      play(0, "CQ'"),
    ]);
    assert.deepEqual(roundOf(flow.state), {
      leader: 2,
      plays: [],
      turn: 2,
      leadSuit: null,
      revealedThisRound: false,
      revealAskedBy: null,
    });
    assert.deepEqual(rejection(flow.state, play(1, "HJ")), {
      code: "notYourTurn",
      details: { expected: 2, actual: 1 },
    });
    assert.deepEqual(legalCards(flow.state, 1), []);
  });
});

describe("play: leading trump (design §9.2, rules §6.3)", () => {
  it("can't lead trump before a trump was played in an earlier round", () => {
    let flow = playing56();
    // Seat 1 holds two spades among other suits.
    assert.deepEqual(
      legalCards(flow.state, 1),
      cards("HJ HA H10 DJ D9 DA D10 DK DQ CK"),
    );
    assert.deepEqual(rejection(flow.state, play(1, "SJ")), {
      code: "illegalPlay",
      details: { kind: "ledTrumpEarly" },
    });

    // A trump played in the current round doesn't count until it ends.
    flow = run(flow, [play(1, "DJ"), play(2, "SQ")]);
    assert.equal(matchOf(flow.state).trumpPlayed, false);
    flow = run(flow, [play(3, "DQ'"), play(0, "CQ'")]);
    assert.equal(matchOf(flow.state).trumpPlayed, true);
    // Seat 2 won with trump and may now lead it.
    assert.ok(legalCards(flow.state, 2).some((card) => card.suit === "spades"));
    flow = run(flow, [play(2, "SK")]);
    assert.equal(roundOf(flow.state).leadSuit, "spades");
  });

  it("a leader holding only trump may lead it, and that marks trump played", () => {
    let flow = playing56(config56(), DEAL_56_ALL_SPADES);
    assert.equal(legalCards(flow.state, 1).length, 12);
    flow = run(flow, [
      play(1, "SQ"),
      play(2, "DJ"),
      play(3, "CJ"),
      play(0, "HJ"),
    ]);
    assert.deepEqual(flow.events.at(-1), {
      type: "roundWon",
      seat: 1,
      team: "B",
      points: 9,
    });
    assert.equal(matchOf(flow.state).trumpPlayed, true);
  });

  it("no trump: any suit may be led at any time, and the highest lead-suit card wins", () => {
    let flow = playing56(config56(), DEAL_56, "noTrump");
    assert.equal(legalCards(flow.state, 1).length, 12);
    flow = run(flow, [play(1, "SJ")]);
    assert.deepEqual(legalCards(flow.state, 2), cards("SA S10 SK SQ"));
    // Seat 0's identical jack, played later, loses to seat 1's.
    flow = run(flow, [play(2, "SA"), play(3, "DJ'"), play(0, "SJ'")]);
    assert.deepEqual(flow.events.at(-1), {
      type: "roundWon",
      seat: 1,
      team: "B",
      points: 10,
    });
    assert.equal(matchOf(flow.state).trumpPlayed, false);
  });

  it("a 28 hidden trump is a plain suit until revealed, then can't be led early", () => {
    // Seat 1 leads clubs, the hidden suit, while trump is unrevealed.
    let flow = playing28(config28(), DEAL_28_ALL_CLUBS, "C10");
    assert.deepEqual(legalCards(flow.state, 1), cards("CJ C9 CA CK CQ C8 C7"));
    flow = run(flow, [play(1, "CJ")]);

    // DEAL_28: the reveal round holds no heart, so trump isn't played yet.
    flow = run(playing28(config28()), [
      play(1, "SA"),
      play(2, "C10"),
      ask(3),
      play(3, "CQ"),
      play(0, "S7"),
    ]);
    assert.deepEqual(flow.events.at(-1), {
      type: "roundWon",
      seat: 1,
      team: "B",
      points: 2,
    });
    assert.equal(matchOf(flow.state).trumpPlayed, false);
    assert.deepEqual(legalCards(flow.state, 1), cards("S10 SK SQ D7 C7 C8"));
    assert.deepEqual(rejection(flow.state, play(1, "HJ")), {
      code: "illegalPlay",
      details: { kind: "ledTrumpEarly" },
    });
  });
});

describe("play: hidden-trump reveal (design §9.1, §9.5, rules §10.3)", () => {
  it("asking reveals the card to everyone, returns it to the bidder, and lets the asker play any card", () => {
    let flow = playing28();
    assert.deepEqual(rejection(flow.state, ask(1)), {
      code: "revealNotAllowed",
      details: { reason: "leading" },
    });
    flow = run(flow, [play(1, "SA"), play(2, "H9")]);
    assert.deepEqual(rejection(flow.state, ask(0)), {
      code: "notYourTurn",
      details: { expected: 3, actual: 0 },
    });

    flow = run(flow, [ask(3)]);
    assert.deepEqual(flow.events, [
      { type: "revealAsked", seat: 3 },
      { type: "trumpRevealed", card: c("HJ") },
    ]);
    const match = matchOf(flow.state);
    assert.equal(match.faceDown, null);
    assert.equal(match.revealedInRound, 0);
    assert.deepEqual(match.hands[1]?.at(-1), c("HJ"));
    assert.equal(roundOf(flow.state).revealedThisRound, true);
    assert.equal(roundOf(flow.state).revealAskedBy, 3);
    assert.deepEqual(rejection(flow.state, ask(3)), {
      code: "revealNotAllowed",
      details: { reason: "alreadyAsked" },
    });
    assert.equal(legalCards(flow.state, 3).length, 8);

    flow = run(flow, [play(3, "CQ")]);
    assert.deepEqual(rejection(flow.state, ask(0)), {
      code: "revealNotAllowed",
      details: { reason: "trumpNotHidden" },
    });
    // Seat 0 must follow spades: revealAskedBy only frees the asker.
    assert.deepEqual(legalCards(flow.state, 0), cards("SJ S9 S8 S7"));
    flow = run(flow, [play(0, "S7")]);

    // The nine of hearts, played before the reveal, counts as trump in the
    // reveal round and beats the led ace of spades.
    assert.deepEqual(flow.events, [
      { type: "cardPlayed", seat: 0, card: c("S7"), fromFaceDown: false },
      { type: "roundWon", seat: 2, team: "A", points: 3 },
    ]);
    assert.equal(matchOf(flow.state).trumpPlayed, true);
    assert.equal(matchOf(flow.state).revealedInRound, 0);
    assert.equal(roundOf(flow.state).revealedThisRound, false);
    assert.equal(roundOf(flow.state).revealAskedBy, null);
  });

  it("the bidder may ask too, and then chooses whether to play the revealed card", () => {
    let flow = run(playing28(), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "HA"),
      play(3, "H8"),
      play(0, "D10"),
    ]);
    // Seat 1 holds no heart in hand: it is forced, so it can't ask.
    assert.deepEqual(rejection(flow.state, ask(1)), {
      code: "revealNotAllowed",
      details: { reason: "forced" },
    });

    // Diamonds led instead: the bidder can't follow and may ask.
    flow = run(playing28(), [play(1, "SA"), play(2, "C10")]);
    flow = run(flow, [play(3, "D9"), play(0, "SJ")]);
    flow = run(flow, [play(0, "DJ"), play(1, "D7"), play(2, "C9")]);
    flow = run(flow, [play(3, "DQ")]);
    // Seat 0 wins with the jack and leads diamonds again; seat 1 has none.
    flow = run(flow, [play(0, "DA")]);
    flow = run(flow, [ask(1)]);
    assert.equal(legalCards(flow.state, 1).length, 6);
    flow = run(flow, [play(1, "SQ")]);
    assert.equal(
      matchOf(flow.state).hands[1]?.some((card) => card.suit === "hearts"),
      true,
    );
  });

  it("asking while able to follow suit is rejected in Block", () => {
    const flow = run(playing28(), [
      play(1, "SA"),
      play(2, "H9"),
      play(3, "CQ"),
    ]);
    assert.deepEqual(rejection(flow.state, ask(0)), {
      code: "illegalPlay",
      details: { kind: "revealWhileAbleToFollow" },
    });
  });

  it("is never allowed in 56 or a 28 no-trump match", () => {
    const flow56 = run(playing56(), [play(1, "HJ")]);
    assert.deepEqual(rejection(flow56.state, ask(2)), {
      code: "revealNotAllowed",
      details: { reason: "trumpNotHidden" },
    });

    // 28: everyone passes twice; the forced 14 no trump stands.
    const forced = run(start(config28()), [
      deal(DEAL_28),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.equal(forced.state.phase.type, "play");
    assert.deepEqual(matchOf(forced.state).contract?.trump, {
      type: "noTrump",
    });
    const led = run(forced, [play(1, "SA")]);
    assert.deepEqual(rejection(led.state, ask(2)), {
      code: "revealNotAllowed",
      details: { reason: "trumpNotHidden" },
    });
  });
});

describe("play: the forced face-down card (design §9.3)", () => {
  /** DEAL_28 up to seat 1's turn in round 2, with hearts (the hidden suit) led. */
  function heartsLedToBidder(config: EngineConfig = config28()): Flow {
    return run(playing28(config), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "H9"),
      play(3, "H8"),
      play(0, "D10"),
    ]);
  }

  it("trump led with no other trump in hand: the bidder must reveal and play it", () => {
    let flow = heartsLedToBidder();
    assert.equal(faceDownIsForced(flow.state, 1), true);
    assert.deepEqual(legalCards(flow.state, 1), [c("HJ")]);
    assert.deepEqual(rejection(flow.state, play(1, "SQ")), {
      code: "illegalPlay",
      details: { kind: "didNotPlayFaceDown" },
    });

    flow = run(flow, [play(1, "HJ")]);
    assert.deepEqual(flow.events, [
      { type: "trumpRevealed", card: c("HJ") },
      { type: "cardPlayed", seat: 1, card: c("HJ"), fromFaceDown: true },
      { type: "roundWon", seat: 1, team: "B", points: 6 },
    ]);
    const match = matchOf(flow.state);
    assert.equal(match.faceDown, null);
    assert.equal(match.revealedInRound, 1);
    assert.equal(match.trumpPlayed, true);
    assert.deepEqual(match.rounds[1]?.plays.at(-1), {
      seat: 1,
      card: c("HJ"),
      fromFaceDown: true,
    });
  });

  it("with another trump in hand the bidder follows with it and the card stays hidden", () => {
    let flow = run(playing28(config28(), DEAL_28_SPARE_TRUMP), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "H9"),
      play(3, "H8"),
      play(0, "D10"),
    ]);
    assert.equal(faceDownIsForced(flow.state, 1), false);
    assert.deepEqual(legalCards(flow.state, 1), [c("H7")]);
    assert.deepEqual(rejection(flow.state, play(1, "HJ")), {
      code: "faceDownNotPlayable",
      details: {},
    });
    flow = run(flow, [play(1, "H7")]);
    // Unrevealed, the hearts are a plain lead suit: the nine wins.
    assert.deepEqual(flow.events.at(-1), {
      type: "roundWon",
      seat: 2,
      team: "A",
      points: 3,
    });
    const match = matchOf(flow.state);
    assert.deepEqual(match.faceDown, { owner: 1, card: c("HJ") });
    assert.equal(match.revealedInRound, null);
    assert.equal(match.trumpPlayed, false);
  });

  it("the face-down card as the bidder's last card is forced, and the last round scores the match", () => {
    let flow = playing28(config28(), DEAL_28_ALL_CLUBS, "C10");
    // Not forced while the hand still holds cards; another seat naming the
    // face-down card simply doesn't hold it.
    assert.deepEqual(rejection(flow.state, play(1, "C10")), {
      code: "faceDownNotPlayable",
      details: {},
    });
    flow = run(flow, [play(1, "CJ")]);
    assert.deepEqual(rejection(flow.state, play(2, "C10")), {
      code: "cardNotInHand",
      details: {},
    });
    flow = run(flow, [play(2, "HJ"), play(3, "DJ"), play(0, "SJ")]);

    // Seat 1 leads clubs and wins every round while trump stays hidden.
    for (let round = 1; round < 7; round += 1) {
      const lead = matchOf(flow.state).hands[1]?.[0];
      assert.ok(lead !== undefined);
      flow = run(flow, [play(1, lead)]);
      for (const other of [2, 3, 0]) {
        const [card] = legalCards(flow.state, other);
        assert.ok(card !== undefined);
        flow = run(flow, [play(other, card)]);
      }
      assert.equal(only(flow.events, "roundWon").seat, 1);
    }
    assert.deepEqual(matchOf(flow.state).hands[1], []);
    assert.equal(faceDownIsForced(flow.state, 1), true);
    assert.deepEqual(legalCards(flow.state, 1), [c("C10")]);
    assert.deepEqual(rejection(flow.state, ask(1)), {
      code: "revealNotAllowed",
      details: { reason: "leading" },
    });

    flow = run(flow, [play(1, "C10")]);
    assert.deepEqual(flow.events, [
      { type: "trumpRevealed", card: c("C10") },
      { type: "cardPlayed", seat: 1, card: c("C10"), fromFaceDown: true },
    ]);
    flow = run(flow, [play(2, "H7"), play(3, "D7")]);
    flow = run(flow, [play(0, "S7")]);
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "roundWon",
      "matchEnded",
    ]);
    const ended = only(flow.events, "matchEnded");
    assert.deepEqual(ended.summary, {
      dealer: 0,
      contract: {
        bidder: 1,
        team: "B",
        amount: 16,
        trump: { type: "suit", suit: "clubs" },
        style: null,
        multiplier: 1,
        forced: false,
      },
      points: { A: 0, B: 28 },
      tokensMoved: { payer: "A", amount: 1 },
      tokens: { A: 9, B: 11 },
      outcome: { type: "made" },
    });
    assert.equal(flow.state.phase.type, "matchOver");
  });
});

describe("play: Auto-stop disqualification (design §9.4, rules §8)", () => {
  it("leading trump early: the bidding team pays the loss stake", () => {
    const flow = run(playing56(config56(autoStop)), [play(1, "SJ")]);
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "disqualified",
      "matchEnded",
    ]);
    assert.deepEqual(flow.events[1], {
      type: "disqualified",
      seat: 1,
      kind: "ledTrumpEarly",
    });
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.outcome, {
      type: "disqualified",
      seat: 1,
      kind: "ledTrumpEarly",
    });
    assert.deepEqual(summary.tokensMoved, { payer: "B", amount: 2 });
    assert.deepEqual(summary.points, { A: 0, B: 0 });
    assert.equal(flow.state.phase.type, "matchOver");
  });

  it("not following suit: a defender's team pays the win stake; collected points are kept and the round isn't finished", () => {
    const flow = run(playing56(config56(autoStop)), [
      play(1, "HJ"),
      play(2, "HJ'"),
      play(3, "CQ"),
      play(0, "HQ'"),
      play(1, "DJ"),
      play(2, "SQ"),
      play(3, "DQ'"),
      play(0, "CQ'"),
      play(2, "H9"),
      play(3, "C9'"),
      play(0, "SA'"),
    ]);
    assert.deepEqual(flow.events.slice(0, 2), [
      { type: "cardPlayed", seat: 0, card: c("SA'"), fromFaceDown: false },
      { type: "disqualified", seat: 0, kind: "didNotFollowSuit" },
    ]);
    assert.ok(!types(flow.events).includes("roundWon"));
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.tokensMoved, { payer: "A", amount: 1 });
    assert.deepEqual(summary.points, { A: 3, B: 6 });
  });

  it("the round's last card can disqualify without completing the round", () => {
    const flow = run(playing56(config56(autoStop)), [
      play(1, "HJ"),
      play(2, "HJ'"),
      play(3, "CQ"),
      play(0, "CQ'"),
    ]);
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "disqualified",
      "matchEnded",
    ]);
    assert.deepEqual(only(flow.events, "matchEnded").summary.points, {
      A: 0,
      B: 0,
    });
  });

  it("a forced bidder playing another card: the bidding team pays and trump stays hidden", () => {
    const flow = run(playing28(config28(autoStop)), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "H9"),
      play(3, "H8"),
      play(0, "D10"),
      play(1, "SQ"),
    ]);
    assert.deepEqual(flow.events.slice(0, 2), [
      { type: "cardPlayed", seat: 1, card: c("SQ"), fromFaceDown: false },
      { type: "disqualified", seat: 1, kind: "didNotPlayFaceDown" },
    ]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.contract?.trump, { type: "hidden" });
    assert.deepEqual(summary.tokensMoved, { payer: "B", amount: 2 });
    assert.deepEqual(summary.points, { A: 3, B: 0 });
  });

  it("asking while able to follow: the reveal happens, then the asker's team pays", () => {
    const flow = run(playing28(config28(autoStop)), [
      play(1, "SA"),
      play(2, "H9"),
      play(3, "CQ"),
      ask(0),
    ]);
    assert.deepEqual(flow.events.slice(0, 3), [
      { type: "revealAsked", seat: 0 },
      { type: "trumpRevealed", card: c("HJ") },
      { type: "disqualified", seat: 0, kind: "revealWhileAbleToFollow" },
    ]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.contract?.trump, { type: "suit", suit: "hearts" });
    assert.deepEqual(summary.tokensMoved, { payer: "A", amount: 1 });
  });

  it("leading a revealed trump early disqualifies the bidder", () => {
    const flow = run(playing28(config28(autoStop)), [
      play(1, "SA"),
      play(2, "C10"),
      ask(3),
      play(3, "CQ"),
      play(0, "S7"),
      play(1, "HJ"),
    ]);
    assert.deepEqual(flow.events.slice(0, 2), [
      { type: "cardPlayed", seat: 1, card: c("HJ"), fromFaceDown: false },
      { type: "disqualified", seat: 1, kind: "ledTrumpEarly" },
    ]);
    const { summary } = only(flow.events, "matchEnded");
    assert.deepEqual(summary.contract?.trump, { type: "suit", suit: "hearts" });
    assert.deepEqual(summary.tokensMoved, { payer: "B", amount: 2 });
    assert.deepEqual(summary.points, { A: 0, B: 2 });
  });

  it("ends the session when the payment empties a team", () => {
    const playing = playing56(config56(autoStop));
    const poor = { ...playing.state, tokens: { A: 38, B: 2 } };
    assertEngineInvariants(poor);
    const flow = run({ ...playing, state: poor }, [play(1, "SJ")]);
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "disqualified",
      "matchEnded",
      "sessionEnded",
    ]);
    assert.deepEqual(flow.state.phase.type, "sessionOver");
  });

  it("Auto-stop still rejects the always-blocked moves", () => {
    const flow = playing28(config28(autoStop), DEAL_28_ALL_CLUBS, "C10");
    assert.equal(
      rejection(flow.state, play(1, "C10"))?.code,
      "faceDownNotPlayable",
    );
    assert.equal(rejection(flow.state, play(1, "SJ"))?.code, "cardNotInHand");
    assert.equal(rejection(flow.state, ask(1))?.code, "revealNotAllowed");
    assert.equal(rejection(flow.state, play(2, "HJ"))?.code, "notYourTurn");
  });
});

describe("play: round winner (design §9.6)", () => {
  const contract = (trump: Contract["trump"]): Contract => ({
    bidder: 1,
    team: "B",
    amount: 30,
    trump,
    style: null,
    multiplier: 1,
    forced: false,
  });
  const round = (...codes: string[]) => ({
    plays: codes.map((code, index) => ({
      seat: index,
      card: c(code),
      fromFaceDown: false,
    })),
  });

  it("highest counting trump, else highest lead-suit card; first of identical cards", () => {
    const spades = contract({ type: "suit", suit: "spades" });
    assert.equal(roundWinner(round("H10", "HA", "S7", "SQ"), spades, false), 3);
    assert.equal(roundWinner(round("H10", "HA", "DJ", "C9"), spades, false), 1);
    assert.equal(roundWinner(round("HQ", "HJ", "DJ", "HJ'"), spades, false), 1);
    assert.equal(roundWinner(round("SJ", "SJ'", "HJ", "S9"), spades, false), 0);
    const noTrump = contract({ type: "noTrump" });
    assert.equal(
      roundWinner(round("H10", "SJ", "HA", "H9"), noTrump, false),
      3,
    );
    // 28 hidden trump: counts only once revealed.
    const hidden = contract({ type: "hidden", suit: "spades" });
    assert.equal(roundWinner(round("H10", "S7", "HA", "H9"), hidden, false), 3);
    assert.equal(roundWinner(round("H10", "S7", "HA", "H9"), hidden, true), 1);
    assert.equal(countingTrumpSuit(hidden, false), null);
    assert.equal(countingTrumpSuit(hidden, true), "spades");
    assert.throws(() => roundWinner({ plays: [] }, spades, false));
  });
});

describe("play: whole matches", () => {
  for (const playerCount of [4, 6, 8] as const) {
    it(`56 with ${playerCount} players: every round is won, team points total 56, and the last round scores`, () => {
      const config = config56({ playerCount });
      const flow = autoPlay(playing56(config, buildDeck(config)));
      const roundsWon = flow.log.filter(
        (event): event is EventOfType<"roundWon"> => event.type === "roundWon",
      );
      assert.equal(roundsWon.length, 48 / playerCount);
      const totals: Record<Team, number> = { A: 0, B: 0 };
      for (const event of roundsWon) {
        totals[event.team] += event.points;
      }
      assert.equal(totals.A + totals.B, 56);
      const { summary } = only(flow.log, "matchEnded");
      assert.deepEqual(summary.points, totals);
      assert.deepEqual(summary.outcome, {
        type: totals.B >= 28 ? "made" : "failed",
      });
      assert.equal(flow.state.phase.type, "matchOver");
    });
  }

  it("28: a full match with a forced reveal totals 28 points", () => {
    const flow = autoPlay(playing28());
    const roundsWon = flow.log.filter((event) => event.type === "roundWon");
    assert.equal(roundsWon.length, 8);
    assert.ok(flow.log.some((event) => event.type === "trumpRevealed"));
    const { summary } = only(flow.log, "matchEnded");
    assert.equal(summary.points.A + summary.points.B, 28);
    assert.deepEqual(summary.outcome, {
      type: summary.points.B >= 16 ? "made" : "failed",
    });
  });

  it("28: a bidding team short of its bid after the last round fails and pays the loss stake", () => {
    // DEAL_28_ALL_CLUBS with seat 2 (team A) bidding 16 and placing the ten
    // of hearts. Seat 1 leads and wins every club round while trump is
    // hidden; seat 2 must play the face-down card as its last card while
    // following, and the revealed trump wins only the final round.
    let flow = run(start(config28()), [
      deal(DEAL_28_ALL_CLUBS),
      pass(1),
      bid28(2, 16),
      pass(3),
      pass(0),
      pass(1),
      place(2, c("H10")),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.equal(flow.state.phase.type, "play");
    flow = autoPlay(flow);

    const roundsWon = flow.log.filter(
      (event): event is EventOfType<"roundWon"> => event.type === "roundWon",
    );
    assert.deepEqual(
      roundsWon.map((event) => event.seat),
      [1, 1, 1, 1, 1, 1, 1, 2],
    );
    assert.deepEqual(
      flow.log.filter(
        (event) => event.type === "cardPlayed" && event.fromFaceDown,
      ),
      [{ type: "cardPlayed", seat: 2, card: c("H10"), fromFaceDown: true }],
    );
    assert.deepEqual(types(flow.events), [
      "cardPlayed",
      "roundWon",
      "matchEnded",
    ]);
    assert.deepEqual(only(flow.events, "matchEnded").summary, {
      dealer: 0,
      contract: {
        bidder: 2,
        team: "A",
        amount: 16,
        trump: { type: "suit", suit: "hearts" },
        style: null,
        multiplier: 1,
        forced: false,
      },
      points: { A: 1, B: 27 },
      tokensMoved: { payer: "A", amount: 2 },
      tokens: { A: 8, B: 12 },
      outcome: { type: "failed" },
    });
    assert.equal(flow.state.phase.type, "matchOver");
  });
});

describe("play: rejections and direct calls", () => {
  // Plays during a surrender vote are covered with real votes in
  // surrender.test.ts.
  it("rejects unknown cards and calls outside play", () => {
    const flow = playing56();
    assert.deepEqual(rejection(flow.state, play(1, "SJ'")), {
      code: "cardNotInHand",
      details: {},
    });
    for (const bad of [null, "SJ", { suit: "spades" }]) {
      const action = {
        type: "playCard",
        card: bad,
        source: seat(1),
      } as unknown as EngineAction;
      assert.equal(rejection(flow.state, action)?.code, "cardNotInHand");
    }

    const awaiting = start(config56()).state;
    assert.equal(decidePlayAction(awaiting, play(1, "HJ")).ok, false);
    assert.equal(rejection(awaiting, play(1, "HJ"))?.code, "actionNotAllowed");
    const notPlay = decidePlayAction(flow.state, pass(1));
    assert.deepEqual(notPlay, {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass" },
    });
    assert.deepEqual(legalCards(awaiting, 1), []);
    assert.equal(revealBlocker(awaiting, 1), "notInPlay");
  });

  it("evolvers throw instead of applying a misordered event (design §13.1)", () => {
    const flow = playing56();
    const awaiting = start(config56()).state;
    assert.throws(() =>
      evolveCardPlayed(flow.state, {
        type: "cardPlayed",
        seat: 2,
        card: c("HJ'"),
        fromFaceDown: false,
      }),
    );
    assert.throws(() =>
      evolveCardPlayed(flow.state, {
        type: "cardPlayed",
        seat: 1,
        card: c("SJ'"),
        fromFaceDown: false,
      }),
    );
    assert.throws(() =>
      evolveRoundWon(flow.state, {
        type: "roundWon",
        seat: 1,
        team: "B",
        points: 0,
      }),
    );
    assert.throws(() =>
      evolveDisqualified(awaiting, {
        type: "disqualified",
        seat: 1,
        kind: "ledTrumpEarly",
      }),
    );
    // 56 has no face-down card to reveal.
    assert.throws(() =>
      evolve(flow.state, { type: "trumpRevealed", card: c("SJ") }),
    );
    const revealed = run(playing28(), [play(1, "SA"), play(2, "H9"), ask(3)]);
    assert.throws(() =>
      evolve(revealed.state, { type: "revealAsked", seat: 3 }),
    );
  });
});

describe("E007 invariants", () => {
  function expectInvariant(state: EngineState, code: string): void {
    assert.throws(
      () => assertEngineInvariants(state),
      (error: unknown) =>
        error instanceof EngineInvariantError && error.code === code,
    );
  }

  it("ties lead suit, reveal flags, face-down plays, and per-seat card counts together", () => {
    const flow = run(playing28(), [play(1, "SA"), play(2, "H9")]);
    const match = matchOf(flow.state);
    const round = roundOf(flow.state);

    expectInvariant(
      withMatch(flow.state, {
        ...match,
        currentRound: { ...round, leadSuit: "hearts" },
      }),
      "invalidRound",
    );
    expectInvariant(
      withMatch(flow.state, {
        ...match,
        currentRound: { ...round, revealedThisRound: true },
      }),
      "invalidReveal",
    );
    expectInvariant(
      withMatch(flow.state, {
        ...match,
        currentRound: { ...round, revealAskedBy: 3 },
      }),
      "invalidReveal",
    );
    expectInvariant(
      withMatch(flow.state, {
        ...match,
        currentRound: {
          ...round,
          plays: round.plays.map((entry) =>
            entry.seat === 2 ? { ...entry, fromFaceDown: true } : entry,
          ),
        },
      }),
      "invalidReveal",
    );
    // Move one of seat 0's cards into seat 3's hand.
    const moved = match.hands[0]?.[0];
    assert.ok(moved !== undefined);
    expectInvariant(
      withMatch(flow.state, {
        ...match,
        hands: match.hands.map((hand, index) =>
          index === 0 ? hand.slice(1) : index === 3 ? [...hand, moved] : hand,
        ),
      }),
      "invalidRound",
    );
  });
});

describe("E007 replay and immutability", () => {
  it("replaying every event from newSession reproduces the final state, with frozen inputs", () => {
    for (const config of [config28(), config28(autoStop)]) {
      const started = newSession(deepFreeze(config), 0);
      assert.ok(started.ok);
      if (!started.ok) {
        throw new Error("unreachable");
      }
      let state = deepFreeze(started.state);
      const log: EngineEvent[] = [...started.events];
      const actions = [
        deal(DEAL_28),
        bid28(1, 16),
        pass(2),
        pass(3),
        pass(0),
        place(1, c("HJ")),
        pass(1),
        pass(2),
        pass(3),
        pass(0),
        play(1, "SA"),
        play(2, "H9"),
        ask(3),
        play(3, "CQ"),
        play(0, "S7"),
        // Block: seat 2 leads the revealed trump, already played. Auto-stop:
        // seat 3 discards a heart while holding the led clubs.
        ...(config.illegalPlayMode === "block"
          ? [play(2, "HA")]
          : [play(2, "CJ"), play(3, "HQ")]),
      ];
      for (const action of actions) {
        const result = act(state, deepFreeze(action));
        assert.ok(result.ok, `expected ${action.type} to be accepted`);
        if (!result.ok) {
          throw new Error("unreachable");
        }
        log.push(...result.events);
        state = deepFreeze(result.state);
      }
      const replayed = log.reduce(
        (current, event) => evolve(current, event),
        started.state,
      );
      assert.equal(JSON.stringify(replayed), JSON.stringify(state));
      assert.equal(
        state.phase.type,
        config.illegalPlayMode === "block" ? "play" : "matchOver",
      );
    }
  });
});
