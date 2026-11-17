import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck, cardPoints } from "./cards.js";
import { validateConfig } from "./config.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent } from "./events.js";
import { faceDownIsForced } from "./hidden-trump.js";
import { assertEngineInvariants, EngineInvariantError } from "./invariants.js";
import { countingTrumpSuit, legalCards } from "./play.js";
import { teamOf } from "./seats.js";
import { decideSessionStart } from "./session.js";
import type { EngineState, MatchState } from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type { Card, EngineConfig, StakeTier, Suit, Team } from "./types.js";
import {
  type AllowedEngineAction,
  allowedActions,
  redactEvent,
  type Viewer,
  type ViewSettings,
  view,
} from "./views.js";

// E010: verification of the complete engine (plan E010).
//
// This file adds what the earlier unit tests don't: a strict harness that
// checks every accepted and rejected action (unchanged inputs, invariants,
// card conservation, point totals, tokens, determinism, JSON round trips,
// replay from persisted JSON after every action), complete multi-match
// sessions for every 56 layout and for 28 in both illegal-play modes, leak
// scans of every seat/Table view and redacted event in those sessions, the
// full config/deck matrix, and the package boundary.
//
// Where each item of the plan's required matrix is exercised:
//
// | Matrix item | Tests |
// |---|---|
// | valid/invalid configs, deck multisets | "configs and decks" below; config.test.ts; engine.test.ts `validateDeck` |
// | 56 at 4/6/8 seats, 48/64 cards | "complete sessions" below (all five layouts); play.test.ts "whole matches" |
// | 28 forced/normal/doubled/redoubled two-auction paths | "complete sessions" (coverage list); hidden-trump.test.ts, which alone covers a second-auction bid cancelling a carried double and a first-auction bid of 28 skipping the second auction |
// | every redeal reason | "complete sessions" (56 and 28, both reasons); engine.test.ts; hidden-trump.test.ts |
// | following suit, trump lead/reveal/forced card | "complete sessions"; play.test.ts |
// | identical-card precedence | play.test.ts "round winner"; "complete sessions" round-winner invariant |
// | Block/Auto-stop illegal kinds | "complete sessions" (all four kinds); play.test.ts; views.test.ts |
// | made/failed/capped/multiplied scoring | "complete sessions"; scoring.test.ts |
// | host restart/award | "complete sessions"; scoring.test.ts |
// | surrender pass/fail for all team sizes | "complete sessions" (4, 6, 8 players); surrender.test.ts |
// | dealer rotation, session restart | "complete sessions"; scoring.test.ts "session transitions" |
// | every viewer/settings combination | "complete sessions" (every viewer; views scanned at the two extreme settings, redacted events at all six); views.test.ts exploration (every setting) |
// | full event replay | "complete sessions" (after every action and from the seed) |

const STAKES_56: StakeTier[] = [
  { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
  { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
  { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
];
const STAKES_28: StakeTier[] = [
  { fromBid: 14, toBid: 19, winStake: 1, lossStake: 2 },
  { fromBid: 20, toBid: 27, winStake: 2, lossStake: 3 },
  { fromBid: 28, toBid: 28, winStake: 3, lossStake: 4 },
];

function config56(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    gameType: "56",
    playerCount: 4,
    includeEightsAndSevens: false,
    illegalPlayMode: "block",
    startingTokens: 10,
    stakeTiers: STAKES_56,
    redealThreshold: 2,
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
    stakeTiers: STAKES_28,
    redealThreshold: 1,
    surrenderOption: "on",
    ...overrides,
  };
}

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;
const host = { type: "host" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const pass = (seatNumber: number): EngineAction => ({
  type: "pass",
  source: seat(seatNumber),
});

const ALL_SETTINGS: readonly ViewSettings[] = (
  ["none", "last", "full"] as const
).flatMap((roundHistory) =>
  [false, true].map((livePoints) => ({ roundHistory, livePoints })),
);
const VIEW_SETTINGS: readonly ViewSettings[] = [
  { roundHistory: "none", livePoints: false },
  { roundHistory: "full", livePoints: true },
];

function viewers(playerCount: number): Viewer[] {
  return [
    ...Array.from(
      { length: playerCount },
      (_, seatNumber): Viewer => ({ type: "seat", seat: seatNumber }),
    ),
    { type: "table" },
  ];
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

function matchOf(state: EngineState): MatchState | null {
  return "match" in state.phase ? state.phase.match : null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** mulberry32: a small deterministic PRNG for test data only. */
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], next: () => number): T {
  const item = items[Math.floor(next() * items.length)];
  assert.ok(item !== undefined);
  return item;
}

function shuffled(deck: readonly Card[], next: () => number): Card[] {
  const copy = [...deck];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as Card, copy[index] as Card];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Leak scanning

interface Contents {
  /** Keys of every card object (`{suit, rank, copy}`). */
  cards: string[];
  /** Every object key. */
  keys: Set<string>;
  /** Every non-card `suit` field (trumps, bids), outside skipped keys. */
  suits: unknown[];
}

/**
 * One pass over a projection: collects its cards, keys and suit fields, and
 * requires plain JSON data (no `undefined`, functions, classes, or
 * non-finite numbers). `suits` skips the top-level keys in `skipSuits`.
 */
function contents(
  value: unknown,
  skipSuits: readonly string[] = [],
  found: Contents = { cards: [], keys: new Set(), suits: [] },
  collectSuits = true,
): Contents {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return found;
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "non-finite number");
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      contents(item, [], found, collectSuits);
    }
    return found;
  }
  assert.equal(typeof value, "object", "not JSON data");
  assert.equal(Object.getPrototypeOf(value), Object.prototype, "not plain");
  const record = value as Record<string, unknown>;
  if ("suit" in record && "rank" in record && "copy" in record) {
    found.cards.push(cardKey(record as unknown as Card));
  } else if ("suit" in record && collectSuits) {
    found.suits.push(record.suit);
  }
  for (const [key, item] of Object.entries(record)) {
    found.keys.add(key);
    contents(item, [], found, collectSuits && !skipSuits.includes(key));
  }
  return found;
}

/** Cards `viewer` may not see in `state`: other hands, `undealt`, another seat's face-down card. */
function privateCards(state: EngineState, viewer: Viewer, into: Set<string>) {
  const match = matchOf(state);
  if (match === null) {
    return;
  }
  const own = viewer.type === "seat" ? viewer.seat : null;
  match.hands.forEach((hand, seatNumber) => {
    if (seatNumber !== own) {
      for (const card of hand) {
        into.add(cardKey(card));
      }
    }
  });
  for (const card of (match.undealt ?? []).flat()) {
    into.add(cardKey(card));
  }
  if (match.faceDown !== null && match.faceDown.owner !== own) {
    into.add(cardKey(match.faceDown.card));
  }
}

/** The unrevealed 28 trump suit `viewer` may not know in `state`, if any. */
function hiddenSuitFor(state: EngineState, viewer: Viewer): Suit | null {
  const match = matchOf(state);
  const contract = match?.contract ?? null;
  if (
    match === null ||
    contract === null ||
    contract.trump.type !== "hidden" ||
    match.revealedInRound !== null
  ) {
    return null;
  }
  return viewer.type === "seat" && viewer.seat === contract.bidder
    ? null
    : contract.trump.suit;
}

/**
 * design §11.2–§11.3: no view or redacted event shows `viewer` another
 * seat's cards, `undealt`, or an unrevealed trump it doesn't own, and no
 * match summary keeps an unrevealed trump's suit — for any recipient.
 */
