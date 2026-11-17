import type {
  AllowedEngineAction,
  AuctionCall,
  AuctionStage,
  AwaitingDealReason,
  BidRange,
  CarriedBid,
  EngineView,
  HighBid,
  IllegalPlayKind,
  MatchOutcome,
  PastSessionSummary,
  PublicAuction,
  PublicContract,
  PublicContractTrump,
  PublicEnginePhase,
  PublicFaceDown,
  PublicMatchSummary,
  PublicRound,
  PublicSurrender,
  RedealReason,
  RoundPlay,
  StakeMultiplier,
  SummaryContract,
  SummaryTrump,
  Team,
  TokenBalances,
  TokenMovement,
  ViewerView,
} from "@fiftysix/engine";
import { z } from "zod";

import {
  bidStyleSchema,
  bidSuitSchema,
  cardSchema,
  type PlayerId,
  type PublicPlayer,
  type PublicSeat,
  playerIdSchema,
  publicPlayerSchema,
  publicSeatSchema,
  type RoomCode,
  type RoomGate,
  type RoomPhase,
  type RoomSettings,
  revisionSchema,
  roomCodeSchema,
  roomGateSchema,
  roomPhaseSchema,
  roomSettingsSchema,
  seatSchema,
  suitSchema,
  surrenderVoteChoiceSchema,
  teamSchema,
} from "./model.js";

// Recipient-safe views (rooms spec §8). The engine types are imported; these
// schemas mirror them so the server can check every outgoing view, and the
// strict objects reject any field (a hand, `undealt`, a hidden suit for the
// wrong recipient's shape) that the engine's public types do not define.

const count = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Engine public shapes

export const auctionStageSchema = z.enum([
  "56",
  "28-first",
  "28-second",
]) satisfies z.ZodType<AuctionStage>;

export const awaitingDealReasonSchema = z.enum([
  "firstDeal",
  "nextMatch",
  "redeal",
  "restart",
]) satisfies z.ZodType<AwaitingDealReason>;

export const illegalPlayKindSchema = z.enum([
  "didNotFollowSuit",
  "ledTrumpEarly",
  "didNotPlayFaceDown",
  "revealWhileAbleToFollow",
]) satisfies z.ZodType<IllegalPlayKind>;

export const redealReasonSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("teamWithoutJack"), team: teamSchema }),
  z.strictObject({
    type: z.literal("lowHand"),
    seat: seatSchema,
    points: count,
  }),
]) satisfies z.ZodType<RedealReason>;

export const stakeMultiplierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(4),
]) satisfies z.ZodType<StakeMultiplier>;

export const teamAmountsSchema = z.strictObject({
  A: count,
  B: count,
}) satisfies z.ZodType<TokenBalances>;

const auctionCallSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("bid"),
    seat: seatSchema,
    amount: z.number().int(),
    suit: bidSuitSchema.nullable(),
    style: bidStyleSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("pass"), seat: seatSchema }),
  z.strictObject({ type: z.literal("double"), seat: seatSchema }),
  z.strictObject({ type: z.literal("redouble"), seat: seatSchema }),
]) satisfies z.ZodType<AuctionCall>;

const highBidSchema = z.strictObject({
  seat: seatSchema,
  amount: z.number().int(),
  suit: bidSuitSchema.nullable(),
  style: bidStyleSchema.nullable(),
  forced: z.boolean(),
}) satisfies z.ZodType<HighBid>;

const carriedBidSchema = z.strictObject({
  bid: highBidSchema,
  doubledBy: seatSchema.nullable(),
}) satisfies z.ZodType<CarriedBid>;

export const publicAuctionSchema = z.strictObject({
  stage: auctionStageSchema,
  calls: z.array(auctionCallSchema),
  turn: seatSchema.nullable(),
  highBid: highBidSchema.nullable(),
  doubledBy: seatSchema.nullable(),
  redoubled: z.boolean(),
  carriedBid: carriedBidSchema.nullable(),
}) satisfies z.ZodType<PublicAuction>;

const publicContractTrumpSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("suit"), suit: suitSchema }),
  z.strictObject({ type: z.literal("noTrump") }),
  z.strictObject({ type: z.literal("hidden"), suit: suitSchema.nullable() }),
]) satisfies z.ZodType<PublicContractTrump>;

export const publicContractSchema = z.strictObject({
  bidder: seatSchema,
  team: teamSchema,
  amount: z.number().int(),
  trump: publicContractTrumpSchema,
  style: bidStyleSchema.nullable(),
  multiplier: stakeMultiplierSchema,
  forced: z.boolean(),
}) satisfies z.ZodType<PublicContract>;

/** A summary's unrevealed 28 trump carries no suit for any recipient. */
const summaryTrumpSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("suit"), suit: suitSchema }),
  z.strictObject({ type: z.literal("noTrump") }),
  z.strictObject({ type: z.literal("hidden") }),
]) satisfies z.ZodType<SummaryTrump>;

const summaryContractSchema = z.strictObject({
  bidder: seatSchema,
  team: teamSchema,
  amount: z.number().int(),
  trump: summaryTrumpSchema,
  style: bidStyleSchema.nullable(),
  multiplier: stakeMultiplierSchema,
  forced: z.boolean(),
}) satisfies z.ZodType<SummaryContract>;

const tokenMovementSchema = z.strictObject({
  payer: teamSchema,
  amount: count,
}) satisfies z.ZodType<TokenMovement>;

const matchOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("made") }),
  z.strictObject({ type: z.literal("failed") }),
  z.strictObject({
    type: z.literal("disqualified"),
    seat: seatSchema,
    kind: illegalPlayKindSchema,
  }),
  z.strictObject({ type: z.literal("surrendered"), team: teamSchema }),
  z.strictObject({ type: z.literal("awarded"), team: teamSchema }),
  z.strictObject({ type: z.literal("restarted") }),
  z.strictObject({ type: z.literal("redealt"), reason: redealReasonSchema }),
]) satisfies z.ZodType<MatchOutcome>;

export const matchSummarySchema = z.strictObject({
  dealer: seatSchema,
  contract: summaryContractSchema.nullable(),
  points: teamAmountsSchema,
  tokensMoved: tokenMovementSchema.nullable(),
  tokens: teamAmountsSchema,
  outcome: matchOutcomeSchema,
}) satisfies z.ZodType<PublicMatchSummary>;

const pastSessionSummarySchema = z.strictObject({
  winner: teamSchema,
  tokens: teamAmountsSchema,
}) satisfies z.ZodType<PastSessionSummary>;

const roundPlaySchema = z.strictObject({
  seat: seatSchema,
  card: cardSchema,
  fromFaceDown: z.boolean(),
}) satisfies z.ZodType<RoundPlay>;

const publicRoundSchema = z.strictObject({
  index: count,
  leader: seatSchema,
  plays: z.array(roundPlaySchema),
  leadSuit: suitSchema.nullable(),
  revealedInRound: z.boolean(),
  revealAskedBy: seatSchema.nullable(),
  winner: seatSchema.nullable(),
  points: count.nullable(),
}) satisfies z.ZodType<PublicRound>;

const publicSurrenderSchema = z.strictObject({
  proposer: seatSchema,
  yes: z.array(seatSchema),
  no: z.array(seatSchema),
}) satisfies z.ZodType<PublicSurrender>;

const publicFaceDownSchema = z
  .discriminatedUnion("visibility", [
    z.strictObject({ owner: seatSchema, visibility: z.literal("hidden") }),
    z.strictObject({
      owner: seatSchema,
      visibility: z.literal("visible"),
      card: cardSchema,
    }),
  ])
  .nullable() satisfies z.ZodType<PublicFaceDown>;

const bidRangeSchema = z.strictObject({
  minimum: z.number().int(),
  maximum: z.number().int(),
}) satisfies z.ZodType<BidRange>;

