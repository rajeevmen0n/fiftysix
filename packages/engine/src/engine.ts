import {
  ACTION_SOURCE_TYPES,
  type EngineAction,
  type EngineActionType,
  isEngineActionType,
} from "./actions.js";
import {
  decideAuctionAction,
  evolveAuctionEnded,
  evolveBidMade,
  evolveDoubleCancelled,
  evolveDoubled,
  evolveForcedBid,
  evolvePassed,
  evolvePlayStarted,
  evolveRedoubled,
} from "./auction.js";
import { decideDeal, evolveAuctionStarted, evolveDealt } from "./deal.js";
import type { EngineEvent, MatchEndedEvent } from "./events.js";
import { evolveRedealt } from "./redeal.js";
import {
  type ActionResult,
  assertNever,
  type Decision,
  type EngineRejection,
  reject,
} from "./result.js";
import { isSeatInRange } from "./seats.js";
import { decideSessionStart, evolveSessionStarted } from "./session.js";
import type { EnginePhaseType, EngineState } from "./state.js";
import type { EngineConfig, Seat } from "./types.js";

// Transition kernel.
//
// `decide` checks the action's discriminator, source, seat range, and phase,
// then routes to one pure rule-module decider. `evolve` routes each event to
// one pure evolver and performs no policy checks. `act` composes the two.
//
// Rule modules plug in by replacing the placeholder in the matching `case` of
// `routeAction` / `evolve` with their own function. Deciders receive state they
// must not mutate, and must copy any action payload they place in events so no
// caller-owned object is retained. Evolvers must return new objects rather
// than mutating the input state or event.

/** Phases in which each action can ever be accepted (design §7–§10). */
const ACTION_PHASES: Readonly<
  Record<EngineActionType, readonly EnginePhaseType[]>
> = {
  bid: ["auction"],
  pass: ["auction"],
  double: ["auction"],
  redouble: ["auction"],
  placeCard: ["placingCard"],
  askReveal: ["play"],
  playCard: ["play"],
  proposeSurrender: ["play"],
  voteSurrender: ["play"],
  endMatch: ["auction", "placingCard", "play"],
  deal: ["awaitingDeal"],
  startNextMatch: ["matchOver"],
  restartSession: ["sessionOver"],
};

function checkSource(
  state: EngineState,
  action: EngineAction,
): EngineRejection | null {
  const expected = ACTION_SOURCE_TYPES[action.type];
  const source: unknown = action.source;

  if (
    source === null ||
    typeof source !== "object" ||
    (source as { type?: unknown }).type !== expected
  ) {
    return reject("actionNotAllowed", {
      action: action.type,
      expectedSource: expected,
    });
  }

  if (
    expected === "seat" &&
    !isSeatInRange(
      (source as { seat?: unknown }).seat,
      state.config.playerCount,
    )
  ) {
    return reject("invalidSeat", {
      minimum: 0,
      maximum: state.config.playerCount - 1,
    });
  }

  return null;
}

/** Placeholder decider for actions whose rule module is not implemented yet. */
function unsupportedAction(
  _state: EngineState,
  action: EngineAction,
): Decision {
  return reject("actionNotAllowed", { action: action.type });
}

function routeAction(state: EngineState, action: EngineAction): Decision {
  switch (action.type) {
    case "deal":
      return decideDeal(state, action);
    case "bid":
    case "pass":
    case "double":
    case "redouble":
      return decideAuctionAction(state, action);
    case "placeCard":
      return unsupportedAction(state, action);
    case "askReveal":
    case "playCard":
      return unsupportedAction(state, action);
    case "proposeSurrender":
    case "voteSurrender":
      return unsupportedAction(state, action);
    case "endMatch":
      return unsupportedAction(state, action);
    case "startNextMatch":
    case "restartSession":
      return unsupportedAction(state, action);
    default:
      return assertNever(action, "decide");
  }
}

export function decide(state: EngineState, action: EngineAction): Decision {
  if (
    action === null ||
    typeof action !== "object" ||
    !isEngineActionType((action as { type?: unknown }).type)
  ) {
    return reject("actionNotAllowed");
  }

  const sourceRejection = checkSource(state, action);
  if (sourceRejection !== null) {
    return sourceRejection;
  }

  if (!ACTION_PHASES[action.type].includes(state.phase.type)) {
    return reject("actionNotAllowed", {
      action: action.type,
      phase: state.phase.type,
    });
  }

  return routeAction(state, action);
}

/** Placeholder evolver for events whose rule module is not implemented yet. */
function missingEvolver(_state: EngineState, event: EngineEvent): never {
  throw new Error(`No evolver is registered for engine event ${event.type}`);
}

