import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { bidRange } from "./auction.js";
import { buildDeck } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent } from "./events.js";
import { decidePlaceCard, faceDownIsForced } from "./hidden-trump.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import { completeHoldings, redealReason } from "./redeal.js";
import type { AuctionState, EngineState, MatchState } from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type { Card, EngineConfig, Rank, Suit } from "./types.js";

// E005: 28's two auctions, the face-down card, and the automatic second deal.

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

/** `c("HJ")` is the jack of hearts; `c("S10")` the ten of spades. */
function c(code: string): Card {
  const suit = SUIT_CODES[code.slice(0, 1)];
  assert.ok(suit !== undefined);
  return { suit, rank: code.slice(1) as Rank, copy: 1 };
}

const cards = (codes: string): Card[] => codes.split(" ").map(c);

/**
 * Builds a deck that deals `first[seat]` and then `second[seat]` to each seat
 * (card `k` of each stage goes to seat `(dealer + 1 + k) mod 4`).
 */
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

// Seats 0/2 are team A, 1/3 team B. Dealer 0, so seat 1 calls and leads first.

const NORMAL_FIRST = [
  cards("SJ S9 HA H10"),
  cards("HJ H9 DA D10"),
  cards("DJ D9 CA C10"),
  cards("CJ C9 SA S10"),
];
const NORMAL_SECOND = [
  cards("DK DQ C8 C7"),
  cards("CK CQ S8 S7"),
  cards("SK SQ H8 H7"),
  cards("HK HQ D8 D7"),
];
const NORMAL_DECK = deckFor(0, NORMAL_FIRST, NORMAL_SECOND);

/** Seat 1's only points and team B's only Jack are the jack of hearts. */
const JACK_FIRST = [
  cards("SJ DJ CJ S9"),
  cards("HJ SK SQ DK"),
  cards("D9 C9 SA S10"),
  cards("H9 S8 S7 D8"),
];
const JACK_SECOND = [
  cards("HA H10 HQ H7"),
  cards("DQ CK CQ HK"),
  cards("DA D10 CA C10"),
  cards("D7 C8 C7 H8"),
];
const JACK_DECK = deckFor(0, JACK_FIRST, JACK_SECOND);

