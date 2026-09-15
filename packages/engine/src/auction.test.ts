import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import {
  bidRange,
  contractMultiplier,
  decideAuctionAction,
  evolveAuctionEnded,
  evolvePlayStarted,
} from "./auction.js";
import { buildDeck } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent } from "./events.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import type { AuctionState, EngineState } from "./state.js";
import { deepFreeze } from "./test-helpers.js";
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

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;

/** Starts a session and deals into an active 56 auction (no redeal, config56's natural deck order). */
function dealtAuction(
  config: EngineConfig,
  dealer: number,
): { state: EngineState } {
  const start = newSession(config, dealer);
  assert.equal(start.ok, true);
  if (!start.ok) {
    throw new Error("unreachable");
  }
  const deck = buildDeck(config);
  const result = act(start.state, {
    type: "deal",
    source: system,
    deck,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  assert.equal(result.state.phase.type, "auction");
  return { state: result.state };
}

function bid(
  seatNumber: number,
  amount: number,
  suit: string,
  style?: string,
): EngineAction {
  return {
    type: "bid",
    amount,
    suit: suit as never,
    ...(style === undefined ? {} : { style: style as never }),
    source: seat(seatNumber),
  } as EngineAction;
}

function pass(seatNumber: number): EngineAction {
  return { type: "pass", source: seat(seatNumber) };
}

function double(seatNumber: number): EngineAction {
  return { type: "double", source: seat(seatNumber) };
}

function redouble(seatNumber: number): EngineAction {
  return { type: "redouble", source: seat(seatNumber) };
}

/** Applies each action in order via `act`, asserting acceptance, invariants, and replay equality. */
function run(state: EngineState, actions: EngineAction[]): EngineState {
  let current = state;
  for (const action of actions) {
    const result = act(current, action);
    assert.equal(
      result.ok,
      true,
      `expected ${action.type} to be accepted: ${JSON.stringify(!result.ok ? result : {})}`,
    );
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const replayed = result.events.reduce(
      (acc, event) => evolve(acc, event),
      current,
    );
    assert.deepEqual(replayed, result.state);
    assertEngineInvariants(result.state);
    current = result.state;
  }
  return current;
}

function auctionOf(state: EngineState): AuctionState {
  if (state.phase.type !== "auction" || state.phase.match.auction === null) {
    throw new Error("expected an active auction");
  }
  return state.phase.match.auction;
}

describe("auction: turn cycles and forced bid", () => {
  it("4/6/8 players: N opening passes force 28 no trump on the dealer's right", () => {
    for (const playerCount of [4, 6, 8] as const) {
      const config = config56({
        playerCount,
        includeEightsAndSevens: playerCount === 8,
      });
      const { state } = dealtAuction(config, 2);
      const firstTurn = (2 + 1) % playerCount;

      const passes = Array.from({ length: playerCount }, (_, i) =>
        pass((firstTurn + i) % playerCount),
      );
      const finalResult = act(
        run(state, passes.slice(0, -1)),
        passes[passes.length - 1] as EngineAction,
      );
      assert.equal(finalResult.ok, true);
      if (!finalResult.ok) {
        throw new Error("unreachable");
      }

      assert.deepEqual(finalResult.events.slice(-3), [
        { type: "forcedBid", seat: firstTurn, amount: 28 },
        {
          type: "auctionEnded",
          contract: {
            bidder: firstTurn,
            team: firstTurn % 2 === 0 ? "A" : "B",
            amount: 28,
            trump: { type: "noTrump" },
            style: null,
            multiplier: 1,
            forced: true,
          },
        },
        { type: "playStarted", leader: firstTurn },
      ]);
      assert.equal(finalResult.state.phase.type, "play");
      if (finalResult.state.phase.type !== "play") {
        throw new Error("unreachable");
      }
      assert.deepEqual(finalResult.state.phase.match.contract, {
        bidder: firstTurn,
        team: firstTurn % 2 === 0 ? "A" : "B",
        amount: 28,
        trump: { type: "noTrump" },
        style: null,
        multiplier: 1,
        forced: true,
      });
      assert.deepEqual(finalResult.state.phase.match.currentRound, {
        leader: firstTurn,
        plays: [],
        turn: firstTurn,
        leadSuit: null,
        revealedThisRound: false,
        revealAskedBy: null,
      });
      assertEngineInvariants(finalResult.state);
    }
  });

  it("a pass affects only that turn: a seat that passed can bid on a later turn", () => {
    const { state } = dealtAuction(config56(), 0);
    // Dealer 0: first turn is seat 1.
    const afterOpen = run(state, [
      pass(1),
      bid(2, 30, "spades", "numberFirst"),
      pass(3),
    ]);
    assert.equal(auctionOf(afterOpen).turn, 0);
    const afterDealerPass = run(afterOpen, [pass(0)]);
    // Seat 1 passed earlier; it is now their turn again and they may bid.
    assert.equal(auctionOf(afterDealerPass).turn, 1);
    const afterRebid = run(afterDealerPass, [
      bid(1, 32, "hearts", "suitFirst"),
    ]);
    assert.equal(auctionOf(afterRebid).highBid?.seat, 1);
    assert.equal(auctionOf(afterRebid).highBid?.amount, 32);
  });

  it("partners and the same bidder may overbid at any time", () => {
    const { state } = dealtAuction(config56(), 0);
    // Seats: 0/2 team A, 1/3 team B. Seat1 bids, seat2 passes, seat3 (seat1's
    // partner) raises, seat0 passes, seat1 (the original bidder) raises again.
    const afterPartnerRaise = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
      bid(3, 32, "clubs", "suitFirst"),
      pass(0),
    ]);
    assert.equal(auctionOf(afterPartnerRaise).turn, 1);
    const afterSelfRaise = run(afterPartnerRaise, [
      bid(1, 34, "diamonds", "numberFirst"),
    ]);
    assert.equal(auctionOf(afterSelfRaise).highBid?.seat, 1);
    assert.equal(auctionOf(afterSelfRaise).highBid?.amount, 34);
    assert.equal(auctionOf(afterSelfRaise).consecutivePasses, 0);
  });

  it("6/8 players: a normal end needs exactly N-1 passes after a bid, wrapping turns correctly", () => {
    for (const playerCount of [6, 8] as const) {
      const config = config56({
        playerCount,
        includeEightsAndSevens: playerCount === 8,
      });
      const dealer = 2;
      const firstTurn = (dealer + 1) % playerCount;
      const { state } = dealtAuction(config, dealer);
      const afterBid = run(state, [
        bid(firstTurn, 30, "spades", "numberFirst"),
      ]);
      assert.equal(auctionOf(afterBid).turn, (firstTurn + 1) % playerCount);

      const passSeats = Array.from(
        { length: playerCount - 1 },
        (_, i) => (firstTurn + 1 + i) % playerCount,
      );
      const beforeLast = run(afterBid, passSeats.slice(0, -1).map(pass));
      assert.equal(beforeLast.phase.type, "auction"); // one pass short: not over yet
      assert.equal(auctionOf(beforeLast).turn, passSeats[passSeats.length - 1]);

      const finalResult = act(
        beforeLast,
        pass(passSeats[passSeats.length - 1] as number),
      );
      assert.equal(finalResult.ok, true);
      if (!finalResult.ok) {
        throw new Error("unreachable");
      }
      assert.equal(finalResult.state.phase.type, "play");
      if (finalResult.state.phase.type !== "play") {
        throw new Error("unreachable");
      }
      assert.equal(finalResult.state.phase.match.contract?.bidder, firstTurn);
      assert.equal(finalResult.state.phase.match.contract?.multiplier, 1);
    }
  });

  it("6/8 players: a doubled end needs exactly N-1 passes after the double, wrapping turns correctly", () => {
    for (const playerCount of [6, 8] as const) {
      const config = config56({
        playerCount,
        includeEightsAndSevens: playerCount === 8,
      });
      const dealer = 2;
      const firstTurn = (dealer + 1) % playerCount;
      const { state } = dealtAuction(config, dealer);
      const afterBid = run(state, [
        bid(firstTurn, 30, "spades", "numberFirst"),
      ]);
      // The next seat is on the opposing team (adjacent seats alternate
      // team by parity) and doubles on their own turn.
      const doublerSeat = (firstTurn + 1) % playerCount;
      const afterDouble = run(afterBid, [double(doublerSeat)]);
      assert.equal(
        auctionOf(afterDouble).turn,
        (doublerSeat + 1) % playerCount,
      );

      const passSeats = Array.from(
        { length: playerCount - 1 },
        (_, i) => (doublerSeat + 1 + i) % playerCount,
      );
      const beforeLast = run(afterDouble, passSeats.slice(0, -1).map(pass));
      assert.equal(beforeLast.phase.type, "auction"); // one pass short: not over yet
      assert.equal(auctionOf(beforeLast).turn, passSeats[passSeats.length - 1]);

      const finalResult = act(
        beforeLast,
        pass(passSeats[passSeats.length - 1] as number),
      );
      assert.equal(finalResult.ok, true);
      if (!finalResult.ok) {
        throw new Error("unreachable");
      }
      assert.equal(finalResult.state.phase.type, "play");
      if (finalResult.state.phase.type !== "play") {
        throw new Error("unreachable");
      }
      assert.equal(finalResult.state.phase.match.contract?.bidder, firstTurn);
      assert.equal(finalResult.state.phase.match.contract?.multiplier, 2);
    }
  });

  it("the leader is the dealer's right, not necessarily the bidder", () => {
    const { state } = dealtAuction(config56(), 0);
    // Dealer 0: turn order 1, 2, 3, 0. Seat1 passes, seat2 bids, then N-1=3
    // passes (3, 0, 1) end the auction.
    const beforeFinal = run(state, [
      pass(1),
      bid(2, 30, "spades", "numberFirst"),
      pass(3),
      pass(0),
    ]);
    const result = act(beforeFinal, pass(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.equal(result.state.phase.type, "play");
    if (result.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    assert.equal(result.state.phase.match.contract?.bidder, 2);
    const playStarted = result.events.find(
      (event) => event.type === "playStarted",
    );
    assert.ok(playStarted?.type === "playStarted");
    assert.equal(playStarted.leader, 1);
  });

  it("a double resets consecutive passes, requiring a fresh N-1 count to end", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
      pass(3),
      double(0),
    ]);
    assert.equal(auctionOf(afterDouble).consecutivePasses, 0);
    assert.equal(auctionOf(afterDouble).turn, 1);

    const stillRunning = run(afterDouble, [pass(1), pass(2)]);
    assert.equal(stillRunning.phase.type, "auction");
    assert.equal(auctionOf(stillRunning).consecutivePasses, 2);

    const ended = act(stillRunning, pass(3));
    assert.equal(ended.ok, true);
    if (!ended.ok) {
      throw new Error("unreachable");
    }
    assert.equal(ended.state.phase.type, "play");
    if (ended.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    assert.equal(ended.state.phase.match.contract?.multiplier, 2);
    assert.equal(ended.state.phase.match.contract?.bidder, 1);
  });
});

describe("auction: bid validation", () => {
  it("accepts the minimum (28) and maximum (56) bids", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterMin = run(state, [bid(1, 28, "spades", "numberFirst")]);
    assert.equal(auctionOf(afterMin).highBid?.amount, 28);

    const { state: maxState } = dealtAuction(config56(), 0);
    const afterMax = run(maxState, [bid(1, 56, "noTrump")]);
    assert.equal(auctionOf(afterMax).highBid?.amount, 56);
    assert.equal(bidRange(afterMax, 2), null); // nothing higher than 56 exists
  });

  it("rejects out-of-range amounts", () => {
    const { state } = dealtAuction(config56(), 0);
    assert.deepEqual(decide(state, bid(1, 27, "spades", "numberFirst")), {
      ok: false,
      code: "bidOutOfRange",
      details: { minimum: 28, maximum: 56, amount: 27 },
    });
    assert.deepEqual(decide(state, bid(1, 57, "spades", "numberFirst")), {
      ok: false,
      code: "bidOutOfRange",
      details: { minimum: 28, maximum: 56, amount: 57 },
    });
  });

  it("rejects malformed amounts with JSON-safe details and no retained value", () => {
    const { state } = dealtAuction(config56(), 0);
    const malformedAmounts: readonly unknown[] = [
      30n,
      Symbol("amount"),
      { value: 30 },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const amount of malformedAmounts) {
      const rejection = decide(state, {
        type: "bid",
        amount,
        suit: "spades",
        style: "numberFirst",
        source: seat(1),
      } as unknown as EngineAction);
      assert.deepEqual(rejection, {
        ok: false,
        code: "bidOutOfRange",
        details: { reason: "invalidAmount", minimum: 28, maximum: 56 },
      });
      assert.doesNotThrow(() => JSON.stringify(rejection));
    }
  });

  it("rejects a bid not strictly higher than the current highest", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterBid = run(state, [bid(1, 32, "spades", "numberFirst")]);
    const rejection = decide(afterBid, bid(2, 32, "hearts", "numberFirst"));
    assert.equal(rejection.ok, false);
    assert.equal(!rejection.ok && rejection.code, "bidTooLow");
    const lower = decide(afterBid, bid(2, 30, "hearts", "numberFirst"));
    assert.equal(!lower.ok && lower.code, "bidTooLow");
  });

  it("requires a suit or no trump, and a style only for suit bids", () => {
    const { state } = dealtAuction(config56(), 0);
    const missingSuit = decide(state, {
      type: "bid",
      amount: 30,
      source: seat(1),
    } as EngineAction);
    assert.equal(!missingSuit.ok && missingSuit.code, "invalidBid");
    assert.deepEqual(!missingSuit.ok ? missingSuit.details : undefined, {
      reason: "missingSuit",
    });

    const missingStyle = decide(state, {
      type: "bid",
      amount: 30,
      suit: "spades",
      source: seat(1),
    } as EngineAction);
    assert.equal(!missingStyle.ok && missingStyle.code, "invalidBid");
    assert.deepEqual(!missingStyle.ok ? missingStyle.details : undefined, {
      reason: "missingStyle",
    });

    const unexpectedStyle = decide(state, {
      type: "bid",
      amount: 30,
      suit: "noTrump",
      style: "numberFirst",
      source: seat(1),
    } as EngineAction);
    assert.equal(!unexpectedStyle.ok && unexpectedStyle.code, "invalidBid");
    assert.deepEqual(
      !unexpectedStyle.ok ? unexpectedStyle.details : undefined,
      { reason: "unexpectedStyle" },
    );

    const validNoTrump = decide(state, bid(1, 30, "noTrump"));
    assert.equal(validNoTrump.ok, true);
  });

  it("rejects an invalid suit string or an invalid style string with invalidBid", () => {
    const { state } = dealtAuction(config56(), 0);
    const invalidSuit = decide(state, {
      type: "bid",
      amount: 30,
      suit: "wands",
      style: "numberFirst",
      source: seat(1),
    } as unknown as EngineAction);
    assert.equal(!invalidSuit.ok && invalidSuit.code, "invalidBid");
    assert.deepEqual(!invalidSuit.ok ? invalidSuit.details : undefined, {
      reason: "invalidSuit",
    });

    const invalidStyle = decide(state, {
      type: "bid",
      amount: 30,
      suit: "spades",
      style: "sideways",
      source: seat(1),
    } as unknown as EngineAction);
    assert.equal(!invalidStyle.ok && invalidStyle.code, "invalidBid");
    assert.deepEqual(!invalidStyle.ok ? invalidStyle.details : undefined, {
      reason: "invalidStyle",
    });
  });

  it("rejects a bid out of turn", () => {
    const { state } = dealtAuction(config56(), 0);
    const rejection = decide(state, bid(2, 30, "spades", "numberFirst"));
    assert.equal(!rejection.ok && rejection.code, "notYourTurn");
  });

  it("enforces the bidding team's loss-stake affordability", () => {
    // lossStake for 40-47 is 3; seat1's team (B) has exactly 3 tokens.
    const config = config56({ startingTokens: 3 });
    const { state } = dealtAuction(config, 0);
    const okBid = decide(state, bid(1, 40, "spades", "numberFirst"));
    assert.equal(okBid.ok, true);

    const tooExpensive = config56({ startingTokens: 2 });
    const { state: poorState } = dealtAuction(tooExpensive, 0);
    const rejected = decide(poorState, bid(1, 40, "spades", "numberFirst"));
    assert.equal(!rejected.ok && rejected.code, "cannotAfford");
    // The cheaper 28-39 tier (lossStake 2) is still affordable.
    assert.equal(
      decide(poorState, bid(1, 28, "spades", "numberFirst")).ok,
      true,
    );
  });
});