/**
 * Placeholder for a `MatchOutcome` variant no unit has implemented yet.
 * Named after the outcome so a later unit gets a clear compile-time
 * reminder (via the call site's exhaustiveness switch) and a clear runtime
 * message naming exactly which outcome still needs its evolver.
 */
function outcomeNotYetImplemented(outcomeType: string): never {
  throw new Error(`Match outcome not yet implemented: ${outcomeType}`);
}

/**
 * Design §7.1/§10.3: only the automatic `redealt` outcome is reachable via
 * `decide()` in this unit (56 after the deal, 28 after the second deal —
 * §7.1). A 56 redeal is a transient notice: the phase reset, unchanged
 * dealer and unchanged tokens are all carried by this event, so its summary
 * is not appended to `matchLog`. A 28 redeal is appended because its first
 * auction already occurred; its summary carries the public first-auction
 * facts and zero token movement.
 *
 * Every other `MatchOutcome` (`made`, `failed`, `disqualified`,
 * `surrendered`, `awarded`, `restarted`) belongs to later units (scoring,
 * surrender, host `endMatch`) that also own the `matchOver`/`sessionOver`
 * phase transitions and the paired `sessionEnded` event (design §10.4) — so
 * they throw here rather than being half-implemented ahead of that work.
 * The switch below is exhaustive at the type level (see `assertNever`'s
 * default case): adding a new `MatchOutcome` variant without a case here
 * fails compilation.
 */
function evolveMatchEnded(
  state: EngineState,
  event: MatchEndedEvent,
): EngineState {
  const { summary } = event;
  const { outcome } = summary;

  switch (outcome.type) {
    case "made":
    case "failed":
    case "disqualified":
    case "surrendered":
    case "awarded":
    case "restarted":
      return outcomeNotYetImplemented(outcome.type);
    case "redealt": {
      const tokens = { A: summary.tokens.A, B: summary.tokens.B };
      const matchLog =
        state.config.gameType === "28"
          ? [...state.matchLog, summary]
          : state.matchLog;

      return {
        config: state.config,
        tokens,
        dealer: summary.dealer,
        matchLog,
        pastSessions: state.pastSessions,
        phase: { type: "awaitingDeal", reason: "redeal" },
      };
    }
    default:
      return assertNever(outcome, "evolveMatchEnded");
  }
}

export function evolve(state: EngineState, event: EngineEvent): EngineState {
  switch (event.type) {
    case "sessionStarted":
      return evolveSessionStarted(state, event);
    case "dealt":
      return evolveDealt(state, event);
    case "redealt":
      return evolveRedealt(state, event);
    case "auctionStarted":
      return evolveAuctionStarted(state, event);
    case "bidMade":
      return evolveBidMade(state, event);
    case "passed":
      return evolvePassed(state, event);
    case "doubled":
      return evolveDoubled(state, event);
    case "doubleCancelled":
      return evolveDoubleCancelled(state, event);
    case "redoubled":
      return evolveRedoubled(state, event);
    case "forcedBid":
      return evolveForcedBid(state, event);
    case "auctionEnded":
      return evolveAuctionEnded(state, event);
    case "playStarted":
      return evolvePlayStarted(state, event);
    case "matchEnded":
      return evolveMatchEnded(state, event);
    case "sessionRestarted":
    case "sessionEnded":
    case "nextMatchStarted":
    case "cardPlaced":
    case "faceDownReturned":
    case "revealAsked":
    case "trumpRevealed":
    case "cardPlayed":
    case "roundWon":
    case "disqualified":
    case "resultDecided":
    case "surrenderProposed":
    case "surrenderVoted":
    case "surrenderFailed":
    case "surrendered":
      return missingEvolver(state, event);
    default:
      return assertNever(event, "evolve");
  }
}

function applyEvents(
  state: EngineState,
  events: readonly EngineEvent[],
): EngineState {
  let next = state;
  for (const event of events) {
    next = evolve(next, event);
  }
  return next;
}

export function act(state: EngineState, action: EngineAction): ActionResult {
  const decision = decide(state, action);
  if (!decision.ok) {
    return decision;
  }

  return {
    ok: true,
    state: applyEvents(state, decision.events),
    events: decision.events,
  };
}

export function newSession(
  config: EngineConfig,
  firstDealer: Seat,
): ActionResult {
  const start = decideSessionStart(config, firstDealer);
  if (!start.ok) {
    return start;
  }

  const events: EngineEvent[] = [start.event];
  return { ok: true, state: applyEvents(start.seed, events), events };
}