export const allowedEngineActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("bid"),
    range: bidRangeSchema,
    suits: z.array(bidSuitSchema),
    styles: z.array(bidStyleSchema),
  }),
  z.strictObject({ type: z.literal("pass") }),
  z.strictObject({ type: z.literal("double") }),
  z.strictObject({ type: z.literal("redouble") }),
  z.strictObject({ type: z.literal("placeCard"), cards: z.array(cardSchema) }),
  z.strictObject({ type: z.literal("askReveal") }),
  z.strictObject({ type: z.literal("playCard"), cards: z.array(cardSchema) }),
  z.strictObject({ type: z.literal("proposeSurrender") }),
  z.strictObject({
    type: z.literal("voteSurrender"),
    votes: z.array(surrenderVoteChoiceSchema),
  }),
]) satisfies z.ZodType<AllowedEngineAction>;

const viewerViewSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("table") }),
  z.strictObject({
    type: z.literal("seat"),
    seat: seatSchema,
    hand: z.array(cardSchema),
    faceDownCard: cardSchema.nullable(),
    allowedActions: z.array(allowedEngineActionSchema),
    resultDecided: teamSchema.nullable(),
  }),
]) satisfies z.ZodType<ViewerView>;

const publicEnginePhaseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("awaitingDeal"),
    reason: awaitingDealReasonSchema,
  }),
  z.strictObject({ type: z.literal("auction") }),
  z.strictObject({ type: z.literal("placingCard"), seat: seatSchema }),
  z.strictObject({ type: z.literal("play") }),
  z.strictObject({ type: z.literal("matchOver"), summary: matchSummarySchema }),
  z.strictObject({
    type: z.literal("sessionOver"),
    winner: teamSchema,
    summary: matchSummarySchema,
  }),
]) satisfies z.ZodType<PublicEnginePhase>;

/** The engine's `EngineView` for one seat or the Table view (engine §11.3). */
export const engineViewSchema = z.strictObject({
  phase: publicEnginePhaseSchema,
  seatCount: z.number().int().min(4).max(8),
  teams: z.array(teamSchema),
  tokens: teamAmountsSchema,
  dealer: seatSchema,
  turn: seatSchema.nullable(),
  auction: publicAuctionSchema.nullable(),
  contract: publicContractSchema.nullable(),
  faceDown: publicFaceDownSchema,
  cardCounts: z.array(count),
  currentRound: publicRoundSchema.nullable(),
  rounds: z.array(publicRoundSchema),
  points: teamAmountsSchema.nullable(),
  surrender: publicSurrenderSchema.nullable(),
  matchLog: z.array(matchSummarySchema),
  pastSessions: z.array(pastSessionSummarySchema),
  viewer: viewerViewSchema,
}) satisfies z.ZodType<EngineView>;

// ---------------------------------------------------------------------------
// Room capabilities (rooms spec §8.1). The server lists exactly what the
// principal may do right now; the web app renders these instead of
// re-deriving permissions. Engine seat actions are in
// `engine.viewer.allowedActions`.

/** What a player may do in the room itself. */
export type AllowedRoomAction =
  /** Exactly these empty seats may be taken. */
  | { type: "takeSeat"; seats: number[] }
  | { type: "leaveSeat" }
  /** `setReady` with this value (Ready, Unready, or Ready to resume). */
  | { type: "setReady"; ready: boolean }
  /** Any of the stable reactions, subject to the 2,000 ms cooldown. */
  | { type: "sendReaction" }
  | { type: "leaveRoom" };

export const allowedRoomActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("takeSeat"), seats: z.array(seatSchema) }),
  z.strictObject({ type: z.literal("leaveSeat") }),
  z.strictObject({ type: z.literal("setReady"), ready: z.boolean() }),
  z.strictObject({ type: z.literal("sendReaction") }),
  z.strictObject({ type: z.literal("leaveRoom") }),
]) satisfies z.ZodType<AllowedRoomAction>;

/** One player and the exact seats the host may move it to. */
export interface HostMoveTarget {
  playerId: PlayerId;
  seats: number[];
}

/**
 * What the host or an authorized Table view may do (design.md §10, §13).
 * Player lists hold exactly the legal targets.
 */