function checkViewerLeaks(
  before: EngineState,
  after: EngineState,
  events: readonly EngineEvent[],
): void {
  // Cards made public by this action: played cards and a revealed trump.
  const shown = new Set<string>();
  for (const event of events) {
    if (event.type === "cardPlayed" || event.type === "trumpRevealed") {
      shown.add(cardKey(event.card));
    }
  }
  const revealedNow = events.some((event) => event.type === "trumpRevealed");

  for (const viewer of viewers(after.config.playerCount)) {
    const own = viewer.type === "seat" ? viewer.seat : null;
    const forbidden = new Set<string>();
    privateCards(before, viewer, forbidden);
    privateCards(after, viewer, forbidden);
    for (const event of events) {
      if (event.type === "dealt") {
        event.hands.forEach((hand, seatNumber) => {
          if (seatNumber !== own) {
            for (const card of hand) {
              forbidden.add(cardKey(card));
            }
          }
        });
        for (const card of (event.undealt ?? []).flat()) {
          forbidden.add(cardKey(card));
        }
      }
    }
    // Cards this action made public, or gave to the viewer itself (its
    // second deal, a returned face-down card, its own placed card).
    const ownMatch = own === null ? null : matchOf(after);
    const ownCards = [
      ...(own === null ? [] : (ownMatch?.hands[own] ?? [])),
      ...(ownMatch?.faceDown?.owner === own && ownMatch.faceDown !== null
        ? [ownMatch.faceDown.card]
        : []),
      ...events.flatMap((event) =>
        event.type === "dealt" && own !== null ? (event.hands[own] ?? []) : [],
      ),
    ];
    for (const key of [...shown, ...ownCards.map(cardKey)]) {
      forbidden.delete(key);
    }
    // A new 28 bidder knows the suit it just placed, even when it matches
    // the suit of the card it replaced.
    const ownSuit =
      hiddenSuitFor(after, viewer) === null
        ? hiddenSuitFor(after, { type: "table" })
        : null;
    const hiddenSuits = new Set<Suit>();
    for (const state of [before, after]) {
      const suit = revealedNow ? null : hiddenSuitFor(state, viewer);
      if (suit !== null && suit !== ownSuit) {
        hiddenSuits.add(suit);
      }
    }

    // A view shows the state after the action: only its private cards and
    // hidden suit apply.
    const viewForbidden = new Set<string>();
    privateCards(after, viewer, viewForbidden);
    const viewHidden = new Set<Suit>();
    const afterSuit = hiddenSuitFor(after, viewer);
    if (afterSuit !== null) {
      viewHidden.add(afterSuit);
    }

    const scan = (
      value: unknown,
      what: string,
      cards: ReadonlySet<string>,
      suits: ReadonlySet<Suit>,
      skipLog: boolean,
    ): void => {
      // Earlier matches' summaries may name their own revealed trump.
      const found = contents(
        value,
        skipLog ? ["matchLog", "pastSessions"] : [],
      );
      assert.ok(!found.keys.has("undealt"), `${what} has undealt`);
      for (const key of found.cards) {
        assert.ok(!cards.has(key), `${what} leaks ${key}`);
      }
      for (const suit of found.suits) {
        assert.ok(!suits.has(suit as Suit), `${what} leaks the hidden suit`);
      }
    };
    // Summaries never keep an unrevealed trump's suit, for anyone.
    const checkSummaries = (summaries: readonly unknown[]): void => {
      for (const trump of trumpsIn(summaries)) {
        if ((trump as { type: string }).type === "hidden") {
          assert.deepStrictEqual(trump, { type: "hidden" });
        }
      }
    };

    for (const settings of ALL_SETTINGS) {
      for (const event of events) {
        const redacted = redactEvent(event, viewer, settings);
        if (redacted !== null) {
          scan(
            redacted,
            `${event.type} for ${json(viewer)}`,
            forbidden,
            hiddenSuits,
            false,
          );
          if (redacted.type === "matchEnded") {
            checkSummaries([redacted.summary]);
          }
        }
      }
    }
    // Settings only choose how many finished (public) rounds and whether
    // points are shown, so the two extremes bound every view's content; the
    // per-setting shapes are checked in views.test.ts.
    for (const settings of VIEW_SETTINGS) {
      const projected = view(after, viewer, settings);
      scan(projected, `view(${json(viewer)})`, viewForbidden, viewHidden, true);
      checkSummaries([
        projected.matchLog,
        "summary" in projected.phase ? projected.phase.summary : null,
      ]);
      if (viewer.type === "seat" && projected.viewer.type === "seat") {
        assert.deepStrictEqual(
          projected.viewer.hand,
          matchOf(after)?.hands[viewer.seat] ?? [],
        );
      } else {
        assert.deepStrictEqual(projected.viewer, { type: "table" });
      }
    }
  }
}