describe("bidRange", () => {
  it("reflects the minimum/maximum for the seat on turn, after affordability", () => {
    const { state } = dealtAuction(config56(), 0);
    assert.deepEqual(bidRange(state, 1), { minimum: 28, maximum: 56 });
    assert.equal(bidRange(state, 2), null); // not seat 2's turn

    const afterBid = run(state, [bid(1, 30, "spades", "numberFirst")]);
    assert.deepEqual(bidRange(afterBid, 2), { minimum: 31, maximum: 56 });
  });

  it("caps the maximum at what the team can afford", () => {
    // lossStake tiers: 28-39 -> 2, 40-47 -> 3, 48-56 -> 4. 3 tokens afford
    // up to the 40-47 tier but not 48-56.
    const config = config56({ startingTokens: 3 });
    const { state } = dealtAuction(config, 0);
    assert.deepEqual(bidRange(state, 1), { minimum: 28, maximum: 47 });
  });

  it("returns null once the team can't afford even the minimum", () => {
    const config = config56({ startingTokens: 1 });
    const { state } = dealtAuction(config, 0);
    assert.equal(bidRange(state, 1), null);
  });
});

describe("auction: double and redouble", () => {
  it("allows a turn-bound defender double at any amount, including 56", () => {
    const { state } = dealtAuction(config56(), 0);
    // After seat1's bid it is seat2's turn (team A, opposing the bidder).
    const afterMax = run(state, [bid(1, 56, "noTrump")]);
    const afterDouble = run(afterMax, [double(2)]);
    assert.equal(auctionOf(afterDouble).doubledBy, 2);
    assert.equal(auctionOf(afterDouble).consecutivePasses, 0);
  });

  it("rejects a double by the bidding team, and a repeat double by the doubler's partner", () => {
    const { state } = dealtAuction(config56(), 0);
    // After bid(1,...) + pass(2) it is seat3's turn — the bidder's own team.
    const afterOwnTeamTurn = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
    ]);
    const ownTeam = decide(afterOwnTeamTurn, double(3));
    assert.equal(!ownTeam.ok && ownTeam.code, "doubleNotAllowed");
    assert.deepEqual(!ownTeam.ok ? ownTeam.details : undefined, {
      reason: "ownTeam",
    });

    // A repeat double: seat2 doubles seat1's bid; seat0 — seat2's partner,
    // also on the defending team — tries to double again on their own turn.
    const afterFirstDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
      pass(3),
    ]);
    const repeat = decide(afterFirstDouble, double(0));
    assert.equal(!repeat.ok && repeat.code, "doubleNotAllowed");
    assert.deepEqual(!repeat.ok ? repeat.details : undefined, {
      reason: "noDoublableBid",
    });
  });

  it("enforces the doubling team's 2x win-stake affordability", () => {
    // 40-47's winStake is 2, so 2x = 4; its lossStake is 3, so the setup bid
    // itself is affordable at either token level below.
    const config = config56({ startingTokens: 4 });
    const { state } = dealtAuction(config, 0);
    const afterBid = run(state, [bid(1, 40, "spades", "numberFirst")]);
    assert.equal(decide(afterBid, double(2)).ok, true);

    const poor = config56({ startingTokens: 3 });
    const { state: poorState } = dealtAuction(poor, 0);
    const afterPoorBid = run(poorState, [bid(1, 40, "spades", "numberFirst")]);
    const rejected = decide(afterPoorBid, double(2));
    assert.equal(!rejected.ok && rejected.code, "cannotAfford");
  });

  it("a new bid cancels an active double", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    assert.equal(auctionOf(afterDouble).doubledBy, 2);

    const result = act(afterDouble, bid(3, 32, "clubs", "suitFirst"));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.events, [
      {
        type: "bidMade",
        seat: 3,
        amount: 32,
        suit: "clubs",
        style: "suitFirst",
      },
      { type: "doubleCancelled" },
    ]);
    assert.equal(auctionOf(result.state).doubledBy, null);
    assertEngineInvariants(result.state);
  });

  it("ends a doubled auction after N-1 passes back to the doubler, at multiplier 2", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    // 4 players: N-1 = 3 passes needed after the double (seats 3, 0, 1).
    const ended = run(afterDouble, [pass(3), pass(0)]);
    assert.equal(ended.phase.type, "auction");
    const finalPass = act(ended, pass(1));
    assert.equal(finalPass.ok, true);
    if (!finalPass.ok) {
      throw new Error("unreachable");
    }
    assert.equal(finalPass.state.phase.type, "play");
    if (finalPass.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    assert.equal(finalPass.state.phase.match.contract?.multiplier, 2);
    assert.equal(finalPass.state.phase.match.contract?.bidder, 1);
    assertEngineInvariants(finalPass.state);
  });

  it("allows any doubled-team member to redouble out of turn, ending the auction at once", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    // It is seat 3's turn, but seat 1 (doubled team, out of turn) redoubles.
    assert.equal(auctionOf(afterDouble).turn, 3);
    const result = act(afterDouble, redouble(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.events, [
      { type: "redoubled", seat: 1 },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 30,
          trump: { type: "suit", suit: "spades" },
          style: "numberFirst",
          multiplier: 4,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
    assert.equal(result.state.phase.type, "play");
    assertEngineInvariants(result.state);
  });

  it("rejects redouble with no active double, the wrong team, or unaffordability", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterBid = run(state, [bid(1, 30, "spades", "numberFirst")]);
    const noDouble = decide(afterBid, redouble(1));
    assert.equal(!noDouble.ok && noDouble.code, "noDoubleActive");

    // After bid(1,...) it is seat2's turn (team A, opposing the bidder).
    const afterDouble = run(afterBid, [double(2)]);
    const wrongTeam = decide(afterDouble, redouble(2)); // seat2 is the doubler's own team, not the doubled team
    assert.equal(!wrongTeam.ok && wrongTeam.code, "doubleNotAllowed");

    const afterRedouble = run(afterDouble, [redouble(1)]);
    assert.equal(afterRedouble.phase.type, "play");

    // lossStake for 28-39 is 2, so 4x = 8.
    const poor = config56({ startingTokens: 7 });
    const { state: poorState } = dealtAuction(poor, 0);
    const afterPoorSetup = run(poorState, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    const cannotAfford = decide(afterPoorSetup, redouble(1));
    assert.equal(!cannotAfford.ok && cannotAfford.code, "cannotAfford");
  });

  it("accepts redouble at exactly 4x the loss stake, by the bidder's partner, after passes following the double", () => {
    // lossStake for 28-39 is 2, so 4x = 8.
    const config = config56({ startingTokens: 8 });
    const { state } = dealtAuction(config, 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    // A pass following the double, before the out-of-turn redouble.
    const afterPass = run(afterDouble, [pass(3)]);
    // seat1's partner is seat3 (team B); the redouble comes from the
    // partner, not the bidder, and out of turn (it is seat0's turn).
    assert.equal(auctionOf(afterPass).turn, 0);
    const result = act(afterPass, redouble(3));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.equal(result.state.phase.type, "play");
    if (result.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    assert.equal(result.state.phase.match.contract?.multiplier, 4);
    assert.equal(result.state.phase.match.contract?.bidder, 1);
    assertEngineInvariants(result.state);
  });
});

describe("auction: exact event ordering at the end of the auction", () => {
  it("a normal 56 end emits passed, auctionEnded(contract), playStarted in order", () => {
    const { state } = dealtAuction(config56(), 0);
    const beforeFinal = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
      pass(3),
    ]);
    const result = act(beforeFinal, pass(0));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.events, [
      { type: "passed", seat: 0 },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 30,
          trump: { type: "suit", suit: "spades" },
          style: "numberFirst",
          multiplier: 1,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });

  it("a doubled end emits passed, auctionEnded(contract), playStarted in order, at multiplier 2", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterDouble = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
    ]);
    const beforeFinal = run(afterDouble, [pass(3), pass(0)]);
    const result = act(beforeFinal, pass(1));
    assert.equal(result.ok, true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    assert.deepEqual(result.events, [
      { type: "passed", seat: 1 },
      {
        type: "auctionEnded",
        contract: {
          bidder: 1,
          team: "B",
          amount: 30,
          trump: { type: "suit", suit: "spades" },
          style: "numberFirst",
          multiplier: 2,
          forced: false,
        },
      },
      { type: "playStarted", leader: 1 },
    ]);
  });
});