export type AllowedHostAction =
  | { type: "hostMovePlayer"; targets: HostMoveTarget[] }
  /** Any two distinct listed players may swap seats. */
  | { type: "hostSwapPlayers"; playerIds: PlayerId[] }
  | { type: "setFirstDealer"; seats: number[] }
  | { type: "removePlayer"; playerIds: PlayerId[] }
  | { type: "transferHost"; playerIds: PlayerId[] }
  /** End match: the engine's `allowedHostActions` for the current phase. */
  | { type: "endMatch"; restart: boolean; awardTeams: Team[] }
  | { type: "restartSession" };

export const allowedHostActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hostMovePlayer"),
    targets: z.array(
      z.strictObject({ playerId: playerIdSchema, seats: z.array(seatSchema) }),
    ),
  }),
  z.strictObject({
    type: z.literal("hostSwapPlayers"),
    playerIds: z.array(playerIdSchema),
  }),
  z.strictObject({
    type: z.literal("setFirstDealer"),
    seats: z.array(seatSchema),
  }),
  z.strictObject({
    type: z.literal("removePlayer"),
    playerIds: z.array(playerIdSchema),
  }),
  z.strictObject({
    type: z.literal("transferHost"),
    playerIds: z.array(playerIdSchema),
  }),
  z.strictObject({
    type: z.literal("endMatch"),
    restart: z.boolean(),
    awardTeams: z.array(teamSchema),
  }),
  z.strictObject({ type: z.literal("restartSession") }),
]) satisfies z.ZodType<AllowedHostAction>;

// ---------------------------------------------------------------------------
// Room view (rooms spec §8.1, §8.2)

/** The recipient of a view: a player identity or a Table view. */
export type RoomViewer =
  | {
      type: "player";
      playerId: PlayerId;
      seat: number | null;
      /** The seat this identity last occupied (rooms spec §3.1). */
      lastSeat: number | null;
    }
  | { type: "table" };

export const roomViewerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("player"),
    playerId: playerIdSchema,
    seat: seatSchema.nullable(),
    lastSeat: seatSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("table") }),
]) satisfies z.ZodType<RoomViewer>;

/**
 * One recipient's complete room view. It is built per recipient and never
 * contains credentials, PIN state, other seats' hands, or a hidden trump the
 * recipient may not see.
 *
 * - `players` are in join order; `seats` lists every numbered seat.
 * - `hostId` is null only while host selection is pending because no player
 *   is connected (rooms spec §5.3, §11).
 * - `engine` is null only before the first session starts. Whenever an
 *   engine exists, a seated player gets its own seat view, and every unseated
 *   player and every Table view get the public (`table`) engine view, which
 *   includes the session log and past sessions (rooms spec §3.1, §8.1;
 *   design.md §11). An unseated player never receives a hand.
 * - `allowedHostActions` is empty unless the viewer is the host or a Table
 *   view with host controls.
 */
export interface RoomView {
  roomCode: RoomCode;
  revision: number;
  phase: RoomPhase;
  settings: RoomSettings;
  hostId: PlayerId | null;
  firstDealer: number;
  gate: RoomGate;
  players: PublicPlayer[];
  seats: PublicSeat[];
  viewer: RoomViewer;
  engine: EngineView | null;
  allowedRoomActions: AllowedRoomAction[];
  allowedHostActions: AllowedHostAction[];
}

export const roomViewSchema = z.strictObject({
  roomCode: roomCodeSchema,
  revision: revisionSchema,
  phase: roomPhaseSchema,
  settings: roomSettingsSchema,
  hostId: playerIdSchema.nullable(),
  firstDealer: seatSchema,
  gate: roomGateSchema,
  players: z.array(publicPlayerSchema),
  seats: z.array(publicSeatSchema),
  viewer: roomViewerSchema,
  engine: engineViewSchema.nullable(),
  allowedRoomActions: z.array(allowedRoomActionSchema),
  allowedHostActions: z.array(allowedHostActionSchema),
}) satisfies z.ZodType<RoomView>;