/** Every `trump` field inside `value`. */
function trumpsIn(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      trumpsIn(item, found);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "trump") {
        found.push(item);
      }
      trumpsIn(item, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Strict harness

interface Recorder {
  readonly config: EngineConfig;
  readonly seed: EngineState;
  /** Every event since (and including) `sessionStarted`. */
  readonly log: EngineEvent[];
  state: EngineState;
  /** State rebuilt only from JSON copies of the events. */
  replayed: EngineState;
  /** Coverage tags of what the session reached. */
  readonly seen: Set<string>;
  readonly checkViews: boolean;
}

function begin(
  config: EngineConfig,
  firstDealer: number,
  checkViews = true,
): Recorder {
  const start = decideSessionStart(config, firstDealer);
  assert.ok(start.ok);
  if (!start.ok) {
    throw new Error("unreachable");
  }
  const started = newSession(deepFreeze(structuredClone(config)), firstDealer);
  assert.ok(started.ok);
  if (!started.ok) {
    throw new Error("unreachable");
  }
  assert.deepStrictEqual(started.events, [start.event]);
  const seed = JSON.parse(json(start.seed)) as EngineState;
  const replayed = evolve(seed, JSON.parse(json(start.event)) as EngineEvent);
  assert.equal(json(replayed), json(started.state));
  assertEngineInvariants(started.state);
  return {
    config,
    seed,
    log: [...started.events],
    state: deepFreeze(started.state),
    replayed,
    seen: new Set(started.events.map((event) => event.type)),
    checkViews,
  };
}

// ---------------------------------------------------------------------------
// Independent rules oracle (rules §1, §6, §8, §10.3), written from the rules
// rather than the engine's modules, for cross-checking every played round
// and every card a seat could play.

/** rules §1: rank order, high to low. */
const RANK_ORDER = ["J", "9", "A", "10", "K", "Q", "8", "7"];

/** rules §6.2, §10.3: the suit counting as trump in round `index`, if any. */
function oracleTrump(match: MatchState, index: number): Suit | null {
  const trump = match.contract?.trump;
  if (trump === undefined || trump.type === "noTrump") {
    return null;
  }
  if (trump.type === "suit") {
    return trump.suit;
  }
  return match.revealedInRound !== null && index >= match.revealedInRound
    ? trump.suit
    : null;
}

/** rules §6.2: highest trump, else highest lead-suit card; first of identical cards. */
function oracleWinner(
  plays: readonly { seat: number; card: Card }[],
  trump: Suit | null,
): number {
  const lead = plays[0]?.card.suit;
  const beats = (card: Card, best: Card): boolean => {
    if (card.suit === best.suit) {
      return RANK_ORDER.indexOf(card.rank) < RANK_ORDER.indexOf(best.rank);
    }
    return card.suit === trump || (best.suit !== trump && card.suit === lead);
  };
  let best = plays[0];
  assert.ok(best !== undefined);
  for (const play of plays.slice(1)) {
    if (
      (play.card.suit === trump || play.card.suit === lead) &&
      beats(play.card, best.card)
    ) {
      best = play;
    }
  }
  return best.seat;
}

/** rules §10.3: whether the 28 bidder on turn must play its face-down card. */
function oracleForced(match: MatchState, turn: number): boolean {
  const trump = match.contract?.trump;
  const hand = match.hands[turn] ?? [];
  const lead = match.currentRound?.leadSuit ?? null;
  return (
    match.faceDown?.owner === turn &&
    trump?.type === "hidden" &&
    match.revealedInRound === null &&
    (hand.length === 0 ||
      (lead === trump.suit && !hand.some((card) => card.suit === trump.suit)))
  );
}

/**
 * rules §6.1, §6.3, §8, §10.3 and design §9.1–§9.4: how a seat's play (or
 * reveal request) on its turn breaks the rules — a disqualifying kind,
 * `"rejected"` for a move rejected in both modes (an unforced face-down
 * card, a reveal request that isn't allowed), or null when legal.
 */
function oracleKind(
  match: MatchState,
  turn: number,
  move: Card | "ask",
): string | null {
  const round = match.currentRound;
  assert.ok(round !== null && round.turn === turn);
  const hand = match.hands[turn] ?? [];
  const lead = round.leadSuit;
  const forced = oracleForced(match, turn);
  const holdsLead = lead !== null && hand.some((card) => card.suit === lead);
  if (move === "ask") {
    const allowed =
      match.contract?.trump.type === "hidden" &&
      match.revealedInRound === null &&
      lead !== null &&
      round.revealAskedBy !== turn &&
      !forced;
    return !allowed ? "rejected" : holdsLead ? "revealWhileAbleToFollow" : null;
  }
  const faceDown = match.faceDown?.owner === turn ? match.faceDown : null;
  if (faceDown !== null && cardKey(faceDown.card) === cardKey(move)) {
    return forced ? null : "rejected";
  }
  if (forced) {
    return "didNotPlayFaceDown";
  }
  if (lead === null) {
    const trump = oracleTrump(match, match.rounds.length);
    return trump !== null &&
      !match.trumpPlayed &&
      move.suit === trump &&
      hand.some((card) => card.suit !== trump)
      ? "ledTrumpEarly"
      : null;
  }
  return move.suit !== lead && holdsLead && round.revealAskedBy !== turn
    ? "didNotFollowSuit"
    : null;
}

/**
 * Every card the seat on turn holds, its face-down card, and a reveal
 * request are accepted or rejected exactly as the oracle says, in the
 * config's illegal-play mode.
 */
function checkPlayChoices(state: EngineState, seen: Set<string>): void {
  const match = matchOf(state);
  const round = match?.currentRound ?? null;
  if (
    state.phase.type !== "play" ||
    match === null ||
    round === null ||
    match.surrender.vote !== null
  ) {
    return;
  }
  const turn = round.turn;
  const moves: (Card | "ask")[] = [
    ...(match.hands[turn] ?? []),
    ...(match.faceDown?.owner === turn ? [match.faceDown.card] : []),
    "ask",
  ];
  for (const move of moves) {
    const kind = oracleKind(match, turn, move);
    const decision = decide(
      state,
      move === "ask"
        ? { type: "askReveal", source: seat(turn) }
        : { type: "playCard", card: move, source: seat(turn) },
    );
    if (kind === "rejected") {
      assert.ok(
        !decision.ok &&
          decision.code ===
            (move === "ask" ? "revealNotAllowed" : "faceDownNotPlayable"),
        `${json(move)}: ${json(decision)}`,
      );
    } else if (kind === null) {
      assert.ok(decision.ok, `legal ${json(move)} rejected: ${json(decision)}`);
      assert.ok(
        !decision.events.some((event) => event.type === "disqualified"),
      );
    } else if (state.config.illegalPlayMode === "block") {
      seen.add(`block:${state.config.gameType}:${kind}`);
      assert.deepStrictEqual(decision, {
        ok: false,
        code: "illegalPlay",
        details: { kind },
      });
    } else {
      assert.ok(decision.ok);
      assert.ok(
        decision.events.some(
          (event) => event.type === "disqualified" && event.kind === kind,
        ),
        `expected ${kind} for ${json(move)}`,
      );
    }
  }
}

/** design §13.2: the guarantees that must hold after every accepted action. */
function checkAcceptedState(state: EngineState): void {
  assertEngineInvariants(state);
  const { config } = state;
  // Tokens: whole, nonnegative, and conserved between the teams.
  for (const balances of [
    state.tokens,
    ...state.matchLog.map((summary) => summary.tokens),
  ]) {
    assert.ok(balances.A >= 0 && balances.B >= 0);
    assert.equal(balances.A + balances.B, 2 * config.startingTokens);
  }

  const match = matchOf(state);
  if (match === null) {
    return;
  }
  // Every card in exactly one place.
  const locations = [
    ...match.hands.flat(),
    ...(match.undealt ?? []).flat(),
    ...(match.faceDown === null ? [] : [match.faceDown.card]),
    ...match.rounds.flatMap((round) => round.plays.map((play) => play.card)),
    ...(match.currentRound?.plays ?? []).map((play) => play.card),
  ]
    .map(cardKey)
    .sort();
  assert.deepStrictEqual(locations, buildDeck(config).map(cardKey).sort());
  // rules §2: the dealer's right leads the first round and each round's
  // winner leads the next.
  const firstLeader = (state.dealer + 1) % config.playerCount;
  match.rounds.forEach((round, index) => {
    assert.equal(
      round.leader,
      index === 0 ? firstLeader : match.rounds[index - 1]?.winner,
    );
  });
  if (match.currentRound !== null) {
    assert.equal(
      match.currentRound.leader,
      match.rounds.at(-1)?.winner ?? firstLeader,
    );
  }
  // Each round's winner is the rules' winner, and trump played is exactly
  // whether a finished round held a counting trump.
  let trumpPlayed = false;
  match.rounds.forEach((round, index) => {
    const trump = oracleTrump(match, index);
    assert.equal(round.winner, oracleWinner(round.plays, trump));
    trumpPlayed ||= round.plays.some((play) => play.card.suit === trump);
  });
  assert.equal(match.trumpPlayed, trumpPlayed);
  // Team points are exactly the points of the rounds each team won.
  const won = { A: 0, B: 0 };
  for (const round of match.rounds) {
    const points = round.plays.reduce(
      (total, play) => total + cardPoints(play.card),
      0,
    );
    assert.equal(round.points, points);
    won[teamOf(round.winner)] += points;
  }
  assert.deepStrictEqual({ ...match.points }, won);
}

function tag(
  recorder: Recorder,
  before: EngineState,
  events: readonly EngineEvent[],
): void {
  const { seen, config } = recorder;
  const game = config.gameType;
  for (const event of events) {
    seen.add(event.type);
    switch (event.type) {
      case "doubled":
      case "redoubled":
        seen.add(`${event.type}:${matchOf(before)?.auction?.stage}`);
        break;
      case "playStarted":
        if (matchOf(recorder.state)?.contract?.trump.type === "noTrump") {
          seen.add(`playStarted:${game}:noTrump`);
        }
        break;
      case "forcedBid":
        seen.add(`forcedBid:${game}`);
        break;
      case "auctionEnded":
        seen.add(
          `auctionEnded:${game}:x${event.contract.multiplier}${event.contract.forced ? ":forced" : ""}`,
        );
        break;
      case "auctionStarted":
        seen.add(`auctionStarted:${event.stage}`);
        break;
      case "redealt":
        seen.add(`redealt:${game}:${event.reason.type}`);
        break;
      case "cardPlayed":
        if (event.fromFaceDown) {
          seen.add("cardPlayed:fromFaceDown");
        }
        break;
      case "disqualified":
        seen.add(`disqualified:${event.kind}`);
        break;
      case "surrendered":
      case "surrenderFailed":
        seen.add(`${event.type}:${config.playerCount}`);
        break;
      case "matchEnded":
        seen.add(`matchEnded:${game}:${event.summary.outcome.type}`);
        if (
          event.summary.outcome.type === "made" ||
          event.summary.outcome.type === "failed"
        ) {
          // design §13.2: when all rounds are finished the points add up to
          // the game's total.
          const { A, B } = event.summary.points;
          assert.equal(A + B, game === "56" ? 56 : 28);
        }
        break;
      default:
        break;
    }
  }
  // 28 second auction: whether the carried bid stood or a new one won.
  const types = events.map((event) => event.type);
  if (
    game === "28" &&
    recorder.state.phase.type === "play" &&
    types.includes("playStarted") &&
    matchOf(recorder.state)?.auction?.stage === "28-second"
  ) {
    seen.add(
      types.includes("cardPlaced")
        ? "28-second:newWinner"
        : "28-second:carriedBidStood",
    );
  }
  if (
    types.includes("redealt") &&
    types.includes("faceDownReturned") &&
    game === "28"
  ) {
    seen.add("redealt:28:faceDownReturned");
  }
}

/** Applies an action that must be accepted, checking every guarantee. */
function step(recorder: Recorder, action: EngineAction): EngineEvent[] {
  const before = recorder.state;
  const beforeJson = json(before);
  const frozen = deepFreeze(structuredClone(action));
  const actionJson = json(frozen);

  const decision = decide(before, frozen);
  assert.deepStrictEqual(decide(before, frozen), decision);
  const result = act(before, frozen);
  assert.deepStrictEqual(act(before, frozen), result);
  assert.equal(json(before), beforeJson, "input state changed");
  assert.equal(json(frozen), actionJson, "input action changed");
  assert.ok(
    result.ok && decision.ok,
    `expected ${actionJson} to be accepted in ${before.phase.type}: ${json(result)}`,
  );
  if (!result.ok || !decision.ok) {
    throw new Error("unreachable");
  }
  assert.deepStrictEqual(result.events, decision.events);
  assert.ok(result.events.length > 0);
  assert.deepStrictEqual(JSON.parse(json(result.state)), result.state);
  assert.deepStrictEqual(JSON.parse(json(result.events)), result.events);
  checkAcceptedState(result.state);

  // Replay from persisted JSON reproduces the state byte for byte.
  const persisted = JSON.parse(json(result.events)) as EngineEvent[];
  recorder.replayed = persisted.reduce(
    (state, event) => evolve(state, event),
    recorder.replayed,
  );
  assert.equal(json(recorder.replayed), json(result.state));
  recorder.log.push(...persisted);

  recorder.state = deepFreeze(result.state);
  deepFreeze(result.events);
  if (recorder.checkViews) {
    checkViewerLeaks(before, recorder.state, result.events);
  }
  tag(recorder, before, result.events);
  return result.events;
}

/** An action that must be rejected leaves the state alone and emits nothing. */
function rejected(state: EngineState, action: EngineAction): string {
  const beforeJson = json(state);
  const frozen = deepFreeze(structuredClone(action));
  const decision = decide(state, frozen);
  assert.equal(decision.ok, false, `expected ${json(action)} to be rejected`);
  const result = act(state, frozen);
  assert.deepStrictEqual(result, decision);
  assert.deepStrictEqual(decide(state, frozen), decision);
  assert.ok(!("events" in result) && !("state" in result));
  assert.equal(json(state), beforeJson);
  assert.deepStrictEqual(JSON.parse(json(result)), result);
  return decision.ok ? "" : decision.code;
}

/** Rejected probes for any state: wrong phase, wrong seat, bad source. */
function probeRejections(
  state: EngineState,
  next: () => number,
  seen: Set<string>,
): void {
  const { playerCount } = state.config;
  const { phase } = state;
  const deck = shuffled(buildDeck(state.config), next);
  if (phase.type !== "awaitingDeal") {
    rejected(state, deal(deck));
  } else {
    rejected(state, deal(deck.slice(1)));
  }
  if (phase.type !== "matchOver") {
    rejected(state, { type: "startNextMatch", source: system });
  }
  if (phase.type !== "sessionOver") {
    rejected(state, { type: "restartSession", source: system, firstDealer: 0 });
  }
  if (phase.type !== "play") {
    rejected(state, {
      type: "endMatch",
      resolution: { type: "award", team: "A" },
      source: host,
    });
  }
  rejected(state, pass(playerCount));
  rejected(state, { type: "pass", source: host } as unknown as EngineAction);
  rejected(state, {
    type: "shuffle",
    source: system,
  } as unknown as EngineAction);

  const match = matchOf(state);
  if (phase.type === "auction" && match?.auction != null) {
    rejected(state, pass((match.auction.turn + 1) % playerCount));
  }
  if (phase.type === "play" && match?.currentRound != null) {
    const other = (match.currentRound.turn + 1) % playerCount;
    const card = match.hands[other]?.[0];
    if (card !== undefined) {
      rejected(state, { type: "playCard", card, source: seat(other) });
    }
    checkPlayChoices(state, seen);
  }
}

// ---------------------------------------------------------------------------
// Session policy

interface AuctionPlan {
  /** Bids to make in this auction stage (at the minimum, first come). */
  bids: number;
  /** Only the carried bidder may bid (28 second auction self-raise). */
  holderOnly?: boolean;
  double?: boolean;
  redouble?: boolean;
}

type PlayPlan =
  | { type: "legal" }
  | { type: "ask" }
  | { type: "restart"; phase: "auction" | "placingCard" | "play" }
  | { type: "award"; team: Team }
  | { type: "surrender"; vote: "yes" | "no" }
  | {
      type: "disqualify";
      kind:
        | "didNotFollowSuit"
        | "ledTrumpEarly"
        | "revealWhileAbleToFollow"
        | "didNotPlayFaceDown";
    };

type DeckPlan = "shuffled" | "noJackForTeamB" | "lowHandFirstSeat";

interface MatchPlan {
  first: AuctionPlan;
  /** 28 second auction. */
  second?: AuctionPlan;
  play: PlayPlan;
  deck?: DeckPlan;
}

const PASS_OUT: AuctionPlan = { bids: 0 };
const SINGLE: AuctionPlan = { bids: 1 };
const CONTEST: AuctionPlan = { bids: 3 };
const DOUBLED: AuctionPlan = { bids: 1, double: true };
const CANCELLED: AuctionPlan = { bids: 2, double: true };
const REDOUBLED: AuctionPlan = { bids: 1, double: true, redouble: true };

/** A deck arranged so a planned redeal reason holds for the dealt hands. */
function arrangedDeck(
  config: EngineConfig,
  dealer: number,
  plan: DeckPlan,
  next: () => number,
): Card[] {
  const deck = shuffled(buildDeck(config), next);
  if (plan === "shuffled") {
    return deck;
  }
  const { playerCount } = config;
  // Card k is dealt to seat (dealer + 1 + k) mod N, in both 28 stages too.
  const seatOf = (index: number) => (dealer + 1 + index) % playerCount;
  const wanted = (index: number, card: Card): boolean =>
    plan === "noJackForTeamB"
      ? teamOf(seatOf(index)) === "A" || card.rank !== "J"
      : seatOf(index) !== (dealer + 1) % playerCount || cardPoints(card) === 0;
  for (let index = 0; index < deck.length; index += 1) {
    if (wanted(index, deck[index] as Card)) {
      continue;
    }
    const swap = deck.findIndex(
      (card, other) =>
        wanted(index, card) && wanted(other, deck[index] as Card),
    );
    assert.ok(swap !== -1);
    [deck[index], deck[swap]] = [deck[swap] as Card, deck[index] as Card];
  }
  return deck;
}

interface SessionContext {
  plans: readonly MatchPlan[];
  next: () => number;
  /** Index of the current plan, advanced on every deal. */
  dealCount: number;
  proposed: boolean;
}

function currentPlan(context: SessionContext): MatchPlan {
  const plan =
    context.plans[(context.dealCount - 1) % context.plans.length] ??
    context.plans[0];
  assert.ok(plan !== undefined);
  return plan;
}

function playedCount(match: MatchState): number {
  return (
    match.rounds.length * match.hands.length +
    (match.currentRound?.plays.length ?? 0)
  );
}

function has<T extends AllowedEngineAction["type"]>(
  allowed: readonly AllowedEngineAction[],
  type: T,
): Extract<AllowedEngineAction, { type: T }> | undefined {
  return allowed.find(
    (entry): entry is Extract<AllowedEngineAction, { type: T }> =>
      entry.type === type,
  );
}

function auctionAction(
  state: EngineState,
  match: MatchState,
  plan: AuctionPlan,
  next: () => number,
): EngineAction {
  const auction = match.auction;
  assert.ok(auction !== null);
  const { playerCount } = state.config;
  if (plan.redouble && auction.doubledBy !== null) {
    for (let other = 0; other < playerCount; other += 1) {
      if (has(allowedActions(state, other), "redouble")) {
        return { type: "redouble", source: seat(other) };
      }
    }
  }
  const turn = auction.turn;
  const allowed = allowedActions(state, turn);
  const calls = auction.calls;
  const doubles = calls.filter((call) => call.type === "double").length;
  if (plan.double && doubles === 0 && has(allowed, "double")) {
    return { type: "double", source: seat(turn) };
  }
  const bids = calls.filter((call) => call.type === "bid").length;
  const bid = has(allowed, "bid");
  const holder = auction.carriedBid?.bid.seat ?? null;
  if (
    bid !== undefined &&
    bids < plan.bids &&
    (!plan.holderOnly || turn === holder)
  ) {
    const amount = Math.min(
      bid.range.maximum,
      bid.range.minimum + (next() < 0.3 ? 1 : 0),
    );
    const action: EngineAction = { type: "bid", amount, source: seat(turn) };
    if (bid.suits.length > 0) {
      const suit = pick(bid.suits, next);
      action.suit = suit;
      if (suit !== "noTrump") {
        action.style = pick(bid.styles, next);
      }
    }
    return action;
  }
  return pass(turn);
}

/** design §9.4: a disqualifying move of `kind` for `turn`, if one exists. */
function disqualifyingMove(
  state: EngineState,
  match: MatchState,
  turn: number,
  kind: Extract<PlayPlan, { type: "disqualify" }>["kind"],
): EngineAction | null {
  const round = match.currentRound;
  const contract = match.contract;
  if (round === null || contract === null) {
    return null;
  }
  const hand = match.hands[turn] ?? [];
  const source = seat(turn);
  const leadSuit = round.leadSuit;
  const forced = faceDownIsForced(state, turn);
  switch (kind) {
    case "didNotFollowSuit": {
      const offSuit = hand.find((card) => card.suit !== leadSuit);
      return leadSuit !== null &&
        !forced &&
        round.revealAskedBy !== turn &&
        hand.some((card) => card.suit === leadSuit) &&
        offSuit !== undefined
        ? { type: "playCard", card: offSuit, source }
        : null;
    }
    case "ledTrumpEarly": {
      const trump = countingTrumpSuit(contract, match.revealedInRound !== null);
      const trumpCard = hand.find((card) => card.suit === trump);
      return round.plays.length === 0 &&
        !match.trumpPlayed &&
        trumpCard !== undefined &&
        hand.some((card) => card.suit !== trump)
        ? { type: "playCard", card: trumpCard, source }
        : null;
    }
    case "revealWhileAbleToFollow":
      return has(allowedActions(state, turn), "askReveal") &&
        hand.some((card) => card.suit === leadSuit)
        ? { type: "askReveal", source }
        : null;
    case "didNotPlayFaceDown": {
      const card = hand[0];
      return forced && card !== undefined
        ? { type: "playCard", card, source }
        : null;
    }
  }
}

function playAction(
  state: EngineState,
  match: MatchState,
  plan: PlayPlan,
  context: SessionContext,
): EngineAction | null {
  const { playerCount } = state.config;
  const { next } = context;
  const vote = match.surrender.vote;
  if (vote !== null) {
    for (let other = 0; other < playerCount; other += 1) {
      if (has(allowedActions(state, other), "voteSurrender")) {
        return {
          type: "voteSurrender",
          vote: plan.type === "surrender" ? plan.vote : "yes",
          source: seat(other),
        };
      }
    }
    assert.fail("a running vote has no voter");
  }
  if (plan.type === "surrender" && !context.proposed) {
    for (let other = 0; other < playerCount; other += 1) {
      if (has(allowedActions(state, other), "proposeSurrender")) {
        context.proposed = true;
        return { type: "proposeSurrender", source: seat(other) };
      }
    }
  }
  const round = match.currentRound;
  assert.ok(round !== null);
  const turn = round.turn;
  if (plan.type === "disqualify") {
    const move = disqualifyingMove(state, match, turn, plan.kind);
    if (move !== null) {
      return move;
    }
  }
  const allowed = allowedActions(state, turn);
  if (
    plan.type === "ask" &&
    has(allowed, "askReveal") &&
    !(match.hands[turn] ?? []).some((card) => card.suit === round.leadSuit)
  ) {
    return { type: "askReveal", source: seat(turn) };
  }
  const legal = legalCards(state, turn);
  assert.ok(legal.length > 0, "a seat on turn has no legal card");
  // To provoke a forced face-down card, lead the hidden suit when possible.
  const hidden =
    match.contract?.trump.type === "hidden" && match.revealedInRound === null
      ? match.contract.trump.suit
      : null;
  const leadHidden =
    plan.type === "disqualify" &&
    plan.kind === "didNotPlayFaceDown" &&
    round.plays.length === 0
      ? legal.find((card) => card.suit === hidden)
      : undefined;
  return {
    type: "playCard",
    card: leadHidden ?? pick(legal, next),
    source: seat(turn),
  };
}

/** One policy action for `state`, or null when the session is finished. */
function chooseAction(
  state: EngineState,
  context: SessionContext,
): EngineAction {
  const { phase, config } = state;
  const { next } = context;
  switch (phase.type) {
    case "awaitingDeal": {
      // A random redeal retries the same plan; an arranged one moves on.
      if (
        phase.reason !== "redeal" ||
        context.dealCount === 0 ||
        (currentPlan(context).deck ?? "shuffled") !== "shuffled"
      ) {
        context.dealCount += 1;
      }
      context.proposed = false;
      const plan = currentPlan(context);
      return deal(
        arrangedDeck(config, state.dealer, plan.deck ?? "shuffled", next),
      );
    }
    case "matchOver":
      return { type: "startNextMatch", source: system };
    case "sessionOver":
      return {
        type: "restartSession",
        source: system,
        firstDealer: Math.floor(next() * config.playerCount),
      };
    default:
      break;
  }
  const plan = currentPlan(context);
  const { match } = phase;
  if (
    plan.play.type === "restart" &&
    plan.play.phase === phase.type &&
    (phase.type !== "auction" || (match.auction?.calls.length ?? 0) > 0) &&
    (phase.type !== "play" || playedCount(match) >= 3)
  ) {
    return { type: "endMatch", resolution: { type: "restart" }, source: host };
  }
  if (
    plan.play.type === "award" &&
    phase.type === "play" &&
    playedCount(match) >= 5
  ) {
    return {
      type: "endMatch",
      resolution: { type: "award", team: plan.play.team },
      source: host,
    };
  }
  switch (phase.type) {
    case "auction": {
      const stagePlan =
        match.auction?.stage === "28-second"
          ? (plan.second ?? PASS_OUT)
          : plan.first;
      return auctionAction(state, match, stagePlan, next);
    }
    case "placingCard": {
      const bidder = match.auction?.highBid?.seat;
      assert.ok(bidder !== undefined);
      const place = has(allowedActions(state, bidder), "placeCard");
      assert.ok(place !== undefined);
      const hand = match.hands[bidder] ?? [];
      // Placing the only card of a suit lets that suit force the bidder.
      const single =
        plan.play.type === "disqualify" &&
        plan.play.kind === "didNotPlayFaceDown"
          ? place.cards.find(
              (card) =>
                hand.filter((held) => held.suit === card.suit).length === 1,
            )
          : undefined;
      return {
        type: "placeCard",
        card: single ?? pick(place.cards, next),
        source: seat(bidder),
      };
    }
    case "play": {
      const action = playAction(state, match, plan.play, context);
      assert.ok(action !== null);
      return action;
    }
  }
}

/**
 * Plays sessions with the policy until every plan has been dealt at least
 * once and a session has ended, been restarted, and dealt its first match.
 * Every action goes through `step`; every reached state is probed with
 * rejected actions. Finally the whole log rebuilds the state from the seed.
 */
function playSessions(
  config: EngineConfig,
  plans: readonly MatchPlan[],
  seedNumber: number,
): Recorder {
  const next = random(seedNumber);
  const recorder = begin(config, Math.floor(next() * config.playerCount));
  const context: SessionContext = {
    plans,
    next,
    dealCount: 0,
    proposed: false,
  };
  for (let count = 0; ; count += 1) {
    assert.ok(count < 20_000, "the session doesn't finish");
    probeRejections(recorder.state, next, recorder.seen);
    const action = chooseAction(recorder.state, context);
    const events = step(recorder, action);
    if (
      context.dealCount > plans.length &&
      recorder.seen.has("sessionRestarted") &&
      events.some((event) => event.type === "dealt")
    ) {
      break;
    }
  }

  // The complete log, persisted as JSON, rebuilds the final state from the
  // pre-session seed.
  const rebuilt = (JSON.parse(json(recorder.log)) as EngineEvent[]).reduce(
    (state, event) => evolve(state, event),
    JSON.parse(json(recorder.seed)) as EngineState,
  );
  assert.equal(json(rebuilt), json(recorder.state));
  return recorder;
}

// ---------------------------------------------------------------------------

describe("E010 complete sessions", () => {
  const plans56: MatchPlan[] = [
    { first: REDOUBLED, play: { type: "award", team: "A" } },
    { first: SINGLE, play: { type: "legal" } },
    { first: PASS_OUT, play: { type: "legal" } },
    { first: DOUBLED, play: { type: "surrender", vote: "yes" } },
    { first: CONTEST, play: { type: "restart", phase: "auction" } },
    { first: CANCELLED, play: { type: "surrender", vote: "no" } },
    { first: SINGLE, play: { type: "legal" }, deck: "noJackForTeamB" },
    { first: SINGLE, play: { type: "award", team: "A" } },
    { first: SINGLE, play: { type: "restart", phase: "play" } },
    { first: SINGLE, play: { type: "legal" }, deck: "lowHandFirstSeat" },
    { first: DOUBLED, play: { type: "award", team: "B" } },
  ];
  const autoStop56: MatchPlan[] = [
    { first: SINGLE, play: { type: "disqualify", kind: "didNotFollowSuit" } },
    { first: SINGLE, play: { type: "disqualify", kind: "ledTrumpEarly" } },
    { first: SINGLE, play: { type: "surrender", vote: "no" } },
    { first: DOUBLED, play: { type: "surrender", vote: "yes" } },
    ...plans56,
  ];
  const plans28: MatchPlan[] = [
    { first: REDOUBLED, play: { type: "legal" } },
    { first: SINGLE, second: PASS_OUT, play: { type: "ask" } },
    { first: PASS_OUT, second: PASS_OUT, play: { type: "legal" } },
    { first: PASS_OUT, second: SINGLE, play: { type: "legal" } },
    {
      first: DOUBLED,
      second: PASS_OUT,
      play: { type: "surrender", vote: "no" },
    },
    {
      first: DOUBLED,
      second: { bids: 0, redouble: true },
      play: { type: "surrender", vote: "yes" },
    },
    { first: SINGLE, second: CONTEST, play: { type: "ask" } },
    {
      first: SINGLE,
      second: { bids: 1, holderOnly: true },
      play: { type: "legal" },
    },
    { first: SINGLE, second: { bids: 0, double: true }, play: { type: "ask" } },
    { first: SINGLE, second: DOUBLED, play: { type: "award", team: "B" } },
    { first: CANCELLED, second: REDOUBLED, play: { type: "legal" } },
    { first: SINGLE, play: { type: "restart", phase: "placingCard" } },
    {
      first: SINGLE,
      second: SINGLE,
      play: { type: "restart", phase: "auction" },
    },
    { first: SINGLE, play: { type: "legal" }, deck: "noJackForTeamB" },
    { first: SINGLE, play: { type: "legal" }, deck: "lowHandFirstSeat" },
    { first: SINGLE, second: SINGLE, play: { type: "restart", phase: "play" } },
  ];
  const autoStop28: MatchPlan[] = [
    {
      first: SINGLE,
      second: SINGLE,
      play: { type: "disqualify", kind: "didNotPlayFaceDown" },
    },
    {
      first: SINGLE,
      play: { type: "disqualify", kind: "revealWhileAbleToFollow" },
    },
    { first: SINGLE, play: { type: "disqualify", kind: "didNotFollowSuit" } },
    { first: SINGLE, play: { type: "ask" } },
    ...plans28,
  ];

  const sessions: [string, EngineConfig, MatchPlan[], number][] = [
    [
      "56, 4 players, 48 cards, Block",
      config56({ startingTokens: 8 }),
      plans56,
      1,
    ],
    [
      "56, 4 players, 64 cards, Auto-stop",
      config56({
        includeEightsAndSevens: true,
        illegalPlayMode: "autoStop",
        startingTokens: 4,
      }),
      autoStop56,
      2,
    ],
    [
      "56, 6 players, 48 cards, Auto-stop",
      config56({
        playerCount: 6,
        illegalPlayMode: "autoStop",
        startingTokens: 4,
      }),
      autoStop56,
      3,
    ],
    [
      "56, 8 players, 48 cards, Block",
      config56({ playerCount: 8, startingTokens: 4 }),
      plans56,
      4,
    ],
    [
      "56, 8 players, 64 cards, Block",
      config56({
        playerCount: 8,
        includeEightsAndSevens: true,
        startingTokens: 4,
      }),
      plans56,
      5,
    ],
    ["28 Block", config28({ startingTokens: 8 }), plans28, 6],
    [
      "28 Auto-stop",
      config28({ illegalPlayMode: "autoStop", startingTokens: 4 }),
      autoStop28,
      7,
    ],
  ];

  it("hold every guarantee, replay from JSON, and never leak to a viewer", async (t) => {
    const seen = new Set<string>();
    for (const [name, config, plans, seedNumber] of sessions) {
      await t.test(name, () => {
        const recorder = playSessions(config, plans, seedNumber * 7919);
        for (const item of recorder.seen) {
          seen.add(item);
        }
      });
    }

    const required = [
      // Session flow and dealer rotation.
      "sessionStarted",
      "nextMatchStarted",
      "sessionEnded",
      "sessionRestarted",
      // Auctions.
      "forcedBid:56",
      "forcedBid:28",
      "auctionEnded:56:x1",
      "auctionEnded:56:x1:forced",
      "auctionEnded:56:x2",
      "auctionEnded:56:x4",
      "auctionEnded:28:x1",
      "auctionEnded:28:x1:forced",
      "auctionEnded:28:x2",
      "auctionEnded:28:x4",
      "auctionStarted:28-second",
      "28-second:carriedBidStood",
      "28-second:newWinner",
      "doubleCancelled",
      "doubled:28-second",
      "redoubled:28-second",
      "playStarted:28:noTrump",
      "faceDownReturned",
      // Redeals.
      "redealt:56:teamWithoutJack",
      "redealt:56:lowHand",
      "redealt:28:teamWithoutJack",
      "redealt:28:lowHand",
      "redealt:28:faceDownReturned",
      // Play and the hidden trump.
      "revealAsked",
      "trumpRevealed",
      "cardPlayed:fromFaceDown",
      "disqualified:didNotFollowSuit",
      "disqualified:ledTrumpEarly",
      "disqualified:revealWhileAbleToFollow",
      "disqualified:didNotPlayFaceDown",
      "block:56:didNotFollowSuit",
      "block:56:ledTrumpEarly",
      "block:28:didNotFollowSuit",
      "block:28:ledTrumpEarly",
      "block:28:didNotPlayFaceDown",
      "block:28:revealWhileAbleToFollow",
      // Results.
      "matchEnded:56:made",
      "matchEnded:56:failed",
      "matchEnded:28:made",
      "matchEnded:28:failed",
      "matchEnded:56:disqualified",
      "matchEnded:28:disqualified",
      "matchEnded:56:restarted",
      "matchEnded:28:restarted",
      "matchEnded:56:awarded",
      "matchEnded:28:awarded",
      "matchEnded:56:surrendered",
      "matchEnded:28:surrendered",
      // Surrender votes for every team size.
      "resultDecided",
      "surrendered:4",
      "surrendered:6",
      "surrendered:8",
      "surrenderFailed:4",
      "surrenderFailed:6",
      "surrenderFailed:8",
    ];
    assert.deepStrictEqual(
      required.filter((item) => !seen.has(item)),
      [],
    );
  });
});

describe("E010 invariants", () => {
  function invariantCode(state: EngineState): string | null {
    try {
      assertEngineInvariants(state);
      return null;
    } catch (error) {
      assert.ok(error instanceof EngineInvariantError);
      return error.code;
    }
  }

  function withMatch(state: EngineState, match: MatchState): EngineState {
    assert.ok(
      state.phase.type === "auction" ||
        state.phase.type === "placingCard" ||
        state.phase.type === "play",
    );
    return { ...state, phase: { type: state.phase.type, match } };
  }

  it("a running 28 second auction keeps the carried face-down card after any call", () => {
    const next = random(28);
    const recorder = begin(config28(), 0, false);
    // First auction: seat 1 bids, the rest pass, seat 1 places a card;
    // deal again whenever the second deal redeals.
    while (matchOf(recorder.state)?.auction?.stage !== "28-second") {
      step(recorder, deal(shuffled(buildDeck(recorder.config), next)));
      step(recorder, { type: "bid", amount: 16, source: seat(1) });
      for (const other of [2, 3, 0]) {
        step(recorder, pass(other));
      }
      const hand = matchOf(recorder.state)?.hands[1] ?? [];
      step(recorder, {
        type: "placeCard",
        card: hand[0] as Card,
        source: seat(1),
      });
    }
    // A second-auction bid by another team: the old card stays face down
    // with its owner until the auction ends.
    step(recorder, pass(1));
    step(recorder, { type: "bid", amount: 21, source: seat(2) });
    const match = matchOf(recorder.state);
    assert.ok(match !== null && match.faceDown?.owner === 1);
    assert.equal(invariantCode(recorder.state), null);
    assert.equal(
      invariantCode(withMatch(recorder.state, { ...match, faceDown: null })),
      "invalidAuctionState",
    );
    assert.equal(
      invariantCode(
        withMatch(recorder.state, {
          ...match,
          faceDown: { owner: 3, card: match.faceDown.card },
        }),
      ),
      "invalidAuctionState",
    );
  });

  it("finished rounds keep the rules' winner and an exact trump-played flag", () => {
    const next = random(56);
    const recorder = begin(config56({ redealThreshold: 0 }), 0, false);
    while (recorder.state.phase.type === "awaitingDeal") {
      step(recorder, deal(shuffled(buildDeck(recorder.config), next)));
    }
    step(recorder, {
      type: "bid",
      amount: 30,
      suit: "hearts",
      style: "numberFirst",
      source: seat(1),
    });
    for (const other of [2, 3, 0]) {
      step(recorder, pass(other));
    }
    for (let played = 0; played < 8; played += 1) {
      const turn = matchOf(recorder.state)?.currentRound?.turn ?? 0;
      const card = legalCards(recorder.state, turn)[0];
      assert.ok(card !== undefined);
      step(recorder, { type: "playCard", card, source: seat(turn) });
    }
    const match = matchOf(recorder.state);
    assert.ok(match !== null && match.rounds.length === 2);
    const [first, second] = match.rounds;
    assert.ok(first !== undefined && second !== undefined);
    const loser = first.plays.find((play) => play.seat !== first.winner);
    assert.ok(loser !== undefined);
    assert.equal(
      invariantCode(
        withMatch(recorder.state, {
          ...match,
          rounds: [{ ...first, winner: loser.seat }, second],
        }),
      ),
      "invalidRound",
    );
    assert.equal(
      invariantCode(
        withMatch(recorder.state, {
          ...match,
          trumpPlayed: !match.trumpPlayed,
        }),
      ),
      "invalidRound",
    );
  });
});

describe("E010 configs and decks", () => {
  /** rules §3, §9, §10.1: the layouts and redeal caps, written independently. */
  const LAYOUTS: {
    gameType: "56" | "28";
    playerCount: 4 | 6 | 8;
    eights: boolean;
    cards: number;
    cap: number;
  }[] = [
    { gameType: "56", playerCount: 4, eights: false, cards: 48, cap: 13 },
    { gameType: "56", playerCount: 4, eights: true, cards: 64, cap: 13 },
    { gameType: "56", playerCount: 6, eights: false, cards: 48, cap: 8 },
    { gameType: "56", playerCount: 8, eights: false, cards: 48, cap: 6 },
    { gameType: "56", playerCount: 8, eights: true, cards: 64, cap: 6 },
    { gameType: "28", playerCount: 4, eights: true, cards: 32, cap: 6 },
  ];
  const layoutConfig = (layout: (typeof LAYOUTS)[number]): EngineConfig =>
    (layout.gameType === "56" ? config56 : config28)({
      playerCount: layout.playerCount,
      includeEightsAndSevens: layout.eights,
    });

  function isValid(config: EngineConfig): boolean {
    return validateConfig(config) === null;
  }

  it("accepts exactly the rules' game, player-count, and deck layouts", () => {
    for (const gameType of ["56", "28"] as const) {
      for (const playerCount of [2, 4, 5, 6, 8, 10]) {
        for (const eights of [false, true]) {
          for (const illegalPlayMode of ["block", "autoStop"] as const) {
            for (const surrenderOption of ["off", "on"] as const) {
              const config = (gameType === "56" ? config56 : config28)({
                playerCount: playerCount as 4,
                includeEightsAndSevens: eights,
                illegalPlayMode,
                surrenderOption,
                redealThreshold: 0,
              });
              const expected = LAYOUTS.some(
                (layout) =>
                  layout.gameType === gameType &&
                  layout.playerCount === playerCount &&
                  layout.eights === eights,
              );
              assert.equal(isValid(config), expected, json(config));
              const started = newSession(config, 0);
              assert.equal(started.ok, expected);
              if (!started.ok) {
                assert.equal(started.code, "invalidConfig");
              }
            }
          }
        }
      }
    }
    for (const invalid of [
      { gameType: "57" },
      { illegalPlayMode: "strict" },
      { surrenderOption: "maybe" },
      { includeEightsAndSevens: "yes" },
    ]) {
      assert.equal(
        isValid({ ...config56(), ...invalid } as unknown as EngineConfig),
        false,
      );
    }
  });

  it("bounds the redeal threshold, starting tokens, and stake tiers", () => {
    for (const layout of LAYOUTS) {
      const base = layoutConfig(layout);
      assert.equal(isValid({ ...base, redealThreshold: 0 }), true);
      assert.equal(isValid({ ...base, redealThreshold: layout.cap }), true);
      for (const threshold of [layout.cap + 1, -1, 0.5, Number.NaN]) {
        assert.equal(isValid({ ...base, redealThreshold: threshold }), false);
      }
      for (const tokens of [1, 999]) {
        assert.equal(isValid({ ...base, startingTokens: tokens }), true);
      }
      for (const tokens of [0, 1000, 1.5, Number.NaN, "10"]) {
        assert.equal(
          isValid({ ...base, startingTokens: tokens as number }),
          false,
        );
      }
    }

    for (const [config, low, high] of [
      [config56(), 28, 56],
      [config28(), 14, 28],
    ] as const) {
      const tier = (
        fromBid: number,
        toBid: number,
        winStake = 1,
        lossStake = 2,
      ): StakeTier => ({ fromBid, toBid, winStake, lossStake });
      const accepted: StakeTier[][] = [
        [tier(low, high)],
        [tier(low, low), tier(low + 1, high, 1, 2)],
        [tier(low, low + 1, 999, 999), tier(low + 2, high, 999, 999)],
      ];
      const refused: StakeTier[][] = [
        [],
        [tier(low + 1, high)],
        [tier(low, high - 1)],
        [tier(low, low + 1), tier(low + 3, high)],
        [tier(low, low + 2), tier(low + 2, high)],
        [tier(low, low + 1, 2, 2), tier(low + 2, high, 1, 2)],
        [tier(low, low + 1, 1, 3), tier(low + 2, high, 1, 2)],
        [tier(low, high, 0, 2)],
        [tier(low, high, 1, 1000)],
        [tier(low, high, 1.5, 2)],
        [tier(low - 1, high)],
        [tier(low, high + 1)],
      ];
      for (const stakeTiers of accepted) {
        assert.equal(
          isValid({ ...config, stakeTiers }),
          true,
          json(stakeTiers),
        );
      }
      for (const stakeTiers of refused) {
        assert.equal(
          isValid({ ...config, stakeTiers }),
          false,
          json(stakeTiers),
        );
      }
    }
  });

  it("deals exactly the configured card multiset and rejects every other deck", () => {
    const next = random(10);
    for (const layout of LAYOUTS) {
      const config = layoutConfig(layout);
      const deck = buildDeck(config);
      assert.equal(deck.length, layout.cards);
      assert.equal(new Set(deck.map(cardKey)).size, layout.cards);
      assert.equal(
        deck.reduce((total, card) => total + cardPoints(card), 0),
        layout.gameType === "56" ? 56 : 28,
      );

      const recorder = begin({ ...config, redealThreshold: 0 }, 0, false);
      const state = recorder.state;
      const base = shuffled(deck, next);
      const [first, second] = base as [Card, Card];
      const otherCopy: Card = {
        ...first,
        copy: layout.gameType === "56" ? 3 : 2,
      } as unknown as Card;
      const excludedRank = deck.some((card) => card.rank === "8")
        ? null
        : ({ suit: "spades", rank: "8", copy: 1 } as Card);
      const invalid: unknown[] = [
        base.slice(1),
        [...base, first],
        [...base.slice(0, -1), first],
        [{ suit: "spades", rank: "6", copy: 1 }, ...base.slice(1)],
        [{ suit: "stars", rank: "J", copy: 1 }, ...base.slice(1)],
        [otherCopy, ...base.slice(1)],
        ...(excludedRank === null ? [] : [[excludedRank, ...base.slice(1)]]),
        [null, ...base.slice(1)],
        [second, second, ...base.slice(2)],
        [],
        null,
        "deck",
      ];
      for (const bad of invalid) {
        assert.equal(
          rejected(state, deal(bad as Card[])),
          "invalidDeck",
          `${layout.cards}-card ${layout.gameType}`,
        );
      }

      // An exact multiset is accepted in any order. Deal again until no
      // redeal intervenes, so the dealt hands can be counted.
      let dealt: EngineEvent[] = [];
      do {
        dealt = step(recorder, deal(shuffled(deck, next)));
      } while (recorder.state.phase.type === "awaitingDeal");
      const match = matchOf(recorder.state);
      assert.ok(match !== null);
      const perSeat = layout.cards / layout.playerCount;
      if (layout.gameType === "56") {
        assert.deepEqual(
          match.hands.map((hand) => hand.length),
          Array(layout.playerCount).fill(perSeat),
        );
        assert.equal(match.undealt, null);
      } else {
        assert.deepEqual(
          match.hands.map((hand) => hand.length),
          [4, 4, 4, 4],
        );
        assert.deepEqual(
          match.undealt?.map((cards) => cards.length),
          [4, 4, 4, 4],
        );
      }
      assert.equal(dealt[0]?.type, "dealt");
    }
  });
});

describe("E010 package boundary", () => {
  const sourceDir = import.meta.dirname;

  it("the engine package declares no dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(sourceDir, "..", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      assert.equal(manifest[field], undefined, field);
    }
  });

  it("production modules import only each other and touch no I/O, time, or randomness", () => {
    const files = readdirSync(sourceDir).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "test-helpers.ts",
    );
    assert.ok(files.includes("engine.ts") && files.includes("index.ts"));
    const forbidden = [
      /\bMath\.random\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /\bconsole\b/,
      /\bprocess\b/,
      /\bglobalThis\b/,
      /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/,
      /\b(fetch|XMLHttpRequest|WebSocket)\b/,
      /\bcrypto\b/,
      /\brequire\s*\(/,
      /\b(window|document|navigator|localStorage|sessionStorage)\b/,
    ];
    for (const file of files) {
      const source = readFileSync(join(sourceDir, file), "utf8");
      const specifiers = [
        ...source.matchAll(/\bfrom\s+"([^"]+)"/g),
        ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g),
        ...source.matchAll(/^\s*import\s+"([^"]+)"/gm),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        assert.match(
          specifier ?? "",
          /^\.\/[a-z-]+\.js$/,
          `${file} imports ${specifier}`,
        );
        assert.ok(
          files.includes((specifier ?? "").slice(2).replace(/\.js$/, ".ts")),
          `${file} imports a non-production module ${specifier}`,
        );
      }
      // Comments and string literals may name these words; code may not.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/`(?:\\.|[^`\\])*`/g, "``")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(code), `${file} uses ${pattern}`);
      }
    }
  });
});
