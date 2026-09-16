import type { EndMatchResolution, EngineAction } from "./actions.js";
import type { MatchEndedEvent } from "./events.js";
import { accept, type Decision, reject } from "./result.js";
import { matchSummary, scoreMatch } from "./scoring.js";
import type { EngineState } from "./state.js";

// Host End match (design §10.2, design.md §10). Host authorization stays in
// the service; the engine only checks the phase and the resolution.

function isResolution(value: unknown): value is EndMatchResolution {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const resolution = value as { type?: unknown; team?: unknown };
  return (
    resolution.type === "restart" ||
    (resolution.type === "award" &&
      (resolution.team === "A" || resolution.team === "B"))
  );
}

/**
 * design §10.2: `endMatch(restart)` in `auction`, `placingCard`, or `play`
 * (including while a surrender vote runs) cancels the match with no token
 * movement: a single `matchEnded(restarted)` whose summary carries the
 * public contract standing at that moment (null before any contract exists).
 * The dealer is kept and the phase becomes `awaitingDeal(restart)`.
 *
 * `endMatch(award, team)` only in `play` (also during a vote) scores the
 * match for the named winning team (`scoreMatch`).
 *
 * The match state, and with it any running vote, is discarded by the
 * `matchEnded` evolver. Like the other deciders this re-validates the action
 * type and phase for direct callers but not `decide()`'s source checks.
 */
export function decideHostAction(
  state: EngineState,
  action: EngineAction,
): Decision {
  if (action.type !== "endMatch") {
    return reject("actionNotAllowed", { action: action.type });
  }
  const resolution: unknown = action.resolution;
  if (!isResolution(resolution)) {
    return reject("actionNotAllowed", {
      action: action.type,
      reason: "invalidResolution",
    });
  }

  const { phase } = state;
  if (resolution.type === "restart") {
    if (
      phase.type !== "auction" &&
      phase.type !== "placingCard" &&
      phase.type !== "play"
    ) {
      return reject("actionNotAllowed", {
        action: action.type,
        resolution: resolution.type,
        phase: phase.type,
      });
    }
    const matchEnded: MatchEndedEvent = {
      type: "matchEnded",
      summary: matchSummary(state, { type: "restarted" }, null, state.tokens),
    };
    return accept([matchEnded]);
  }

  if (phase.type !== "play") {
    return reject("actionNotAllowed", {
      action: action.type,
      resolution: resolution.type,
      phase: phase.type,
    });
  }
  return accept(scoreMatch(state, { type: "awarded", team: resolution.team }));
}