describe("contractMultiplier", () => {
  const base: AuctionState = {
    stage: "56",
    calls: [],
    turn: 0,
    highBid: null,
    doubledBy: null,
    redoubled: false,
    consecutivePasses: 0,
    carriedBid: null,
  };

  it("is 1 when never doubled, 2 when doubled, 4 when redoubled", () => {
    assert.equal(contractMultiplier(base), 1);
    assert.equal(contractMultiplier({ ...base, doubledBy: 2 }), 2);
    assert.equal(
      contractMultiplier({ ...base, doubledBy: 2, redoubled: true }),
      4,
    );
  });
});

describe("evolveAuctionEnded / evolvePlayStarted", () => {
  it("owns the contract and nested trump stored in state", () => {
    const { state } = dealtAuction(config56(), 0);
    const beforeEnd = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
      pass(3),
    ]);
    const result = act(beforeEnd, pass(0));
    assert.equal(result.ok, true);
    if (!result.ok || result.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    const ended = result.events.find((event) => event.type === "auctionEnded");
    assert.ok(ended?.type === "auctionEnded");
    const stored = result.state.phase.match.contract;
    assert.ok(stored !== null && stored.trump.type === "suit");
    assert.notEqual(stored, ended.contract);
    assert.notEqual(stored.trump, ended.contract.trump);

    ended.contract.amount = 56;
    if (ended.contract.trump.type !== "suit") {
      throw new Error("unreachable");
    }
    ended.contract.trump.suit = "hearts";

    assert.equal(stored.amount, 30);
    assert.deepEqual(stored.trump, { type: "suit", suit: "spades" });
  });

  it("rejects terminal pass counts in active auctions but accepts them after completion", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterOpeningPasses = run(state, [pass(1), pass(2), pass(3)]);
    if (afterOpeningPasses.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    const openingMatch = afterOpeningPasses.phase.match;
    const openingAuction = auctionOf(afterOpeningPasses);
    assert.throws(
      () =>
        assertEngineInvariants({
          ...afterOpeningPasses,
          phase: {
            type: "auction",
            match: {
              ...openingMatch,
              auction: { ...openingAuction, consecutivePasses: 4 },
            },
          },
        }),
      (error) =>
        error instanceof EngineInvariantError && error.code === "invalidTurn",
    );

    const { state: bidState } = dealtAuction(config56(), 0);
    const beforeFinalPass = run(bidState, [
      bid(1, 30, "spades", "numberFirst"),
      pass(2),
      pass(3),
    ]);
    if (beforeFinalPass.phase.type !== "auction") {
      throw new Error("unreachable");
    }
    const highBidMatch = beforeFinalPass.phase.match;
    const highBidAuction = auctionOf(beforeFinalPass);
    assert.throws(
      () =>
        assertEngineInvariants({
          ...beforeFinalPass,
          phase: {
            type: "auction",
            match: {
              ...highBidMatch,
              auction: { ...highBidAuction, consecutivePasses: 3 },
            },
          },
        }),
      (error) =>
        error instanceof EngineInvariantError && error.code === "invalidTurn",
    );

    const completed = act(beforeFinalPass, pass(0));
    assert.equal(completed.ok, true);
    if (!completed.ok || completed.state.phase.type !== "play") {
      throw new Error("unreachable");
    }
    assert.equal(
      completed.state.phase.match.auction?.consecutivePasses,
      config56().playerCount - 1,
    );
    assert.doesNotThrow(() => assertEngineInvariants(completed.state));
  });

  it("throw instead of silently recovering from a phase mismatch", () => {
    const { state } = dealtAuction(config56(), 0);
    assert.throws(() =>
      evolveAuctionEnded(
        { ...state, phase: { type: "awaitingDeal", reason: "firstDeal" } },
        {
          type: "auctionEnded",
          contract: {
            bidder: 1,
            team: "B",
            amount: 28,
            trump: { type: "noTrump" },
            style: null,
            multiplier: 1,
            forced: true,
          },
        },
      ),
    );
    assert.throws(() =>
      evolvePlayStarted(state, { type: "playStarted", leader: 1 }),
    );
  });
});