/** Like JACK_DECK, but seat 3's complete holding is worth 0 points. */
const LOW_DECK = deckFor(
  0,
  [
    JACK_FIRST[0],
    JACK_FIRST[1],
    JACK_FIRST[2],
    cards("HK S8 S7 D8"),
  ] as Card[][],
  [
    JACK_SECOND[0],
    cards("DQ CK CQ H9"),
    JACK_SECOND[2],
    JACK_SECOND[3],
  ] as Card[][],
);

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const bid = (seatNumber: number, amount: number): EngineAction => ({
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

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

/** Every one of the 32 cards is in exactly one hand, `undealt` slot, or face-down storage. */
function assertCardsConserved(state: EngineState): void {
  if (!("match" in state.phase)) {
    return;
  }
  const { match } = state.phase;
  const located = [
    ...match.hands.flat(),
    ...(match.undealt ?? []).flat(),
    ...(match.faceDown === null ? [] : [match.faceDown.card]),
  ];
  assert.equal(located.length, 32);
  assert.deepEqual(
    new Set(located.map(cardKey)),
    new Set(buildDeck(config28()).map(cardKey)),
  );
}

interface Flow {
  state: EngineState;
  /** Events of the last accepted action. */
  events: EngineEvent[];
  /** Every event since `newSession`, in order. */
  log: EngineEvent[];
  initial: EngineState;
}

function start(config: EngineConfig = config28()): Flow {
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

/**
 * Applies each action via `act`, asserting acceptance, per-action replay,
 * invariants (including card locations), and 32-card conservation.
 */
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
    assertCardsConserved(result.state);
    state = result.state;
    events = result.events;
    log.push(...events);
  }
  return { state, events, log, initial: flow.initial };
}

function matchOf(state: EngineState): MatchState {
  if (!("match" in state.phase)) {
    throw new Error("expected a match in progress");
  }
  return state.phase.match;
}

function auctionOf(state: EngineState): AuctionState {
  const { auction } = matchOf(state);
  assert.ok(auction !== null);
  return auction;
}

function rejection(state: EngineState, action: EngineAction) {
  const result = decide(state, action);
  assert.equal(result.ok, false, `expected ${action.type} to be rejected`);
  return result.ok ? null : { code: result.code, details: result.details };
}

/**
 * NORMAL_DECK: seat 1 wins the first auction at `amount` (optionally doubled
 * by seat 2) and places the jack of hearts, starting the second auction.
 */
function secondAuction(
  amount: number,
  options: { doubled?: boolean; config?: EngineConfig } = {},
): Flow {
  const calls = options.doubled
    ? [bid(1, amount), double(2), pass(3), pass(0), pass(1)]
    : [bid(1, amount), pass(2), pass(3), pass(0)];
  return run(start(options.config), [
    deal(NORMAL_DECK),
    ...calls,
    place(1, c("HJ")),
  ]);
}

describe("28 first auction", () => {
  it("takes number-only bids from 14 through 28", () => {
    const { state } = run(start(), [deal(NORMAL_DECK)]);
    assert.deepEqual(bidRange(state, 1), { minimum: 14, maximum: 28 });
    assert.deepEqual(rejection(state, bid(1, 13)), {
      code: "bidOutOfRange",
      details: { minimum: 14, maximum: 28, amount: 13 },
    });
    assert.deepEqual(rejection(state, bid(1, 29)), {
      code: "bidOutOfRange",
      details: { minimum: 14, maximum: 28, amount: 29 },
    });
    assert.deepEqual(
      rejection(state, { ...bid(1, 14), suit: "spades" } as EngineAction),
      { code: "invalidBid", details: { reason: "unexpectedSuit" } },
    );
    assert.deepEqual(
      rejection(state, { ...bid(1, 14), style: "suitFirst" } as EngineAction),
      { code: "invalidBid", details: { reason: "unexpectedStyle" } },
    );

    const afterBids = run({ ...start(), state }, [bid(1, 14), bid(2, 28)]);
    assert.deepEqual(afterBids.events, [
      { type: "bidMade", seat: 2, amount: 28, suit: null, style: null },
    ]);
    assert.equal(bidRange(afterBids.state, 3), null);
  });

  it("forced 14 no trump places no card and deals the second stage at once", () => {
    const flow = run(start(), [
      deal(NORMAL_DECK),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
    ]);
    const forcedContract = {
      bidder: 1,
      team: "B",
      amount: 14,
      trump: { type: "noTrump" },
      style: null,
      multiplier: 1,
      forced: true,
    } as const;
    assert.deepEqual(flow.events, [
      { type: "passed", seat: 0 },
      { type: "forcedBid", seat: 1, amount: 14 },
      { type: "auctionEnded", contract: forcedContract },
      { type: "dealt", stage: "second", hands: NORMAL_SECOND, undealt: null },
      { type: "auctionStarted", stage: "28-second", firstTurn: 1, minBid: 21 },
    ]);
    const match = matchOf(flow.state);
    assert.equal(flow.state.phase.type, "auction");
    assert.equal(match.faceDown, null);
    assert.equal(match.undealt, null);
    assert.deepEqual(
      match.hands,
      NORMAL_FIRST.map((held, index) => [
        ...held,
        ...(NORMAL_SECOND[index] as Card[]),
      ]),
    );
    const forcedBid = {
      seat: 1,
      amount: 14,
      suit: "noTrump",
      style: null,
      forced: true,
    } as const;
    assert.deepEqual(auctionOf(flow.state), {
      stage: "28-second",
      calls: [],
      turn: 1,
      highBid: forcedBid,
      doubledBy: null,
      redoubled: false,
      consecutivePasses: 0,
      carriedBid: { bid: forcedBid, doubledBy: null },
    });

    // The carried forced bid still can't be doubled.
    const afterPass = run(flow, [pass(1)]);
    assert.deepEqual(rejection(afterPass.state, double(2)), {
      code: "doubleNotAllowed",
      details: { reason: "noDoublableBid" },
    });

    // If everyone passes again, it's played as no trump with no face-down card.
    const played = run(afterPass, [pass(2), pass(3), pass(0)]);
    assert.deepEqual(played.events, [
      { type: "passed", seat: 0 },
      { type: "auctionEnded", contract: forcedContract },
      { type: "playStarted", leader: 1 },
    ]);
    assert.equal(played.state.phase.type, "play");
    assert.equal(matchOf(played.state).faceDown, null);
    assert.equal(
      rejection(played.state, place(1, c("HJ")))?.code,
      "actionNotAllowed",
    );
  });

  it("a non-forced winner places a card, then the second deal and second auction follow", () => {
    const ended = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 16),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.deepEqual(ended.events, [
      { type: "passed", seat: 0 },
      { type: "placingCardStarted", seat: 1 },
    ]);
    assert.equal(ended.state.phase.type, "placingCard");
    assert.equal(matchOf(ended.state).contract, null);
    assert.equal(rejection(ended.state, pass(1))?.code, "actionNotAllowed");
    assert.equal(rejection(ended.state, bid(1, 17))?.code, "actionNotAllowed");

    const placed = run(ended, [place(1, c("HJ"))]);
    assert.deepEqual(placed.events, [
      { type: "cardPlaced", seat: 1, card: c("HJ") },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 16,
          trump: { type: "hidden", suit: "hearts" },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
      { type: "dealt", stage: "second", hands: NORMAL_SECOND, undealt: null },
      { type: "auctionStarted", stage: "28-second", firstTurn: 1, minBid: 21 },
    ]);
    const match = matchOf(placed.state);
    assert.deepEqual(match.faceDown, { owner: 1, card: c("HJ") });
    assert.deepEqual(match.hands[1], cards("H9 DA D10 CK CQ S8 S7"));
    // design §6.3: the first-auction contract stands into the second auction.
    assert.deepEqual(match.contract, {
      bidder: 1,
      team: "B",
      amount: 16,
      trump: { type: "hidden", suit: "hearts" },
      style: null,
      multiplier: 1,
      forced: false,
    });
    assert.deepEqual(auctionOf(placed.state).carriedBid, {
      bid: { seat: 1, amount: 16, suit: null, style: null, forced: false },
      doubledBy: null,
    });
  });

  it("a redoubled first auction skips the second auction and starts play with the hidden trump", () => {
    const redoubled = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 18),
      double(2),
      redouble(3),
    ]);
    assert.deepEqual(redoubled.events, [
      { type: "redoubled", seat: 3 },
      { type: "placingCardStarted", seat: 1 },
    ]);

    const played = run(redoubled, [place(1, c("DA"))]);
    assert.deepEqual(played.events, [
      { type: "cardPlaced", seat: 1, card: c("DA") },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 18,
          trump: { type: "hidden", suit: "diamonds" },
          style: null,
          multiplier: 4,
          forced: false,
        },
      },
      { type: "dealt", stage: "second", hands: NORMAL_SECOND, undealt: null },
      { type: "playStarted", leader: 1 },
    ]);
    assert.equal(played.state.phase.type, "play");
    const match = matchOf(played.state);
    assert.deepEqual(match.faceDown, { owner: 1, card: c("DA") });
    assert.equal(match.undealt, null);
    assert.equal(match.currentRound?.leader, 1);
  });
});

