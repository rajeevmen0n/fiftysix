import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineAction } from "./actions.js";
import { buildDeck, SUITS } from "./cards.js";
import { act, decide, evolve, newSession } from "./engine.js";
import type { EngineEvent, EngineEventType, EventOfType } from "./events.js";
import { assertEngineInvariants } from "./invariants.js";
import { legalCards } from "./play.js";
import { teamOf } from "./seats.js";
import type { EnginePhaseType, EngineState, MatchState } from "./state.js";
import { deepFreeze } from "./test-helpers.js";
import type {
  BidStyle,
  BidSuit,
  Card,
  EngineConfig,
  Rank,
  Suit,
  Team,
} from "./types.js";
import {
  type AllowedEngineAction,
  allowedActions,
  allowedHostActions,
  type EngineView,
  type RedactedEngineEvent,
  redactEvent,
  type Viewer,
  type ViewSettings,
  view,
} from "./views.js";

// E009: capabilities, views, and event redaction (design §11–§12).

const STAKES_56 = [
  { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
  { fromBid: 40, toBid: 55, winStake: 2, lossStake: 3 },
  { fromBid: 56, toBid: 56, winStake: 3, lossStake: 4 },
];
const STAKES_28 = [
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

// 28, dealer 0 (the E007 play deal). Seat 1 bids, places the jack of hearts
// and holds no other heart; with first-legal play, team A collects 16 of the
// first 19 points, so a bid of 16 is certainly lost after the fifth round,
// before any reveal.
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
const HIDDEN_SUIT: Suit = "hearts";

const seat = (value: number) => ({ type: "seat", seat: value }) as const;
const system = { type: "system" } as const;
const host = { type: "host" } as const;

const deal = (deck: readonly Card[]): EngineAction => ({
  type: "deal",
  source: system,
  deck,
});
const bid56 = (
  seatNumber: number,
  amount: number,
  suit: BidSuit,
  style?: BidStyle,
): EngineAction =>
  style === undefined
    ? { type: "bid", amount, suit, source: seat(seatNumber) }
    : { type: "bid", amount, suit, style, source: seat(seatNumber) };
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
const place = (seatNumber: number, card: Card): EngineAction => ({
  type: "placeCard",
  card,
  source: seat(seatNumber),
});
const play = (seatNumber: number, code: string): EngineAction => ({
  type: "playCard",
  card: c(code),
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

const DEFAULT_SETTINGS: ViewSettings = {
  roundHistory: "last",
  livePoints: false,
};
const ALL_SETTINGS: readonly ViewSettings[] = (
  ["none", "last", "full"] as const
).flatMap((roundHistory) =>
  [false, true].map((livePoints) => ({ roundHistory, livePoints })),
);

function viewers(state: EngineState): Viewer[] {
  return [
    ...Array.from(
      { length: state.config.playerCount },
      (_, seatNumber): Viewer => ({ type: "seat", seat: seatNumber }),
    ),
    { type: "table" },
  ];
}

function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}:${card.copy}`;
}

function matchOf(state: EngineState): MatchState {
  if (!("match" in state.phase)) {
    throw new Error("expected a match in progress");
  }
  return state.phase.match;
}

function seatView(engineView: EngineView) {
  const { viewer } = engineView;
  assert.equal(viewer.type, "seat");
  if (viewer.type !== "seat") {
    throw new Error("unreachable");
  }
  return viewer;
}

function only<T extends EngineEventType>(
  events: readonly EngineEvent[],
  type: T,
): EventOfType<T> {
  const found = events.filter(
    (event): event is EventOfType<T> => event.type === type,
  );
  assert.equal(found.length, 1, `expected one ${type} event`);
  return found[0] as EventOfType<T>;
}

// ---------------------------------------------------------------------------
// Oracles shared by the scenario tests and the exhaustive exploration

/** Every card object (`{suit, rank, copy}`) anywhere inside `value`. */
function cardKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      cardKeysIn(item, found);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("suit" in record && "rank" in record && "copy" in record) {
      found.push(cardKey(record as unknown as Card));
    }
    for (const item of Object.values(record)) {
      cardKeysIn(item, found);
    }
  }
  return found;
}

/** Every non-card object inside `value` that carries a `suit` field. */
function suitFieldsIn(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      suitFieldsIn(item, found);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("suit" in record && !("rank" in record)) {
      found.push(record.suit);
    }
    for (const item of Object.values(record)) {
      suitFieldsIn(item, found);
    }
  }
  return found;
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

/** Plain JSON data only: no `undefined`, functions, classes, or cycles. */
function assertJsonSafe(value: unknown): void {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value);
}

/**
 * Writes into every object and array inside a projection. Projections are
 * fresh data, so this must succeed; it throws (strict mode) if any part is
 * shared with frozen state or a frozen event.
 */
function scribble(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      scribble(item);
    }
    value.push("scribbled");
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      scribble(item);
    }
    (value as Record<string, unknown>).scribbled = true;
  }
}

/** Card keys a viewer must never see: other hands, `undealt`, a face-down card it doesn't own. */
function forbiddenCards(state: EngineState, viewer: Viewer): Set<string> {
  const forbidden = new Set<string>();
  if (!("match" in state.phase)) {
    return forbidden;
  }
  const { match } = state.phase;
  const own = viewer.type === "seat" ? viewer.seat : null;
  match.hands.forEach((hand, seatNumber) => {
    if (seatNumber !== own) {
      for (const card of hand) {
        forbidden.add(cardKey(card));
      }
    }
  });
  for (const card of (match.undealt ?? []).flat()) {
    forbidden.add(cardKey(card));
  }
  if (match.faceDown !== null && match.faceDown.owner !== own) {
    forbidden.add(cardKey(match.faceDown.card));
  }
  return forbidden;
}

/** The unrevealed 28 trump suit while one is standing, otherwise null. */
function unrevealedSuit(state: EngineState): Suit | null {
  if (!("match" in state.phase)) {
    return null;
  }
  const { contract, revealedInRound } = state.phase.match;
  return contract?.trump.type === "hidden" && revealedInRound === null
    ? contract.trump.suit
    : null;
}

function checkView(
  state: EngineState,
  viewer: Viewer,
  settings: ViewSettings,
): EngineView {
  const projected = view(state, viewer, settings);
  assertJsonSafe(projected);
  const match = "match" in state.phase ? state.phase.match : null;

  // Hands, `undealt`, and someone else's face-down card never appear.
  const forbidden = forbiddenCards(state, viewer);
  for (const key of cardKeysIn(projected)) {
    assert.ok(!forbidden.has(key), `view leaks ${key}`);
  }

  // An unrevealed 28 trump suit only reaches the bidder, and only as the
  // standing contract's trump (or its own face-down card).
  const hidden = unrevealedSuit(state);
  const contract = match?.contract ?? null;
  const isBidder =
    contract !== null &&
    viewer.type === "seat" &&
    viewer.seat === contract.bidder;
  if (hidden !== null && !isBidder) {
    assert.deepEqual(projected.contract?.trump, { type: "hidden", suit: null });
    // Earlier matches' summaries may name their own revealed trump; they
    // are checked separately below.
    const current = { ...projected, matchLog: [] };
    assert.ok(
      !suitFieldsIn(current).includes(hidden),
      "view leaks the hidden suit",
    );
  }
  if (hidden !== null && isBidder) {
    assert.deepEqual(projected.contract?.trump, {
      type: "hidden",
      suit: hidden,
    });
  }

  // Summaries never name an unrevealed trump, for any recipient.
  for (const summaryTrump of trumpsIn([
    projected.matchLog,
    "summary" in projected.phase ? projected.phase.summary : null,
  ])) {
    const trump = summaryTrump as { type: string };
    if (trump.type === "hidden") {
      assert.deepEqual(trump, { type: "hidden" });
    }
  }

  // The face-down marker: face up for its owner only.
  if (match?.faceDown != null) {
    const owner = match.faceDown.owner;
    assert.deepEqual(
      projected.faceDown,
      viewer.type === "seat" && viewer.seat === owner
        ? { owner, visibility: "visible", card: match.faceDown.card }
        : { owner, visibility: "hidden" },
    );
  } else {
    assert.equal(projected.faceDown, null);
  }

  // Display settings.
  if (match === null) {
    assert.deepEqual(projected.rounds, []);
    assert.equal(projected.points, null);
  } else {
    const finished = match.rounds.length;
    const expected =
      settings.roundHistory === "none"
        ? 0
        : settings.roundHistory === "last"
          ? Math.min(1, finished)
          : finished;
    assert.equal(projected.rounds.length, expected);
    assert.deepEqual(
      projected.points,
      settings.livePoints ? match.points : null,
    );
    for (const round of projected.rounds) {
      assert.equal(round.points === null, !settings.livePoints);
    }
  }
  assert.deepEqual(
    projected.cardCounts,
    Array.from(
      { length: state.config.playerCount },
      (_, seatNumber) => match?.hands[seatNumber]?.length ?? 0,
    ),
  );

  // Seat-only data.
  if (viewer.type === "table") {
    assert.deepEqual(projected.viewer, { type: "table" });
  } else {
    const own = seatView(projected);
    assert.deepEqual(own.hand, match?.hands[viewer.seat] ?? []);
    assert.deepEqual(
      own.faceDownCard,
      match?.faceDown?.owner === viewer.seat ? match.faceDown.card : null,
    );
    assert.deepEqual(own.allowedActions, allowedActions(state, viewer.seat));
    const decided = match?.surrender.decided ?? null;
    assert.equal(
      own.resultDecided,
      decided !== null && teamOf(viewer.seat) === decided ? decided : null,
    );
  }

  // Certainty is invisible to everyone outside the losing team: their view
  // is the same as if the result were still open (a running vote is public).
  if (match !== null && match.surrender.decided !== null) {
    const losing = match.surrender.decided;
    if (
      match.surrender.vote === null &&
      (viewer.type === "table" || teamOf(viewer.seat) !== losing)
    ) {
      const open: EngineState = {
        ...state,
        phase: {
          ...(state.phase as { type: "play"; match: MatchState }),
          match: { ...match, surrender: { ...match.surrender, decided: null } },
        },
      };
      assert.deepEqual(view(open, viewer, settings), projected);
    }
  }
  return projected;
}

/** The redacted form of `event` must follow design §11.2 for `viewer`. */
function checkRedaction(
  event: EngineEvent,
  viewer: Viewer,
  settings: ViewSettings,
): RedactedEngineEvent | null {
  const redacted = redactEvent(event, viewer, settings);
  const own = viewer.type === "seat" ? viewer.seat : null;
  switch (event.type) {
    case "dealt": {
      assert.deepEqual(redacted, {
        type: "dealt",
        stage: event.stage,
        hand: own === null ? null : (event.hands[own] ?? []),
        cardCounts: event.hands.map((hand) => hand.length),
      });
      break;
    }
    case "cardPlaced":
    case "faceDownReturned":
      assert.deepEqual(redacted, {
        type: event.type,
        seat: event.seat,
        card: own === event.seat ? event.card : null,
      });
      break;
    case "auctionEnded": {
      const { trump } = event.contract;
      const expected =
        trump.type === "hidden"
          ? {
              type: "hidden",
              suit: own === event.contract.bidder ? trump.suit : null,
            }
          : trump;
      assert.deepEqual(redacted, {
        type: "auctionEnded",
        contract: { ...event.contract, trump: expected },
      });
      break;
    }
    case "roundWon":
      assert.deepEqual(redacted, {
        ...event,
        points: settings.livePoints ? event.points : null,
      });
      break;
    case "resultDecided":
      assert.deepEqual(
        redacted,
        own !== null && teamOf(own) === event.losingTeam ? event : null,
      );
      break;
    case "matchEnded":
      assert.deepEqual(redacted, event);
      for (const trump of trumpsIn(redacted)) {
        if ((trump as { type: string }).type === "hidden") {
          assert.deepEqual(trump, { type: "hidden" });
        }
      }
      break;
    default:
      assert.deepEqual(redacted, event);
  }
  if (redacted !== null) {
    assertJsonSafe(redacted);
  }
  return redacted;
}

const DUMMY_SEAT = { type: "seat", seat: 0 } as const;

function actionKey(action: EngineAction): string {
  switch (action.type) {
    case "bid":
      return `bid:${action.amount}:${action.suit ?? "-"}:${action.style ?? "-"}`;
    case "placeCard":
    case "playCard":
      return `${action.type}:${cardKey(action.card)}`;
    case "voteSurrender":
      return `vote:${action.vote}`;
    default:
      return action.type;
  }
}

/** The concrete seat actions an allowed-action list stands for. */
function expand(
  allowed: readonly AllowedEngineAction[],
  seatNumber: number,
): EngineAction[] {
  const source = seat(seatNumber);
  const actions: EngineAction[] = [];
  for (const entry of allowed) {
    switch (entry.type) {
      case "bid":
        for (
          let amount = entry.range.minimum;
          amount <= entry.range.maximum;
          amount += 1
        ) {
          if (entry.suits.length === 0) {
            assert.deepEqual(entry.styles, []);
            actions.push({ type: "bid", amount, source });
          }
          for (const suit of entry.suits) {
            if (suit === "noTrump") {
              actions.push({ type: "bid", amount, suit, source });
            } else {
              for (const style of entry.styles) {
                actions.push({ type: "bid", amount, suit, style, source });
              }
            }
          }
        }
        break;
      case "placeCard":
      case "playCard":
        assert.ok(entry.cards.length > 0);
        for (const card of entry.cards) {
          actions.push({ type: entry.type, card, source });
        }
        break;
      case "voteSurrender":
        for (const choice of entry.votes) {
          actions.push({ type: "voteSurrender", vote: choice, source });
        }
        break;
      case "pass":
      case "double":
      case "redouble":
      case "askReveal":
      case "proposeSurrender":
        actions.push({ type: entry.type, source });
        break;
    }
  }
  return actions;
}

const BID_SUIT_CHOICES: readonly (BidSuit | undefined)[] = [
  undefined,
  ...SUITS,
  "noTrump",
];
const BID_STYLE_CHOICES: readonly (BidStyle | undefined)[] = [
  undefined,
  "numberFirst",
  "suitFirst",
];

/** A broad probe of seat actions, legal or not. */
function candidates(state: EngineState, seatNumber: number): EngineAction[] {
  const source = seat(seatNumber);
  const actions: EngineAction[] = [
    { type: "pass", source },
    { type: "double", source },
    { type: "redouble", source },
    { type: "askReveal", source },
    { type: "proposeSurrender", source },
    { type: "voteSurrender", vote: "yes", source },
    { type: "voteSurrender", vote: "no", source },
  ];
  // In an auction, every amount from one below the game's range to one above
  // it; elsewhere a single bid (rejected by phase) is enough.
  const [lowest, highest] =
    state.config.gameType === "56" ? [27, 57] : [13, 29];
  const amounts =
    state.phase.type === "auction"
      ? Array.from(
          { length: highest - lowest + 1 },
          (_, index) => lowest + index,
        )
      : [28];
  for (const amount of amounts) {
    for (const suit of BID_SUIT_CHOICES) {
      for (const style of BID_STYLE_CHOICES) {
        const bid: EngineAction = { type: "bid", amount, source };
        if (suit !== undefined) {
          bid.suit = suit;
        }
        if (style !== undefined) {
          bid.style = style;
        }
        actions.push(bid);
      }
    }
  }
  for (const card of buildDeck(state.config)) {
    actions.push({ type: "placeCard", card, source });
    actions.push({ type: "playCard", card, source });
  }
  return actions;
}

/**
 * design §12: every listed action is accepted by `decide`, and every probed
 * action `decide` accepts is listed. Host capability matches `decide` too.
 */
function checkCapabilities(state: EngineState): void {
  for (
    let seatNumber = 0;
    seatNumber < state.config.playerCount;
    seatNumber += 1
  ) {
    const listed = allowedActions(state, seatNumber);
    assertJsonSafe(listed);
    const concrete = expand(listed, seatNumber);
    const keys = new Set(concrete.map(actionKey));
    assert.equal(keys.size, concrete.length, "duplicate allowed action");
    for (const action of concrete) {
      const decision = decide(state, action);
      assert.ok(
        decision.ok,
        `listed ${actionKey(action)} for seat ${seatNumber} is rejected: ${JSON.stringify(decision)}`,
      );
    }
    for (const action of candidates(state, seatNumber)) {
      if (decide(state, action).ok) {
        assert.ok(
          keys.has(actionKey(action)),
          `accepted ${actionKey(action)} for seat ${seatNumber} is not listed`,
        );
      }
    }
  }

  const hostActions = allowedHostActions(state);
  assert.equal(hostActions.restart, decide(state, restart).ok);
  for (const team of ["A", "B"] as const) {
    assert.equal(
      hostActions.awardTeams.includes(team),
      decide(state, award(team)).ok,
    );
  }
}

/** Views and capabilities for every viewer never mutate or share state. */
function checkState(state: EngineState): void {
  seenPhases.add(state.phase.type);
  for (
    let seatNumber = 0;
    seatNumber < state.config.playerCount;
    seatNumber += 1
  ) {
    for (const entry of allowedActions(state, seatNumber)) {
      seenCapabilities.add(entry.type);
    }
  }
  deepFreeze(state);
  const before = JSON.stringify(state);
  checkCapabilities(state);
  // Every settings combination for seat 0 and the Table view; the other
  // seats only differ by whose private data is projected.
  for (const viewer of viewers(state)) {
    const everySetting =
      viewer.type === "table" || (viewer.type === "seat" && viewer.seat === 0);
    for (const settings of everySetting ? ALL_SETTINGS : [DEFAULT_SETTINGS]) {
      scribble(checkView(state, viewer, settings));
    }
  }
  scribble(allowedHostActions(state));
  assert.equal(JSON.stringify(state), before);
}

// Coverage of the checked states and events, asserted at the end of the file.
const seenEvents = new Set<string>();
const seenPhases = new Set<EnginePhaseType>();
const seenCapabilities = new Set<AllowedEngineAction["type"]>();

function checkEvents(state: EngineState, events: readonly EngineEvent[]): void {
  for (const event of events) {
    seenEvents.add(event.type);
    if (event.type === "cardPlayed" && event.fromFaceDown) {
      seenEvents.add("cardPlayed(fromFaceDown)");
    }
    if (event.type === "disqualified") {
      seenEvents.add(`disqualified(${event.kind})`);
    }
    deepFreeze(event);
    const before = JSON.stringify(event);
    for (const viewer of viewers(state)) {
      for (const livePoints of [false, true]) {
        scribble(
          checkRedaction(event, viewer, { roundHistory: "full", livePoints }),
        );
      }
    }
    assert.equal(JSON.stringify(event), before);
  }
}

// ---------------------------------------------------------------------------
// Flows

interface Flow {
  state: EngineState;
  /** Events of the last accepted action. */
  events: EngineEvent[];
  /** Every event since `newSession`, in order. */
  log: EngineEvent[];
}

function start(config: EngineConfig, firstDealer = 0): Flow {
  const started = newSession(config, firstDealer);
  assert.ok(started.ok);
  return {
    state: started.state,
    events: started.events,
    log: [...started.events],
  };
}

/** Applies each action via `act`, asserting acceptance, replay, and invariants. */
function run(flow: Flow, actions: readonly EngineAction[]): Flow {
  let { state, events } = flow;
  const log = [...flow.log];
  for (const action of actions) {
    const result = act(state, action);
    assert.ok(
      result.ok,
      `expected ${actionKey(action)} to be accepted: ${JSON.stringify(result)}`,
    );
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
  return { state, events, log };
}

/** 28 with DEAL_28: seat 1 bids 16, places the jack of hearts; second auction passes out. */
function playing28(config: EngineConfig = config28()): Flow {
  const flow = run(start(config), [
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
  ]);
  assert.equal(flow.state.phase.type, "play");
  return flow;
}

/** DEAL_28 up to seat 1's turn in round 2 with hearts (the hidden suit) led. */
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

function turnOf(state: EngineState): number {
  const round = matchOf(state).currentRound;
  assert.ok(round !== null);
  return round.turn;
}

/** Plays the first legal card for whoever's turn it is until `done`. */
function playUntil(flow: Flow, done: (flow: Flow) => boolean): Flow {
  let current = flow;
  while (!done(current)) {
    assert.equal(current.state.phase.type, "play");
    const turn = turnOf(current.state);
    const [card] = legalCards(current.state, turn);
    assert.ok(card !== undefined);
    current = run(current, [{ type: "playCard", card, source: seat(turn) }]);
  }
  return current;
}

function views(state: EngineState, settings = DEFAULT_SETTINGS) {
  return viewers(state).map((viewer) => view(state, viewer, settings));
}

// ---------------------------------------------------------------------------

describe("views: 28 hidden trump", () => {
  it("dealt: own cards and counts only; the Table view gets counts; undealt never", () => {
    const flow = run(start(config28()), [deal(DEAL_28)]);
    const dealt = only(flow.events, "dealt");
    assert.ok(dealt.undealt !== null);
    for (const seatNumber of [0, 1, 2, 3]) {
      const redacted = redactEvent(dealt, seat(seatNumber), DEFAULT_SETTINGS);
      assert.deepEqual(redacted, {
        type: "dealt",
        stage: "first",
        hand: dealt.hands[seatNumber],
        cardCounts: [4, 4, 4, 4],
      });
    }
    assert.deepEqual(redactEvent(dealt, { type: "table" }, DEFAULT_SETTINGS), {
      type: "dealt",
      stage: "first",
      hand: null,
      cardCounts: [4, 4, 4, 4],
    });
    checkEvents(flow.state, flow.log);
    checkState(flow.state);
  });

  it("placement: the card and suit reach only the bidder until the reveal", () => {
    const flow = run(start(config28()), [
      deal(DEAL_28),
      bid28(1, 16),
      pass(2),
      pass(3),
      pass(0),
    ]);
    assert.deepEqual(view(flow.state, seat(1), DEFAULT_SETTINGS).phase, {
      type: "placingCard",
      seat: 1,
    });
    assert.deepEqual(
      seatView(view(flow.state, seat(1), DEFAULT_SETTINGS)).allowedActions,
      [{ type: "placeCard", cards: cards("HJ SA S10 SK") }],
    );
    assert.deepEqual(
      seatView(view(flow.state, seat(0), DEFAULT_SETTINGS)).allowedActions,
      [],
    );

    const placed = run(flow, [place(1, c("HJ"))]);
    const cardPlaced = only(placed.events, "cardPlaced");
    const auctionEnded = only(placed.events, "auctionEnded");
    assert.deepEqual(
      redactEvent(cardPlaced, seat(1), DEFAULT_SETTINGS),
      cardPlaced,
    );
    assert.deepEqual(
      redactEvent(auctionEnded, seat(1), DEFAULT_SETTINGS),
      auctionEnded,
    );
    for (const viewer of [
      seat(0),
      seat(2),
      seat(3),
      { type: "table" } as const,
    ]) {
      assert.deepEqual(redactEvent(cardPlaced, viewer, DEFAULT_SETTINGS), {
        type: "cardPlaced",
        seat: 1,
        card: null,
      });
      assert.deepEqual(redactEvent(auctionEnded, viewer, DEFAULT_SETTINGS), {
        type: "auctionEnded",
        contract: {
          ...auctionEnded.contract,
          trump: { type: "hidden", suit: null },
        },
      });
    }

    // The second auction is running with the first-auction contract.
    const [s0, s1, s2, s3, table] = views(placed.state);
    assert.ok(s0 && s1 && s2 && s3 && table);
    assert.equal(placed.state.phase.type, "auction");
    assert.deepEqual(s1.contract?.trump, { type: "hidden", suit: "hearts" });
    assert.deepEqual(s1.faceDown, {
      owner: 1,
      visibility: "visible",
      card: c("HJ"),
    });
    assert.deepEqual(seatView(s1).faceDownCard, c("HJ"));
    assert.deepEqual(seatView(s1).hand, cards("SA S10 SK SQ D7 C7 C8"));
    for (const other of [s0, s2, s3, table]) {
      assert.deepEqual(other.contract?.trump, { type: "hidden", suit: null });
      assert.deepEqual(other.faceDown, { owner: 1, visibility: "hidden" });
      assert.ok(!cardKeysIn(other).includes(cardKey(c("HJ"))));
    }
    assert.deepEqual(s0.cardCounts, [8, 7, 8, 8]);
    assert.deepEqual(table.viewer, { type: "table" });
    assert.deepEqual(s0.auction?.stage, "28-second");
    assert.equal(s0.auction?.turn, 1);
    checkEvents(placed.state, placed.log);
    checkState(placed.state);
  });

  it("the forced face-down card: Block lists only it; Auto-stop adds every hand card", () => {
    const blocked = heartsLedToBidder();
    assert.deepEqual(allowedActions(blocked.state, 1), [
      { type: "playCard", cards: [c("HJ")] },
    ]);
    checkState(blocked.state);

    const autoStop = heartsLedToBidder(
      config28({ illegalPlayMode: "autoStop" }),
    );
    assert.deepEqual(allowedActions(autoStop.state, 1), [
      { type: "playCard", cards: [...cards("SA S10 SK SQ D7 C8"), c("HJ")] },
    ]);
    checkState(autoStop.state);
  });

  it("after the reveal the trump is public and the face-down marker is gone", () => {
    const flow = run(heartsLedToBidder(), [play(1, "HJ")]);
    checkEvents(flow.state, flow.events);
    assert.deepEqual(
      redactEvent(flow.events[0] as EngineEvent, seat(0), DEFAULT_SETTINGS),
      {
        type: "trumpRevealed",
        card: c("HJ"),
      },
    );
    for (const projected of views(flow.state, {
      roundHistory: "full",
      livePoints: true,
    })) {
      assert.deepEqual(projected.contract?.trump, {
        type: "suit",
        suit: "hearts",
      });
      assert.equal(projected.faceDown, null);
      assert.deepEqual(
        projected.rounds.map((round) => round.revealedInRound),
        [false, true],
      );
      assert.deepEqual(projected.rounds[1]?.plays.at(-1), {
        seat: 1,
        card: c("HJ"),
        fromFaceDown: true,
      });
    }
    checkState(flow.state);
  });

  it("Auto-stop asking while able to follow is listed; Block lists no reveal then", () => {
    // Seat 3 holds hearts when hearts are led in round 2 (seat 2 leads H9).
    const block = run(playing28(), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "H9"),
    ]);
    assert.deepEqual(allowedActions(block.state, 3), [
      { type: "playCard", cards: cards("HQ H8 H7") },
    ]);
    const autoStop = run(playing28(config28({ illegalPlayMode: "autoStop" })), [
      play(1, "C7"),
      play(2, "CJ"),
      play(3, "CK"),
      play(0, "DK"),
      play(2, "H9"),
    ]);
    assert.deepEqual(allowedActions(autoStop.state, 3), [
      { type: "playCard", cards: cards("HQ H8 H7 D9 DQ D8 CQ") },
      { type: "askReveal" },
    ]);
    // Seat 0 can't follow hearts: Block offers the reveal.
    const toSeat0 = run(block, [play(3, "H8")]);
    assert.deepEqual(
      allowedActions(toSeat0.state, 0).map((entry) => entry.type),
      ["playCard", "askReveal"],
    );
    checkState(block.state);
    checkState(autoStop.state);
    checkState(toSeat0.state);

    // After asking, the reveal is public and the asker may play any card.
    const asked = run(toSeat0, [ask(0)]);
    checkEvents(asked.state, asked.events);
    assert.deepEqual(
      asked.events.map((event) =>
        redactEvent(event, seat(2), DEFAULT_SETTINGS),
      ),
      [
        { type: "revealAsked", seat: 0 },
        { type: "trumpRevealed", card: c("HJ") },
      ],
    );
    assert.deepEqual(allowedActions(asked.state, 0), [
      { type: "playCard", cards: cards("SJ S9 S8 S7 DJ DA D10") },
    ]);
    for (const projected of views(asked.state)) {
      assert.deepEqual(projected.contract?.trump, {
        type: "suit",
        suit: "hearts",
      });
      assert.equal(projected.currentRound?.revealAskedBy, 0);
      assert.equal(projected.currentRound?.revealedInRound, true);
    }
    checkState(asked.state);
  });

  it("didNotPlayFaceDown: the match ends with the card and suit unrevealed for everyone", () => {
    const flow = run(
      heartsLedToBidder(config28({ illegalPlayMode: "autoStop" })),
      [play(1, "SQ")],
    );
    assert.equal(flow.state.phase.type, "matchOver");
    checkEvents(flow.state, flow.events);
    for (const viewer of viewers(flow.state)) {
      for (const event of flow.events) {
        const redacted = redactEvent(event, viewer, DEFAULT_SETTINGS);
        assert.ok(!cardKeysIn(redacted).includes(cardKey(c("HJ"))));
      }
      const projected = view(flow.state, viewer, DEFAULT_SETTINGS);
      // Only the accepted exception remains: the outcome kind itself.
      assert.ok(!JSON.stringify(projected).includes(HIDDEN_SUIT));
      assert.deepEqual(projected.matchLog.at(-1)?.outcome, {
        type: "disqualified",
        seat: 1,
        kind: "didNotPlayFaceDown",
      });
    }
    checkState(flow.state);
  });
});

describe("views: surrender certainty", () => {
  it("resultDecided reaches only the losing team; proposals and votes follow it", () => {
    let flow = playUntil(playing28(), (current) =>
      current.events.some((event) => event.type === "resultDecided"),
    );
    const decided = only(flow.events, "resultDecided");
    assert.equal(decided.losingTeam, "B");
    assert.equal(matchOf(flow.state).revealedInRound, null);
    for (const viewer of viewers(flow.state)) {
      const losing = viewer.type === "seat" && teamOf(viewer.seat) === "B";
      assert.deepEqual(
        redactEvent(decided, viewer, DEFAULT_SETTINGS),
        losing ? decided : null,
      );
      const projected = view(flow.state, viewer, DEFAULT_SETTINGS);
      if (viewer.type === "seat") {
        assert.equal(seatView(projected).resultDecided, losing ? "B" : null);
        assert.equal(
          seatView(projected).allowedActions.some(
            (entry) => entry.type === "proposeSurrender",
          ),
          losing,
        );
      }
    }
    checkEvents(flow.state, flow.log);
    checkState(flow.state);

    // A proposal pauses play: only the other losing seat may vote.
    flow = run(flow, [propose(3)]);
    for (const seatNumber of [0, 1, 2, 3]) {
      assert.deepEqual(
        allowedActions(flow.state, seatNumber),
        seatNumber === 1
          ? [{ type: "voteSurrender", votes: ["yes", "no"] }]
          : [],
      );
    }
    for (const projected of views(flow.state)) {
      assert.deepEqual(projected.surrender, { proposer: 3, yes: [3], no: [] });
    }
    checkState(flow.state);

    // A failed vote locks proposals for the rest of the round.
    flow = run(flow, [vote(1, "no")]);
    assert.equal(
      allowedActions(flow.state, 3).some(
        (entry) => entry.type === "proposeSurrender",
      ),
      false,
    );
    checkState(flow.state);

    // A surrender before the reveal ends the match with the trump unrevealed.
    flow = playUntil(flow, (current) =>
      current.events.some((event) => event.type === "roundWon"),
    );
    flow = run(flow, [propose(1), vote(3, "yes")]);
    assert.equal(flow.state.phase.type, "matchOver");
    checkEvents(flow.state, flow.events);
    for (const viewer of viewers(flow.state)) {
      const projected = view(flow.state, viewer, DEFAULT_SETTINGS);
      assert.ok(!JSON.stringify(projected).includes(HIDDEN_SUIT));
      for (const event of flow.events) {
        assert.ok(
          !JSON.stringify(
            redactEvent(event, viewer, DEFAULT_SETTINGS),
          ).includes(HIDDEN_SUIT),
        );
      }
    }
    checkState(flow.state);
  });
});

describe("views: 56 public data, settings and capabilities", () => {
  const deck = buildDeck(config56());

  it("bid capabilities carry suits and styles in 56 and none in 28", () => {
    const flow56 = run(start(config56()), [deal(deck)]);
    assert.deepEqual(allowedActions(flow56.state, 1), [
      {
        type: "bid",
        range: { minimum: 28, maximum: 56 },
        suits: ["spades", "hearts", "diamonds", "clubs", "noTrump"],
        styles: ["numberFirst", "suitFirst"],
      },
      { type: "pass" },
    ]);
    assert.deepEqual(allowedActions(flow56.state, 0), []);
    checkState(flow56.state);

    const flow28 = run(start(config28()), [deal(DEAL_28)]);
    assert.deepEqual(allowedActions(flow28.state, 1), [
      {
        type: "bid",
        range: { minimum: 14, maximum: 28 },
        suits: [],
        styles: [],
      },
      { type: "pass" },
    ]);
  });

  it("double on turn for the other team; redouble off turn for the doubled team", () => {
    const flow = run(start(config56()), [
      deal(deck),
      bid56(1, 30, "spades", "numberFirst"),
    ]);
    assert.deepEqual(
      allowedActions(flow.state, 2).map((entry) => entry.type),
      ["bid", "pass", "double"],
    );
    const doubled = run(flow, [double(2)]);
    assert.deepEqual(
      [0, 1, 2, 3].map((seatNumber) =>
        allowedActions(doubled.state, seatNumber).map((entry) => entry.type),
      ),
      [[], ["redouble"], [], ["bid", "pass", "redouble"]],
    );
    for (const projected of views(doubled.state)) {
      assert.equal(projected.auction?.doubledBy, 2);
      assert.deepEqual(projected.auction?.highBid, {
        seat: 1,
        amount: 30,
        suit: "spades",
        style: "numberFirst",
        forced: false,
      });
    }
    checkState(flow.state);
    checkState(doubled.state);
  });

  it("affordability limits the bid range and removes unaffordable calls", () => {
    const flow = run(start(config56({ startingTokens: 2 })), [
      deal(deck),
      bid56(1, 30, "spades", "numberFirst"),
    ]);
    // Team A has 2 tokens: bids up to 39 (loss 2); doubling 30 costs 2.
    assert.deepEqual(allowedActions(flow.state, 2), [
      {
        type: "bid",
        range: { minimum: 31, maximum: 39 },
        suits: ["spades", "hearts", "diamonds", "clubs", "noTrump"],
        styles: ["numberFirst", "suitFirst"],
      },
      { type: "pass" },
      { type: "double" },
    ]);
    // Team B can't afford a redouble (4 × 2 tokens).
    const doubled = run(flow, [double(2)]);
    assert.deepEqual(allowedActions(doubled.state, 1), []);
    checkState(flow.state);
    checkState(doubled.state);
  });

  it("round history and live points shape the play view", () => {
    let flow = run(start(config56()), [
      deal(deck),
      bid56(1, 28, "noTrump"),
      pass(2),
      pass(3),
      pass(0),
    ]);
    flow = playUntil(
      flow,
      (current) => matchOf(current.state).rounds.length === 2,
    );
    const match = matchOf(flow.state);
    const none = view(flow.state, seat(0), {
      roundHistory: "none",
      livePoints: false,
    });
    const last = view(flow.state, seat(0), {
      roundHistory: "last",
      livePoints: false,
    });
    const full = view(flow.state, seat(0), {
      roundHistory: "full",
      livePoints: true,
    });
    assert.deepEqual(none.rounds, []);
    assert.equal(none.points, null);
    assert.deepEqual(
      last.rounds.map((round) => [round.index, round.points]),
      [[1, null]],
    );
    assert.deepEqual(
      full.rounds.map((round) => [round.index, round.winner, round.points]),
      match.rounds.map((round, index) => [index, round.winner, round.points]),
    );
    assert.deepEqual(full.points, match.points);
    assert.deepEqual(full.contract, {
      bidder: 1,
      team: "B",
      amount: 28,
      trump: { type: "noTrump" },
      style: null,
      multiplier: 1,
      forced: false,
    });
    assert.deepEqual(full.currentRound, {
      index: 2,
      leader: match.currentRound?.leader,
      plays: [],
      leadSuit: null,
      revealedInRound: false,
      revealAskedBy: null,
      winner: null,
      points: null,
    });
    assert.equal(full.turn, match.currentRound?.leader);
    assert.equal(full.auction?.turn, null);

    const roundWon = flow.log.filter((event) => event.type === "roundWon")[0];
    assert.ok(roundWon !== undefined && roundWon.type === "roundWon");
    assert.deepEqual(
      redactEvent(roundWon, seat(0), {
        roundHistory: "full",
        livePoints: false,
      }),
      { ...roundWon, points: null },
    );
    assert.deepEqual(
      redactEvent(
        roundWon,
        { type: "table" },
        { roundHistory: "none", livePoints: true },
      ),
      roundWon,
    );
    checkState(flow.state);
  });

  it("leading trump early: Block omits trump cards, Auto-stop lists and accepts them", () => {
    // Seat 1 holds the first jack, ace and king of every suit and leads.
    const contract = (config: EngineConfig) =>
      run(start(config), [
        deal(buildDeck(config)),
        bid56(1, 28, "spades", "suitFirst"),
        pass(2),
        pass(3),
        pass(0),
      ]);
    const spade = (card: Card) => card.suit === "spades";

    const block = contract(config56());
    const blockCards = allowedActions(block.state, 1)[0];
    assert.ok(blockCards?.type === "playCard");
    assert.equal(blockCards.cards.length, 9);
    assert.ok(!blockCards.cards.some(spade));
    checkState(block.state);

    const autoStop = contract(config56({ illegalPlayMode: "autoStop" }));
    const autoCards = allowedActions(autoStop.state, 1)[0];
    assert.ok(autoCards?.type === "playCard");
    assert.equal(autoCards.cards.length, 12);
    const flow = run(autoStop, [
      { type: "playCard", card: c("SJ"), source: seat(1) },
    ]);
    assert.deepEqual(only(flow.events, "disqualified"), {
      type: "disqualified",
      seat: 1,
      kind: "ledTrumpEarly",
    });
    checkEvents(flow.state, flow.events);
    checkState(flow.state);
  });

  it("host capability: restart in auction, placement and play; award only in play", () => {
    let flow = start(config28());
    assert.deepEqual(allowedHostActions(flow.state), {
      restart: false,
      awardTeams: [],
    });
    flow = run(flow, [deal(DEAL_28)]);
    assert.deepEqual(allowedHostActions(flow.state), {
      restart: true,
      awardTeams: [],
    });
    flow = run(flow, [bid28(1, 16), pass(2), pass(3), pass(0)]);
    assert.equal(flow.state.phase.type, "placingCard");
    assert.deepEqual(allowedHostActions(flow.state), {
      restart: true,
      awardTeams: [],
    });
    flow = playing28();
    assert.deepEqual(allowedHostActions(flow.state), {
      restart: true,
      awardTeams: ["A", "B"],
    });
    flow = run(flow, [award("A")]);
    assert.equal(flow.state.phase.type, "matchOver");
    assert.deepEqual(allowedHostActions(flow.state), {
      restart: false,
      awardTeams: [],
    });
    checkState(flow.state);
  });

  it("rejects a seat viewer outside the table", () => {
    const { state } = start(config56());
    assert.throws(() => view(state, seat(4), DEFAULT_SETTINGS), RangeError);
    assert.throws(() => allowedActions(state, -1), RangeError);
    assert.throws(
      () =>
        redactEvent({ type: "passed", seat: 0 }, seat(1.5), DEFAULT_SETTINGS),
      RangeError,
    );
    assert.deepEqual(view(state, DUMMY_SEAT, DEFAULT_SETTINGS).viewer, {
      type: "seat",
      seat: 0,
      hand: [],
      faceDownCard: null,
      allowedActions: [],
      resultDecided: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Exhaustive exploration: seeded sessions reach every phase and event, and
// every reached state and event is checked for every viewer and setting.

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

/** One random action from what the seats may do (biased toward progress). */
function chooseAction(
  state: EngineState,
  next: () => number,
): EngineAction | null {
  const { phase, config } = state;
  switch (phase.type) {
    case "awaitingDeal":
      return deal(shuffled(buildDeck(config), next));
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
  if (next() < 0.008) {
    return restart;
  }
  if (phase.type === "play" && next() < 0.004) {
    return award(next() < 0.5 ? "A" : "B");
  }

  const options: { weight: number; action: EngineAction }[] = [];
  for (let seatNumber = 0; seatNumber < config.playerCount; seatNumber += 1) {
    const source = seat(seatNumber);
    for (const entry of allowedActions(state, seatNumber)) {
      switch (entry.type) {
        case "bid": {
          const span = Math.min(
            4,
            entry.range.maximum - entry.range.minimum + 1,
          );
          const amount = entry.range.minimum + Math.floor(next() * span);
          const action: EngineAction = { type: "bid", amount, source };
          if (entry.suits.length > 0) {
            const suit = pick(entry.suits, next);
            action.suit = suit;
            if (suit !== "noTrump") {
              action.style = pick(entry.styles, next);
            }
          }
          options.push({ weight: 3, action });
          break;
        }
        case "pass":
          options.push({ weight: 6, action: { type: "pass", source } });
          break;
        case "double":
          options.push({ weight: 1.5, action: { type: "double", source } });
          break;
        case "redouble":
          options.push({ weight: 3, action: { type: "redouble", source } });
          break;
        case "placeCard":
          options.push({
            weight: 1,
            action: {
              type: "placeCard",
              card: pick(entry.cards, next),
              source,
            },
          });
          break;
        case "playCard": {
          const legal = legalCards(state, seatNumber);
          const card =
            legal.length > 0 && next() < 0.93
              ? pick(legal, next)
              : pick(entry.cards, next);
          options.push({
            weight: 8,
            action: { type: "playCard", card, source },
          });
          break;
        }
        case "askReveal":
          options.push({ weight: 2, action: { type: "askReveal", source } });
          break;
        case "proposeSurrender":
          options.push({
            weight: 1.5,
            action: { type: "proposeSurrender", source },
          });
          break;
        case "voteSurrender":
          options.push({
            weight: 4,
            action: {
              type: "voteSurrender",
              vote: pick(entry.votes, next),
              source,
            },
          });
          break;
      }
    }
  }
  if (options.length === 0) {
    return null;
  }
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let target = next() * total;
  for (const option of options) {
    target -= option.weight;
    if (target < 0) {
      return option.action;
    }
  }
  return options.at(-1)?.action ?? null;
}

function explore(config: EngineConfig, seed: number, maxActions: number): void {
  const next = random(seed);
  let flow = start(config, Math.floor(next() * config.playerCount));
  checkEvents(flow.state, flow.events);
  checkState(flow.state);
  for (let count = 0; count < maxActions; count += 1) {
    const action = chooseAction(flow.state, next);
    assert.ok(action !== null, `stuck in ${flow.state.phase.type}`);
    flow = run(flow, [action]);
    checkEvents(flow.state, flow.events);
    checkState(flow.state);
  }
}

describe("views: exhaustive exploration against decide", () => {
  const configs: readonly [string, EngineConfig][] = [
    ["28 Block", config28({ startingTokens: 4 })],
    [
      "28 Auto-stop",
      config28({ illegalPlayMode: "autoStop", startingTokens: 4 }),
    ],
    [
      "28 Auto-stop, surrender off",
      config28({ illegalPlayMode: "autoStop", surrenderOption: "off" }),
    ],
    ["56 4 players Block", config56({ startingTokens: 4 })],
    [
      "56 6 players Auto-stop",
      config56({
        playerCount: 6,
        illegalPlayMode: "autoStop",
        startingTokens: 4,
      }),
    ],
    [
      "56 8 players with 8s and 7s",
      config56({
        playerCount: 8,
        includeEightsAndSevens: true,
        startingTokens: 4,
      }),
    ],
  ];
  /**
   * The two disqualifications random play rarely reaches: a forced 28 bidder
   * playing another card, and a 56 leader leading trump early.
   */
  function rareDisqualifications(): void {
    const forced = run(
      heartsLedToBidder(config28({ illegalPlayMode: "autoStop" })),
      [play(1, "SQ")],
    );
    checkEvents(forced.state, forced.events);
    checkState(forced.state);

    const config = config56({ illegalPlayMode: "autoStop" });
    const early = run(start(config), [
      deal(buildDeck(config)),
      bid56(1, 28, "spades", "suitFirst"),
      pass(2),
      pass(3),
      pass(0),
      play(1, "SJ"),
    ]);
    checkEvents(early.state, early.events);
    checkState(early.state);
  }

  // Self-contained: the coverage below counts only what this test checks.
  it("capabilities, views and redaction hold in every reached state", async (t) => {
    seenEvents.clear();
    seenPhases.clear();
    seenCapabilities.clear();
    for (const [name, config] of configs) {
      await t.test(name, () => {
        for (const seed of [1, 2]) {
          explore(config, seed * 7919 + config.playerCount, 200);
        }
      });
    }
    await t.test("rare disqualifications", rareDisqualifications);

    const allPhases: EnginePhaseType[] = [
      "awaitingDeal",
      "auction",
      "placingCard",
      "play",
      "matchOver",
      "sessionOver",
    ];
    const allEvents: EngineEventType[] = [
      "sessionStarted",
      "sessionRestarted",
      "sessionEnded",
      "nextMatchStarted",
      "dealt",
      "redealt",
      "auctionStarted",
      "bidMade",
      "passed",
      "doubled",
      "doubleCancelled",
      "redoubled",
      "forcedBid",
      "auctionEnded",
      "placingCardStarted",
      "cardPlaced",
      "faceDownReturned",
      "revealAsked",
      "trumpRevealed",
      "playStarted",
      "cardPlayed",
      "roundWon",
      "disqualified",
      "resultDecided",
      "surrenderProposed",
      "surrenderVoted",
      "surrenderFailed",
      "surrendered",
      "matchEnded",
    ];
    const allCapabilities: AllowedEngineAction["type"][] = [
      "bid",
      "pass",
      "double",
      "redouble",
      "placeCard",
      "askReveal",
      "playCard",
      "proposeSurrender",
      "voteSurrender",
    ];
    const missing = [
      ...allPhases.filter((phase) => !seenPhases.has(phase)),
      ...[
        ...allEvents,
        "cardPlayed(fromFaceDown)",
        "disqualified(didNotFollowSuit)",
        "disqualified(ledTrumpEarly)",
        "disqualified(didNotPlayFaceDown)",
        "disqualified(revealWhileAbleToFollow)",
      ].filter((event) => !seenEvents.has(event)),
      ...allCapabilities.filter((type) => !seenCapabilities.has(type)),
    ];
    assert.deepEqual(missing, []);
  });
});
