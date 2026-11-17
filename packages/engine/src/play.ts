import type { EngineAction } from "./actions.js";
import { cardPoints, cardsEqual, compareRanks } from "./cards.js";
import type {
  CardPlayedEvent,
  DisqualifiedEvent,
  EngineEvent,
  RevealAskedEvent,
  RoundWonEvent,
  TrumpRevealedEvent,
} from "./events.js";
import {
  cloneCard,
  evolveRevealAsked,
  evolveTrumpRevealed,
  faceDownIsForced,
  isCardLike,
  revealBlocker,
} from "./hidden-trump.js";
import { accept, assertNever, type Decision, reject } from "./result.js";
import { scoreMatch, scorePlayedOutMatch } from "./scoring.js";
import { nextSeat, teamOf } from "./seats.js";
import type {
  CompletedRound,
  Contract,
  CurrentRound,
  EngineState,
  IllegalPlayKind,
  MatchState,
} from "./state.js";
import type { Card, Seat, Suit } from "./types.js";

// Card play (design §9, rules §6, §8, §10.3): following suit, the trump-lead
// rule, the forced 28 face-down card, asking for the reveal, disqualifying
// plays in each illegal-play mode, round winners, and the end of play.

/**
 * design §9.5: the suit whose cards count as trump in a round, or null when
 * nothing does. 56: the trump suit (none in a no-trump match). 28: the hidden
 * suit, but only in rounds from the reveal round onward — `trumpRevealed`
 * says whether trump had been revealed by the end of the round in question.
 * A forced 14 no trump that stands has no trump at all.
 */
export function countingTrumpSuit(
  contract: Contract,
  trumpRevealed: boolean,
): Suit | null {
  const { trump } = contract;
  switch (trump.type) {
    case "suit":
      return trump.suit;
    case "noTrump":
      return null;
    case "hidden":
      return trumpRevealed ? trump.suit : null;
    default:
      return assertNever(trump, "countingTrumpSuit");
  }
}

/**
 * design §9.6, rules §6.2: the seat whose card wins a round. The highest card
 * that counts as trump wins; with none, the highest card of the lead suit.
 * Other cards can't win. Between identical cards (two decks in 56), the one
 * played first ranks higher.
 *
 * `trumpRevealed` is whether a 28 hidden trump had been revealed by the end
 * of this round (in the reveal round, trump-suit cards played before the
 * reveal also count). It is ignored for 56 and no-trump contracts. The plan's
 * two-argument signature can't tell a round after the reveal round (where
 * `revealedThisRound` is false again) from one before it, so it is explicit.
 * Accepts a current or a finished round; it must hold at least one play.
 */
export function roundWinner(
  round: Pick<CurrentRound, "plays">,
  contract: Contract,
  trumpRevealed: boolean,
): Seat {
  const [first, ...rest] = round.plays;
  if (first === undefined) {
    throw new Error("roundWinner: the round has no plays");
  }
  const trump = countingTrumpSuit(contract, trumpRevealed);
  const leadSuit = first.card.suit;
  // 2: counts as trump, 1: lead suit, 0: can't win.
  const strength = (card: Card): number =>
    card.suit === trump ? 2 : card.suit === leadSuit ? 1 : 0;

  let best = first;
  for (const play of rest) {
    const difference = strength(play.card) - strength(best.card);
    if (
      difference > 0 ||
      (difference === 0 &&
        strength(play.card) > 0 &&
        compareRanks(play.card.rank, best.card.rank) > 0)
    ) {
      best = play;
    }
  }
  return best.seat;
}

function roundPoints(round: Pick<CurrentRound, "plays">): number {
  return round.plays.reduce((total, play) => total + cardPoints(play.card), 0);
}

/**
 * design §9.2: the suit a leader may not lead yet, or null. Only a suit that
 * counts as trump right now is restricted: a 56 trump suit, or a 28 hidden
 * suit after its reveal. Before the reveal the hidden suit is a plain suit.
 */
function restrictedLeadSuit(match: MatchState): Suit | null {
  if (match.contract === null || match.trumpPlayed) {
    return null;
  }
  return countingTrumpSuit(match.contract, match.revealedInRound !== null);
}

/**
 * design §9.2: why playing `card` from `seat`'s hand on its turn breaks the
 * following-suit or trump-lead rule, or null when it doesn't. The forced
 * face-down case (§9.3) is checked separately by the caller.
 */