describe("28 first auction at 28", () => {
  const contract28 = (multiplier: 1 | 2) =>
    ({
      bidder: 1,
      team: "B",
      amount: 28,
      trump: { type: "hidden", suit: "hearts" },
      style: null,
      multiplier,
      forced: false,
    }) as const;

  it("an undoubled 28 skips the second auction and starts play after the second deal", () => {
    const played = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 28),
      pass(2),
      pass(3),
      pass(0),
      place(1, c("HJ")),
    ]);
    assert.deepEqual(played.events, [
      { type: "cardPlaced", seat: 1, card: c("HJ") },
      { type: "auctionEnded", contract: contract28(1) },
      { type: "dealt", stage: "second", hands: NORMAL_SECOND, undealt: null },
      { type: "playStarted", leader: 1 },
    ]);
    assert.equal(played.state.phase.type, "play");
    const match = matchOf(played.state);
    assert.deepEqual(match.contract, contract28(1));
    assert.deepEqual(match.faceDown, { owner: 1, card: c("HJ") });
    assert.equal(match.auction?.stage, "28-first");
  });

  it("a doubled 28 skips the second auction and plays at multiplier 2", () => {
    const played = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 28),
      double(2),
      pass(3),
      pass(0),
      pass(1),
      place(1, c("HJ")),
    ]);
    assert.deepEqual(played.events.slice(1), [
      { type: "auctionEnded", contract: contract28(2) },
      { type: "dealt", stage: "second", hands: NORMAL_SECOND, undealt: null },
      { type: "playStarted", leader: 1 },
    ]);
    assert.deepEqual(matchOf(played.state).contract, contract28(2));
  });

  it("a 28 whose second deal calls for a redeal redeals instead of starting play", () => {
    const redealt = run(start(), [
      deal(LOW_DECK),
      bid(1, 28),
      pass(2),
      pass(3),
      pass(0),
      place(1, c("HJ")),
    ]);
    assert.deepEqual(
      redealt.events.map((event) => event.type),
      [
        "cardPlaced",
        "auctionEnded",
        "dealt",
        "redealt",
        "faceDownReturned",
        "matchEnded",
      ],
    );
    assert.equal(redealt.state.matchLog[0]?.contract?.amount, 28);
    assert.deepEqual(redealt.state.phase, {
      type: "awaitingDeal",
      reason: "redeal",
    });
  });
});