describe("auction: named rejections", () => {
  it("rejects double with no bid yet", () => {
    const { state } = dealtAuction(config56(), 0);
    // Seat1 passes with nothing bid yet, so it becomes seat2's turn with no
    // highBid to double.
    const afterOpenPass = run(state, [pass(1)]);
    const rejection = decide(afterOpenPass, double(2));
    assert.equal(!rejection.ok && rejection.code, "doubleNotAllowed");
    assert.deepEqual(!rejection.ok ? rejection.details : undefined, {
      reason: "noDoublableBid",
    });
  });

  it("rejects pass and double out of turn with notYourTurn", () => {
    const { state } = dealtAuction(config56(), 0);
    const passRejection = decide(state, pass(2));
    assert.equal(!passRejection.ok && passRejection.code, "notYourTurn");
    assert.deepEqual(!passRejection.ok ? passRejection.details : undefined, {
      expected: 1,
      actual: 2,
    });

    const afterBid = run(state, [bid(1, 30, "spades", "numberFirst")]);
    // It is seat2's turn (opposing the bidder); double from seat3 is out of
    // turn for `double` (unlike `redouble`, which is always out of turn).
    const doubleRejection = decide(afterBid, double(3));
    assert.equal(!doubleRejection.ok && doubleRejection.code, "notYourTurn");
    assert.deepEqual(
      !doubleRejection.ok ? doubleRejection.details : undefined,
      { expected: 2, actual: 3 },
    );
  });

  it("rejects redouble after a new bid cancelled the double, with noDoubleActive", () => {
    const { state } = dealtAuction(config56(), 0);
    const afterCancel = run(state, [
      bid(1, 30, "spades", "numberFirst"),
      double(2),
      bid(3, 32, "clubs", "suitFirst"),
    ]);
    assert.equal(auctionOf(afterCancel).doubledBy, null);
    const rejection = decide(afterCancel, redouble(1));
    assert.equal(!rejection.ok && rejection.code, "noDoubleActive");
  });

  it("rejects auction calls once play has started, with actionNotAllowed", () => {
    const { state } = dealtAuction(config56(), 0);
    // Everyone passes with no bid at all: the forced bid ends the auction
    // and starts play in the same action.
    const inPlay = run(state, [pass(1), pass(2), pass(3), pass(0)]);
    assert.equal(inPlay.phase.type, "play");
    const rejection = decide(inPlay, pass(1));
    assert.equal(!rejection.ok && rejection.code, "actionNotAllowed");
  });

  it("decideAuctionAction is safe to call directly on a non-auction state or a non-auction action", () => {
    const start = newSession(config56(), 0);
    assert.equal(start.ok, true);
    if (!start.ok) {
      throw new Error("unreachable");
    }
    assert.notEqual(start.state.phase.type, "auction");
    const wrongPhase = decideAuctionAction(start.state, pass(1));
    assert.equal(wrongPhase.ok, false);
    assert.equal(!wrongPhase.ok && wrongPhase.code, "actionNotAllowed");

    const { state } = dealtAuction(config56(), 0);
    const nonCallAction = {
      type: "askReveal",
      source: seat(1),
    } as EngineAction;
    const wrongActionType = decideAuctionAction(state, nonCallAction);
    assert.equal(wrongActionType.ok, false);
    assert.equal(
      !wrongActionType.ok && wrongActionType.code,
      "actionNotAllowed",
    );
  });
});

