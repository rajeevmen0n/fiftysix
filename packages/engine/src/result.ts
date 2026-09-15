import type { EngineEvent } from "./events.js";
import type { EngineState } from "./state.js";

export type EngineRejectionCode =
  | "invalidConfig"
  | "invalidSeat"
  | "actionNotAllowed"
  | "invalidDeck"
  | "notYourTurn"
  | "invalidBid"
  | "bidTooLow"
  | "bidOutOfRange"
  | "cannotAfford"
  | "doubleNotAllowed"
  | "noDoubleActive"
  | "cardNotInHand"
  | "faceDownNotPlayable"
  | "surrenderVoteRunning"
  | "revealNotAllowed"
  | "illegalPlay";

/**
 * A normal, expected result. `details` may hold safe expected ranges, seats,
 * or kinds, but never hidden cards or full state.
 */
export interface EngineRejection {
  ok: false;
  code: EngineRejectionCode;
  details?: Record<string, unknown>;
}

export type Decision = { ok: true; events: EngineEvent[] } | EngineRejection;

export type ActionResult =
  | { ok: true; state: EngineState; events: EngineEvent[] }
  | EngineRejection;

export function reject(
  code: EngineRejectionCode,
  details?: Record<string, unknown>,
): EngineRejection {
  return details === undefined
    ? { ok: false, code }
    : { ok: false, code, details };
}

export function accept(events: EngineEvent[]): Decision {
  return { ok: true, events };
}

/**
 * Exhaustiveness guard for discriminated-union switches. Adding a variant
 * without handling it fails compilation. At runtime it throws without
 * serializing the value, so private state is never included in the message.
 */
export function assertNever(_value: never, context: string): never {
  throw new Error(`Unhandled engine variant in ${context}`);
}