function illegalHandPlay(
  match: MatchState,
  round: CurrentRound,
  seat: Seat,
  card: Card,
): IllegalPlayKind | null {
  const hand = match.hands[seat] ?? [];
  if (round.plays.length === 0) {
    const trump = restrictedLeadSuit(match);
    return trump !== null &&
      card.suit === trump &&
      hand.some((held) => held.suit !== trump)
      ? "ledTrumpEarly"
      : null;
  }
  const { leadSuit } = round;
  return card.suit !== leadSuit &&
    round.revealAskedBy !== seat &&
    hand.some((held) => held.suit === leadSuit)
    ? "didNotFollowSuit"
    : null;
}

interface PlayContext {
  match: MatchState;
  round: CurrentRound;
}

function playContext(state: EngineState): PlayContext | null {
  const { phase } = state;
  if (
    phase.type !== "play" ||
    phase.match.currentRound === null ||
    phase.match.contract === null
  ) {
    return null;
  }
  return { match: phase.match, round: phase.match.currentRound };
}

/**
 * design §9.2–§9.3, §12 (Block): the cards `seat` may legally play right now.
 * Empty unless it is the seat's turn in play with no surrender vote running.
 * When the 28 bidder is forced, the only legal card is the face-down card.
 * Returned cards are copies.
 */
export function legalCards(state: EngineState, seat: Seat): Card[] {
  const context = playContext(state);
  if (
    context === null ||
    context.match.surrender.vote !== null ||
    context.round.turn !== seat
  ) {
    return [];
  }
  const { match, round } = context;
  if (faceDownIsForced(state, seat) && match.faceDown !== null) {
    return [cloneCard(match.faceDown.card)];
  }
  return (match.hands[seat] ?? [])
    .filter((card) => illegalHandPlay(match, round, seat, card) === null)
    .map(cloneCard);
}

// ---------------------------------------------------------------------------
// Decisions

/**
 * Applies this module's own events, so a decider can look at the state they
 * lead to (round completion, scoring) without importing the engine router.
 */
function applyPlayEvents(
  state: EngineState,
  events: readonly EngineEvent[],
): EngineState {
  let next = state;
  for (const event of events) {
    switch (event.type) {
      case "revealAsked":
        next = evolveRevealAsked(next, event);
        break;
      case "trumpRevealed":
        next = evolveTrumpRevealed(next, event);
        break;
      case "cardPlayed":
        next = evolveCardPlayed(next, event);
        break;
      case "roundWon":
        next = evolveRoundWon(next, event);
        break;
      case "disqualified":
        next = evolveDisqualified(next, event);
        break;
      default:
        throw new Error(`applyPlayEvents: unexpected ${event.type} event`);
    }
  }
  return next;
}

/**
 * design §9.4: a disqualifying play. Block rejects it with
 * `illegalPlay(kind)`. Auto-stop accepts the submitted play or reveal
 * (`events`), emits `disqualified`, and scores the match at once with the
 * points already collected; the round is not finished.
 */
function disqualify(
  state: EngineState,
  seat: Seat,
  kind: IllegalPlayKind,
  events: EngineEvent[],
): Decision {
  if (state.config.illegalPlayMode === "block") {
    return reject("illegalPlay", { kind });
  }
  const disqualified: DisqualifiedEvent = { type: "disqualified", seat, kind };
  const accepted = [...events, disqualified];
  const stopped = applyPlayEvents(state, accepted);
  return accept([
    ...accepted,
    ...scoreMatch(stopped, { type: "disqualified", seat, kind }),
  ]);
}

/**
 * design §9.6: after a legal play, completes the round on its last card
 * (`roundWon`), and scores the match after its last round (made/failed).
 */
function completePlay(state: EngineState, events: EngineEvent[]): Decision {
  let next = applyPlayEvents(state, events);
  const context = playContext(next);
  if (context === null) {
    throw new Error("completePlay: expected a round in play");
  }
  const { match, round } = context;
  if (round.plays.length < next.config.playerCount) {
    return accept(events);
  }

  const contract = match.contract as Contract;
  const winner = roundWinner(round, contract, match.revealedInRound !== null);
  const roundWon: RoundWonEvent = {
    type: "roundWon",
    seat: winner,
    team: teamOf(winner),
    points: roundPoints(round),
  };
  next = applyPlayEvents(next, [roundWon]);
  // The surrender certainty check (design §10.1) belongs here, after
  // `roundWon`; it is added with the surrender module.
  const finished = playContext(next) === null;
  return accept(
    finished
      ? [...events, roundWon, ...scorePlayedOutMatch(next)]
      : [...events, roundWon],
  );
}