describe("28 affordability", () => {
  it("narrows the bid range and rejects bids the team can't afford", () => {
    const { state } = run(start(config28({ startingTokens: 2 })), [
      deal(NORMAL_DECK),
    ]);
    // Loss stakes: 14–19 → 2, 20–27 → 3, 28 → 4.
    assert.deepEqual(bidRange(state, 1), { minimum: 14, maximum: 19 });
    assert.deepEqual(rejection(state, bid(1, 20)), {
      code: "cannotAfford",
      details: { team: "B", amount: 20 },
    });
    assert.equal(decide(state, bid(1, 19)).ok, true);
  });
});

describe("28 second auction", () => {
  it("starts at the dealer's right with minimum 21 or the carried amount + 1", () => {
    // A carried 28 has no second auction (tested separately).
    for (let carried = 14; carried <= 27; carried += 1) {
      const flow = secondAuction(carried);
      const expected = Math.max(21, carried + 1);
      assert.deepEqual(flow.events.at(-1), {
        type: "auctionStarted",
        stage: "28-second",
        firstTurn: 1,
        minBid: expected,
      });
      const { state } = flow;
      assert.equal(auctionOf(state).turn, 1);

      assert.deepEqual(bidRange(state, 1), {
        minimum: expected,
        maximum: 28,
      });
      assert.equal(decide(state, bid(1, expected)).ok, true);
      assert.deepEqual(rejection(state, bid(1, 20)), {
        code: "bidOutOfRange",
        details: { minimum: 21, maximum: 28, amount: 20 },
      });
      if (expected - 1 >= 21) {
        assert.deepEqual(rejection(state, bid(1, expected - 1)), {
          code: "bidTooLow",
          details: { minimum: expected, amount: expected - 1 },
        });
      }
    }
  });

  it("gives every seat a turn: after all N pass, the carried bid and face-down card stand", () => {
    const flow = run(secondAuction(20), [pass(1), pass(2), pass(3)]);
    // N−1 passes would end an ordinary auction; the carried bid needs all N.
    assert.equal(flow.state.phase.type, "auction");
    assert.equal(auctionOf(flow.state).turn, 0);

    const played = run(flow, [pass(0)]);
    assert.deepEqual(played.events, [
      { type: "passed", seat: 0 },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 20,
          trump: { type: "hidden", suit: "hearts" },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
    assert.equal(played.state.phase.type, "play");
    assert.deepEqual(matchOf(played.state).faceDown, {
      owner: 1,
      card: c("HJ"),
    });
  });

  it("a carried double doesn't end the initial circuit at its doubler and stands after N passes", () => {
    const flow = secondAuction(16, { doubled: true });
    assert.deepEqual(flow.events.at(-2), {
      type: "dealt",
      stage: "second",
      hands: NORMAL_SECOND,
      undealt: null,
    });
    assert.equal(auctionOf(flow.state).doubledBy, 2);
    assert.deepEqual(auctionOf(flow.state).carriedBid, {
      bid: { seat: 1, amount: 16, suit: null, style: null, forced: false },
      doubledBy: 2,
    });

    const passes = run(flow, [pass(1), pass(2), pass(3)]);
    assert.equal(passes.state.phase.type, "auction");
    assert.equal(auctionOf(passes.state).turn, 0);
    assert.deepEqual(rejection(passes.state, double(0)), {
      code: "doubleNotAllowed",
      details: { reason: "noDoublableBid" },
    });

    const played = run(passes, [pass(0)]);
    assert.deepEqual(played.events.slice(1), [
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 16,
          trump: { type: "hidden", suit: "hearts" },
          style: null,
          multiplier: 2,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });

  it("a carried double can be redoubled, ending the auction with the carried card", () => {
    const played = run(secondAuction(16, { doubled: true }), [
      pass(1),
      redouble(3),
    ]);
    assert.deepEqual(played.events, [
      { type: "redoubled", seat: 3 },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 16,
          trump: { type: "hidden", suit: "hearts" },
          style: null,
          multiplier: 4,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
    assert.deepEqual(matchOf(played.state).faceDown, {
      owner: 1,
      card: c("HJ"),
    });
  });

  it("a new double on the carried bid ends the auction N−1 passes later", () => {
    const flow = run(secondAuction(16), [pass(1), double(2), pass(3), pass(0)]);
    assert.equal(flow.state.phase.type, "auction");
    const played = run(flow, [pass(1)]);
    assert.deepEqual(played.events.slice(1), [
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 16,
          trump: { type: "hidden", suit: "hearts" },
          style: null,
          multiplier: 2,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });

  it("a raise by the holder cancels the carried double and replaces the face-down card", () => {
    const raised = run(secondAuction(16, { doubled: true }), [bid(1, 21)]);
    assert.deepEqual(raised.events, [
      { type: "bidMade", seat: 1, amount: 21, suit: null, style: null },
      { type: "doubleCancelled" },
    ]);
    assert.equal(auctionOf(raised.state).doubledBy, null);
    assert.equal(rejection(raised.state, redouble(3))?.code, "noDoubleActive");

    const ended = run(raised, [pass(2), pass(3), pass(0)]);
    assert.deepEqual(ended.events, [
      { type: "passed", seat: 0 },
      { type: "faceDownReturned", seat: 1, card: c("HJ") },
      { type: "placingCardStarted", seat: 1 },
    ]);
    assert.equal(ended.state.phase.type, "placingCard");
    const match = matchOf(ended.state);
    assert.equal(match.faceDown, null);
    assert.deepEqual(match.hands[1], cards("H9 DA D10 CK CQ S8 S7 HJ"));

    // The holder may switch suit.
    const played = run(ended, [place(1, c("DA"))]);
    assert.deepEqual(played.events, [
      { type: "cardPlaced", seat: 1, card: c("DA") },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 21,
          trump: { type: "hidden", suit: "diamonds" },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
    assert.deepEqual(matchOf(played.state).faceDown, {
      owner: 1,
      card: c("DA"),
    });
  });

  it("a different winner gets the old card returned to its owner and places any card", () => {
    const ended = run(secondAuction(16), [
      pass(1),
      bid(2, 22),
      pass(3),
      pass(0),
      pass(1),
    ]);
    assert.deepEqual(ended.events, [
      { type: "passed", seat: 1 },
      { type: "faceDownReturned", seat: 1, card: c("HJ") },
      { type: "placingCardStarted", seat: 2 },
    ]);
    assert.deepEqual(matchOf(ended.state).hands[1]?.at(-1), c("HJ"));
    assert.deepEqual(rejection(ended.state, place(1, c("HJ"))), {
      code: "notYourTurn",
      details: { expected: 2, actual: 1 },
    });

    const played = run(ended, [place(2, c("CA"))]);
    assert.deepEqual(played.events, [
      { type: "cardPlaced", seat: 2, card: c("CA") },
      {
        type: "auctionEnded",
        contract: {
          bidder: 2,
          team: "A",
          amount: 22,
          trump: { type: "hidden", suit: "clubs" },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });

  it("a new bid then a double ends N−1 passes later, and the placed contract is doubled", () => {
    const ended = run(secondAuction(16), [
      pass(1),
      bid(2, 21),
      double(3),
      pass(0),
      pass(1),
    ]);
    assert.equal(ended.state.phase.type, "auction");
    // design §6.3: the first-auction contract stands (e.g. for a host restart
    // summary) during the second auction after a new bid and a double...
    const firstContract = {
      bidder: 1,
      team: "B",
      amount: 16,
      trump: { type: "hidden", suit: "hearts" },
      style: null,
      multiplier: 1,
      forced: false,
    } as const;
    assert.deepEqual(matchOf(ended.state).contract, firstContract);

    const placing = run(ended, [pass(2)]);
    assert.deepEqual(placing.events, [
      { type: "passed", seat: 2 },
      { type: "faceDownReturned", seat: 1, card: c("HJ") },
      { type: "placingCardStarted", seat: 2 },
    ]);
    // ...and during the placement after it.
    assert.deepEqual(matchOf(placing.state).contract, firstContract);

    const played = run(placing, [place(2, c("CA"))]);
    assert.deepEqual(played.events.slice(1), [
      {
        type: "auctionEnded",
        contract: {
          bidder: 2,
          team: "A",
          amount: 21,
          trump: { type: "hidden", suit: "clubs" },
          style: null,
          multiplier: 2,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });

  it("a new winner over a carried forced 14 places a card with nothing to return", () => {
    const ended = run(start(), [
      deal(NORMAL_DECK),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
      pass(1),
      bid(2, 21),
      pass(3),
      pass(0),
      pass(1),
    ]);
    assert.deepEqual(ended.events, [
      { type: "passed", seat: 1 },
      { type: "placingCardStarted", seat: 2 },
    ]);
    const played = run(ended, [place(2, c("DJ"))]);
    assert.deepEqual(played.events.slice(1, 2), [
      {
        type: "auctionEnded",
        contract: {
          bidder: 2,
          team: "A",
          amount: 21,
          trump: { type: "hidden", suit: "diamonds" },
          style: null,
          multiplier: 1,
          forced: false,
        },
      },
    ]);
  });

  it("a redouble after a new bid ends the auction and still requires placement", () => {
    const ended = run(
      secondAuction(16, { config: config28({ startingTokens: 20 }) }),
      [pass(1), bid(2, 21), double(3), redouble(0)],
    );
    assert.deepEqual(ended.events, [
      { type: "redoubled", seat: 0 },
      { type: "faceDownReturned", seat: 1, card: c("HJ") },
      { type: "placingCardStarted", seat: 2 },
    ]);
    const played = run(ended, [place(2, c("CA"))]);
    assert.equal(
      played.events[1]?.type === "auctionEnded" &&
        played.events[1].contract.multiplier,
      4,
    );
    assert.equal(played.state.phase.type, "play");
  });
});

describe("28 second-deal redeal check", () => {
  it("counts the face-down card toward its owner's points and team Jacks", () => {
    const placed = run(start(), [
      deal(JACK_DECK),
      bid(1, 14),
      pass(2),
      pass(3),
      pass(0),
      place(1, c("HJ")),
    ]);
    assert.equal(placed.events.at(-1)?.type, "auctionStarted");
    const match = matchOf(placed.state);
    // Without the face-down card team B would hold no Jack and seat 1 no points.
    assert.deepEqual(redealReason(match.hands, 1), {
      type: "teamWithoutJack",
      team: "B",
    });
    assert.equal(
      redealReason(completeHoldings(match.hands, match.faceDown), 1),
      null,
    );
  });

  it("redeals after all eight cards: returns the card, cancels both auctions, and logs public facts", () => {
    const ended = run(start(), [
      deal(LOW_DECK),
      bid(1, 15),
      double(2),
      pass(3),
      pass(0),
      pass(1),
    ]);
    // The first-stage cards alone already hold a low hand; the check waited.
    assert.equal(ended.state.phase.type, "placingCard");

    const summary = {
      dealer: 0,
      contract: {
        bidder: 1,
        team: "B",
        amount: 15,
        trump: { type: "hidden" },
        style: null,
        multiplier: 2,
        forced: false,
      },
      points: { A: 0, B: 0 },
      tokensMoved: null,
      tokens: { A: 10, B: 10 },
      outcome: {
        type: "redealt",
        reason: { type: "lowHand", seat: 3, points: 0 },
      },
    } as const;
    const redealt = run(ended, [place(1, c("HJ"))]);
    assert.deepEqual(redealt.events.slice(2), [
      {
        type: "dealt",
        stage: "second",
        hands: [
          JACK_SECOND[0],
          cards("DQ CK CQ H9"),
          JACK_SECOND[2],
          JACK_SECOND[3],
        ],
        undealt: null,
      },
      { type: "redealt", reason: { type: "lowHand", seat: 3, points: 0 } },
      { type: "faceDownReturned", seat: 1, card: c("HJ") },
      { type: "matchEnded", summary },
    ]);
    assert.deepEqual(redealt.state, {
      ...ended.state,
      matchLog: [summary],
      phase: { type: "awaitingDeal", reason: "redeal" },
    });
    assert.ok(!JSON.stringify(redealt.state.matchLog).includes("hearts"));

    // The same dealer deals again into a fresh first auction.
    const again = run(redealt, [deal(NORMAL_DECK)]);
    assert.equal(again.state.dealer, 0);
    assert.equal(auctionOf(again.state).stage, "28-first");
  });

  it("runs the redeal check before a redoubled first auction skips to play", () => {
    const redealt = run(start(), [
      deal(LOW_DECK),
      bid(1, 15),
      double(2),
      redouble(3),
      place(1, c("HJ")),
    ]);
    assert.deepEqual(
      redealt.events.map((event) => event.type),
      [
        "cardPlaced",
        "auctionEnded",
        "dealt",
        "redealt",
        "faceDownReturned",
        "matchEnded",
      ],
    );
    assert.equal(redealt.state.matchLog[0]?.contract?.multiplier, 4);
    assert.equal(redealt.state.phase.type, "awaitingDeal");
  });

  it("a forced 14 redeal logs no trump and returns no card", () => {
    const redealt = run(start(), [
      deal(LOW_DECK),
      pass(1),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.deepEqual(
      redealt.events.map((event) => event.type),
      ["passed", "forcedBid", "auctionEnded", "dealt", "redealt", "matchEnded"],
    );
    assert.deepEqual(redealt.state.matchLog[0]?.contract, {
      bidder: 1,
      team: "B",
      amount: 14,
      trump: { type: "noTrump" },
      style: null,
      multiplier: 1,
      forced: true,
    });
    assert.equal(redealt.state.phase.type, "awaitingDeal");
  });
});

describe("placeCard rejections", () => {
  it("accepts only the winner placing a card from its own hand", () => {
    const { state } = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 16),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.deepEqual(rejection(state, place(2, c("DJ"))), {
      code: "notYourTurn",
      details: { expected: 1, actual: 2 },
    });
    // Another seat's card, the seat's own undealt card, a wrong copy, and
    // malformed cards are all not in hand.
    for (const card of [
      c("SJ"),
      c("CK"),
      { ...c("HJ"), copy: 2 },
      null,
      "HJ",
      {},
    ]) {
      assert.deepEqual(
        rejection(state, {
          type: "placeCard",
          card,
          source: seat(1),
        } as unknown as EngineAction),
        { code: "cardNotInHand", details: {} },
      );
    }

    const inAuction = run(start(), [deal(NORMAL_DECK)]).state;
    assert.equal(
      rejection(inAuction, place(1, c("HJ")))?.code,
      "actionNotAllowed",
    );
    assert.equal(decidePlaceCard(inAuction, place(1, c("HJ"))).ok, false);
    assert.deepEqual(decidePlaceCard(state, pass(1)), {
      ok: false,
      code: "actionNotAllowed",
      details: { action: "pass" },
    });
  });
});

describe("faceDownIsForced", () => {
  function playState(): EngineState {
    return run(start(), [
      deal(NORMAL_DECK),
      bid(1, 18),
      double(2),
      redouble(3),
      place(1, c("HJ")),
    ]).state;
  }

  function withMatch(
    state: EngineState,
    update: (match: MatchState) => MatchState,
  ): EngineState {
    if (state.phase.type !== "play") {
      throw new Error("expected play");
    }
    return {
      ...state,
      phase: { type: "play", match: update(state.phase.match) },
    };
  }

  const heartsLedTo1 = (match: MatchState, hand: Card[]): MatchState => ({
    ...match,
    hands: match.hands.map((held, index) => (index === 1 ? hand : held)),
    currentRound: {
      leader: 0,
      plays: [{ seat: 0, card: c("H10"), fromFaceDown: false }],
      turn: 1,
      leadSuit: "hearts",
      revealedThisRound: false,
      revealAskedBy: null,
    },
  });

  it("is true only for the bidder's turn when the hidden suit is led with none in hand, or the card is its last", () => {
    const state = playState();
    // Seat 1 leads the first round and still holds other cards.
    assert.equal(faceDownIsForced(state, 1), false);

    const noHearts = cards("DA D10 CK");
    assert.equal(
      faceDownIsForced(
        withMatch(state, (match) => heartsLedTo1(match, noHearts)),
        1,
      ),
      true,
    );
    assert.equal(
      faceDownIsForced(
        withMatch(state, (match) => heartsLedTo1(match, cards("H9 DA"))),
        1,
      ),
      false,
    );
    assert.equal(
      faceDownIsForced(
        withMatch(state, (match) => ({
          ...heartsLedTo1(match, noHearts),
          revealedInRound: 0,
        })),
        1,
      ),
      false,
    );
    assert.equal(
      faceDownIsForced(
        withMatch(state, (match) => ({
          ...match,
          hands: match.hands.map((held, index) => (index === 1 ? [] : held)),
        })),
        1,
      ),
      true,
    );
    assert.equal(faceDownIsForced(state, 2), false);
    assert.equal(
      faceDownIsForced(run(start(), [deal(NORMAL_DECK)]).state, 1),
      false,
    );
  });
});

describe("28 invariants", () => {
  function invariantCode(state: EngineState): string | null {
    try {
      assertEngineInvariants(state);
      return null;
    } catch (error) {
      assert.ok(error instanceof EngineInvariantError);
      return error.code;
    }
  }

  it("ties a standing carried bid to its face-down card, and a hidden trump in play to the bidder's card", () => {
    const { state } = secondAuction(16);
    if (state.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    const match = state.phase.match;
    assert.equal(
      invariantCode({
        ...state,
        phase: {
          type: "auction",
          match: {
            ...match,
            hands: match.hands.map((held, index) =>
              index === 2 ? [...held, c("HJ")] : held,
            ),
            faceDown: null,
          },
        },
      }),
      "invalidAuctionState",
    );
    assert.equal(
      invariantCode({
        ...state,
        phase: {
          type: "auction",
          match: {
            ...match,
            contract: match.contract && { ...match.contract, amount: 17 },
          },
        },
      }),
      "invalidAuctionState",
    );

    // A redoubled first auction has no carried bid to check first.
    const played = run(start(), [
      deal(NORMAL_DECK),
      bid(1, 18),
      double(2),
      redouble(3),
      place(1, c("HJ")),
    ]).state;
    if (played.phase.type !== "play") {
      throw new Error("unreachable");
    }
    const playMatch = played.phase.match;
    assert.equal(
      invariantCode({
        ...played,
        phase: {
          type: "play",
          match: {
            ...playMatch,
            hands: playMatch.hands.map((held, index) =>
              index === 1 ? [...held, c("HJ")] : held,
            ),
            faceDown: null,
          },
        },
      }),
      "phaseMatchMismatch",
    );
  });
});

describe("28 replay and immutability", () => {
  it("replaying every event from newSession reproduces the final state, and frozen inputs are never mutated", () => {
    const scenarios: EngineAction[][] = [
      // Doubled first auction, carried double cancelled by a new winner.
      [
        deal(NORMAL_DECK),
        bid(1, 16),
        double(2),
        pass(3),
        pass(0),
        pass(1),
        place(1, c("HJ")),
        pass(1),
        bid(2, 21),
        pass(3),
        pass(0),
        pass(1),
        place(2, c("CA")),
      ],
      // Forced 14 carried through an all-pass second auction.
      [
        deal(NORMAL_DECK),
        pass(1),
        pass(2),
        pass(3),
        pass(0),
        pass(1),
        pass(2),
        pass(3),
        pass(0),
      ],
      // Second-deal redeal, then a fresh deal.
      [
        deal(LOW_DECK),
        bid(1, 14),
        pass(2),
        pass(3),
        pass(0),
        place(1, c("HJ")),
        deal(NORMAL_DECK),
      ],
    ];

    for (const actions of scenarios) {
      const started = newSession(deepFreeze(config28()), 0);
      assert.equal(started.ok, true);
      if (!started.ok) {
        throw new Error("unreachable");
      }
      const initial = deepFreeze(started.state);
      let state = initial;
      const log: EngineEvent[] = [];
      for (const action of actions) {
        const before = JSON.stringify(state);
        const result = act(state, deepFreeze(structuredClone(action)));
        assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result));
        if (!result.ok) {
          throw new Error("unreachable");
        }
        assert.equal(JSON.stringify(state), before);
        assertEngineInvariants(result.state);
        assertCardsConserved(result.state);
        log.push(...deepFreeze(result.events));
        state = deepFreeze(result.state);
      }

      const replayed = log.reduce(
        (current, event) => evolve(current, event),
        initial,
      );
      assert.equal(JSON.stringify(replayed), JSON.stringify(state));
      assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    }
  });
});