describe("auction: replay and immutability", () => {
  it("replaying the full event log from newSession's state reproduces the act result byte-for-byte, and act/decide never mutate frozen inputs", () => {
    const start = newSession(deepFreeze(config56()), 0);
    assert.equal(start.ok, true);
    if (!start.ok) {
      throw new Error("unreachable");
    }
    const initial = deepFreeze(start.state);

    const actions: EngineAction[] = [
      deepFreeze({
        type: "deal",
        source: system,
        deck: deepFreeze(buildDeck(config56())),
      } as EngineAction),
      deepFreeze(bid(1, 30, "spades", "numberFirst")),
      deepFreeze(double(2)),
      deepFreeze(redouble(1)),
    ];

    let state = initial;
    const allEvents: EngineEvent[] = [];
    for (const action of actions) {
      const result = act(state, action);
      assert.equal(
        result.ok,
        true,
        `expected ${action.type} to be accepted: ${JSON.stringify(!result.ok ? result : {})}`,
      );
      if (!result.ok) {
        throw new Error("unreachable");
      }
      allEvents.push(...result.events);
      state = deepFreeze(result.state);
    }
    assert.equal(state.phase.type, "play");
    assert.equal(
      state.phase.type === "play" && state.phase.match.contract?.multiplier,
      4,
    );

    const replayed = allEvents.reduce(
      (acc, event) => evolve(acc, event),
      initial,
    );
    assert.equal(JSON.stringify(replayed), JSON.stringify(state));
  });
});