function decidePlayCard(
  state: EngineState,
  context: PlayContext,
  seat: Seat,
  requested: unknown,
): Decision {
  const { match, round } = context;
  if (!isCardLike(requested)) {
    return reject("cardNotInHand", {});
  }
  const forced = faceDownIsForced(state, seat);

  // design §9.3: the face-down card is playable only when forced; playing
  // it is the reveal. Another seat naming it simply doesn't hold it.
  const { faceDown } = match;
  if (
    faceDown !== null &&
    faceDown.owner === seat &&
    cardsEqual(faceDown.card, requested)
  ) {
    if (!forced) {
      return reject("faceDownNotPlayable", {});
    }
    const card = cloneCard(faceDown.card);
    const revealed: TrumpRevealedEvent = { type: "trumpRevealed", card };
    const played: CardPlayedEvent = {
      type: "cardPlayed",
      seat,
      card: cloneCard(card),
      fromFaceDown: true,
    };
    return completePlay(state, [revealed, played]);
  }

  const held = (match.hands[seat] ?? []).find((card) =>
    cardsEqual(card, requested),
  );
  if (held === undefined) {
    return reject("cardNotInHand", {});
  }
  const played: CardPlayedEvent = {
    type: "cardPlayed",
    seat,
    card: cloneCard(held),
    fromFaceDown: false,
  };
  const kind: IllegalPlayKind | null = forced
    ? "didNotPlayFaceDown"
    : illegalHandPlay(match, round, seat, held);
  return kind === null
    ? completePlay(state, [played])
    : disqualify(state, seat, kind, [played]);
}

function decideAskReveal(
  state: EngineState,
  context: PlayContext,
  seat: Seat,
): Decision {
  const blocker = revealBlocker(state, seat);
  const { faceDown } = context.match;
  if (blocker !== null || faceDown === null) {
    return reject("revealNotAllowed", { reason: blocker ?? "trumpNotHidden" });
  }
  const asked: RevealAskedEvent = { type: "revealAsked", seat };
  const revealed: TrumpRevealedEvent = {
    type: "trumpRevealed",
    card: cloneCard(faceDown.card),
  };
  // design §9.2: before the reveal, "holding the lead suit" looks only at
  // the hand; the face-down card isn't part of it.
  const { leadSuit } = context.round;
  const ableToFollow = (context.match.hands[seat] ?? []).some(
    (card) => card.suit === leadSuit,
  );
  return ableToFollow
    ? disqualify(state, seat, "revealWhileAbleToFollow", [asked, revealed])
    : accept([asked, revealed]);
}

/**
 * design §9.1–§9.6: `playCard(card)` and `askReveal` from the seat whose
 * turn it is, in play, with no surrender vote running.
 *
 * Always rejected, in both modes: `surrenderVoteRunning`, `notYourTurn`,
 * `cardNotInHand`, `faceDownNotPlayable`, and `revealNotAllowed`. The four
 * disqualifying kinds are rejected as `illegalPlay(kind)` in Block and
 * accepted, then scored at once, in Auto-stop.
 *
 * Event orders:
 * - play: `cardPlayed`; on the round's last card `roundWon`; after the last
 *   round `matchEnded` (made or failed) and possibly `sessionEnded`.
 * - forced face-down play: `trumpRevealed`, `cardPlayed(fromFaceDown)`, then
 *   as above.
 * - reveal: `revealAsked`, `trumpRevealed`.
 * - Auto-stop: the play or reveal events, `disqualified`, `matchEnded`, and
 *   possibly `sessionEnded`.
 *
 * Like the other deciders this re-validates the action type and phase for
 * direct callers but not `decide()`'s source checks.
 */
export function decidePlayAction(
  state: EngineState,
  action: EngineAction,
): Decision {
  if (action.type !== "playCard" && action.type !== "askReveal") {
    return reject("actionNotAllowed", { action: action.type });
  }
  const context = playContext(state);
  if (context === null) {
    return reject("actionNotAllowed", {
      action: action.type,
      phase: state.phase.type,
    });
  }
  if (context.match.surrender.vote !== null) {
    return reject("surrenderVoteRunning", {});
  }
  const seat = action.source.seat;
  if (context.round.turn !== seat) {
    return reject("notYourTurn", {
      expected: context.round.turn,
      actual: seat,
    });
  }

  return action.type === "playCard"
    ? decidePlayCard(state, context, seat, action.card as unknown)
    : decideAskReveal(state, context, seat);
}

