import type { BidStyle, BidSuit, Card, Seat, Team } from "./types.js";

export type ClientSeatAction =
  | { type: "bid"; amount: number; suit?: BidSuit; style?: BidStyle }
  | { type: "pass" }
  | { type: "double" }
  | { type: "redouble" }
  | { type: "placeCard"; card: Card }
  | { type: "askReveal" }
  | { type: "playCard"; card: Card }
  | { type: "proposeSurrender" }
  | { type: "voteSurrender"; vote: SurrenderVoteChoice };

export type SurrenderVoteChoice = "yes" | "no";

export type EndMatchResolution =
  | { type: "restart" }
  | { type: "award"; team: Team };

export type ClientHostAction = {
  type: "endMatch";
  resolution: EndMatchResolution;
};

export type ClientEngineAction = ClientSeatAction | ClientHostAction;

export type SeatSource = { type: "seat"; seat: Seat };
export type HostSource = { type: "host" };
export type SystemSource = { type: "system" };
export type ActionSource = SeatSource | HostSource | SystemSource;

export type SeatEngineAction = ClientSeatAction & { source: SeatSource };
export type HostEngineAction = ClientHostAction & { source: HostSource };
export type SystemEngineAction =
  | { type: "deal"; source: SystemSource; deck: readonly Card[] }
  | { type: "startNextMatch"; source: SystemSource }
  | { type: "restartSession"; source: SystemSource; firstDealer: Seat };

export type EngineAction =
  | SeatEngineAction
  | HostEngineAction
  | SystemEngineAction;

export type EngineActionType = EngineAction["type"];

export type ActionOfType<T extends EngineActionType> = Extract<
  EngineAction,
  { type: T }
>;

/** The only source kind each action accepts (design §2). */
export const ACTION_SOURCE_TYPES: Readonly<
  Record<EngineActionType, ActionSource["type"]>
> = {
  bid: "seat",
  pass: "seat",
  double: "seat",
  redouble: "seat",
  placeCard: "seat",
  askReveal: "seat",
  playCard: "seat",
  proposeSurrender: "seat",
  voteSurrender: "seat",
  endMatch: "host",
  deal: "system",
  startNextMatch: "system",
  restartSession: "system",
};

export function isEngineActionType(value: unknown): value is EngineActionType {
  return typeof value === "string" && Object.hasOwn(ACTION_SOURCE_TYPES, value);
}