// ---------------------------------------------------------------------------
// Evolvers (design §13.1: throw instead of recovering from a misordered log).

function withPlayMatch(state: EngineState, match: MatchState): EngineState {
  return {
    config: state.config,
    tokens: state.tokens,
    dealer: state.dealer,
    matchLog: state.matchLog,
    pastSessions: state.pastSessions,
    phase: { type: "play", match },
  };
}

/**
 * Moves the card from the seat's hand into the current round (a forced
 * face-down card was put back into the hand by the `trumpRevealed` before
 * it), sets the lead suit on the first card, and passes the turn on.
 */
export function evolveCardPlayed(
  state: EngineState,
  event: CardPlayedEvent,
): EngineState {
  const { phase } = state;
  const round = phase.type === "play" ? phase.match.currentRound : null;
  if (
    phase.type !== "play" ||
    round === null ||
    round.turn !== event.seat ||
    round.plays.length >= state.config.playerCount
  ) {
    throw new Error(
      "Cannot apply cardPlayed event: expected that seat's turn in a round in play",
    );
  }
  const hand = phase.match.hands[event.seat] ?? [];
  const index = hand.findIndex((card) => cardsEqual(card, event.card));
  if (index === -1) {
    throw new Error(
      "Cannot apply cardPlayed event: the card is not in that seat's hand",
    );
  }

  const card = cloneCard(event.card);
  const hands = phase.match.hands.map((cards, seat) =>
    seat === event.seat
      ? cards.filter((_, cardIndex) => cardIndex !== index)
      : cards,
  );
  return withPlayMatch(state, {
    ...phase.match,
    hands,
    currentRound: {
      ...round,
      plays: [
        ...round.plays,
        { seat: event.seat, card, fromFaceDown: event.fromFaceDown },
      ],
      leadSuit: round.leadSuit ?? card.suit,
      turn: nextSeat(event.seat, state.config.playerCount),
    },
  });
}

/**
 * design §9.6: files the finished round, adds its points to the winner's
 * team, marks trump played if any card in it counted as trump, and starts the
 * next round led by the winner with the reveal-turn flags cleared. After the
 * last round (no cards left anywhere) there is no next round:
 * `currentRound` becomes null until the `matchEnded` that follows in the
 * same action.
 */
export function evolveRoundWon(
  state: EngineState,
  event: RoundWonEvent,
): EngineState {
  const { phase } = state;
  const round = phase.type === "play" ? phase.match.currentRound : null;
  if (
    phase.type !== "play" ||
    round === null ||
    phase.match.contract === null ||
    round.plays.length !== state.config.playerCount ||
    !round.plays.some((play) => play.seat === event.seat)
  ) {
    throw new Error(
      "Cannot apply roundWon event: expected a complete round including that seat",
    );
  }
  const { match } = phase;
  const contract = match.contract as Contract;

  const trump = countingTrumpSuit(contract, match.revealedInRound !== null);
  const finished: CompletedRound = {
    leader: round.leader,
    plays: round.plays,
    winner: event.seat,
    points: event.points,
  };
  const cardsLeft =
    match.faceDown !== null || match.hands.some((hand) => hand.length > 0);
  return withPlayMatch(state, {
    ...match,
    rounds: [...match.rounds, finished],
    points: {
      ...match.points,
      [event.team]: match.points[event.team] + event.points,
    },
    trumpPlayed:
      match.trumpPlayed || round.plays.some((play) => play.card.suit === trump),
    currentRound: cardsLeft
      ? {
          leader: event.seat,
          plays: [],
          turn: event.seat,
          leadSuit: null,
          revealedThisRound: false,
          revealAskedBy: null,
        }
      : null,
  });
}

/**
 * design §9.4: Auto-stop stopped play. The state is unchanged; the
 * `matchEnded(disqualified)` that follows in the same action ends the match.
 */
export function evolveDisqualified(
  state: EngineState,
  _event: DisqualifiedEvent,
): EngineState {
  if (state.phase.type !== "play") {
    throw new Error(
      `Cannot apply disqualified event: expected phase "play", got "${state.phase.type}"`,
    );
  }
  return state;
}
