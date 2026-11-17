import type { RedactedEngineEvent } from "@fiftysix/engine";
import { z } from "zod";

import {
  bidStyleSchema,
  bidSuitSchema,
  cardSchema,
  type PlayerId,
  type PublicPlayer,
  playerIdSchema,
  publicPlayerSchema,
  type ReactionId,
  reactionIdSchema,
  seatSchema,
  surrenderVoteChoiceSchema,
  teamSchema,
} from "./model.js";
import {
  auctionStageSchema,
  illegalPlayKindSchema,
  matchSummarySchema,
  publicContractSchema,
  redealReasonSchema,
  teamAmountsSchema,
} from "./views.js";

// Recipient-safe room events (rooms spec §8.3). The server journals canonical
// internal events and redacts them for each recipient immediately before
// delivery; only these shapes cross the network. Access revocation and expiry
// reach the affected sockets as the terminal `accessRevoked` message; other
// recipients see an intentional departure or removal as `playerLeft`.

const count = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Redacted engine events (engine `RedactedEngineEvent`)

const seatEvent = <Type extends string>(type: Type) =>
  z.strictObject({ type: z.literal(type), seat: seatSchema });

export const redactedEngineEventSchema = z.discriminatedUnion("type", [
  // Session
  z.strictObject({
    type: z.literal("sessionStarted"),
    firstDealer: seatSchema,
    tokens: teamAmountsSchema,
  }),
  z.strictObject({
    type: z.literal("sessionRestarted"),
    firstDealer: seatSchema,
  }),
  z.strictObject({ type: z.literal("sessionEnded"), winner: teamSchema }),
  z.strictObject({ type: z.literal("nextMatchStarted"), dealer: seatSchema }),
  // Deal
  z.strictObject({
    type: z.literal("dealt"),
    stage: z.enum(["full", "first", "second"]),
    hand: z.array(cardSchema).nullable(),
    cardCounts: z.array(count),
  }),
  z.strictObject({ type: z.literal("redealt"), reason: redealReasonSchema }),
  // Auction
  z.strictObject({
    type: z.literal("auctionStarted"),
    stage: auctionStageSchema,
    firstTurn: seatSchema,
    minBid: z.number().int(),
  }),
  z.strictObject({
    type: z.literal("bidMade"),
    seat: seatSchema,
    amount: z.number().int(),
    suit: bidSuitSchema.nullable(),
    style: bidStyleSchema.nullable(),
  }),
  seatEvent("passed"),
  seatEvent("doubled"),
  z.strictObject({ type: z.literal("doubleCancelled") }),
  seatEvent("redoubled"),
  z.strictObject({
    type: z.literal("forcedBid"),
    seat: seatSchema,
    amount: z.number().int(),
  }),
  z.strictObject({
    type: z.literal("auctionEnded"),
    contract: publicContractSchema,
  }),
  // 28 face-down card
  seatEvent("placingCardStarted"),
  z.strictObject({
    type: z.literal("cardPlaced"),
    seat: seatSchema,
    card: cardSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("faceDownReturned"),
    seat: seatSchema,
    card: cardSchema.nullable(),
  }),
  seatEvent("revealAsked"),
  z.strictObject({ type: z.literal("trumpRevealed"), card: cardSchema }),
  // Play
  z.strictObject({ type: z.literal("playStarted"), leader: seatSchema }),
  z.strictObject({
    type: z.literal("cardPlayed"),
    seat: seatSchema,
    card: cardSchema,
    fromFaceDown: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("roundWon"),
    seat: seatSchema,
    team: teamSchema,
    points: count.nullable(),
  }),
  z.strictObject({
    type: z.literal("disqualified"),
    seat: seatSchema,
    kind: illegalPlayKindSchema,
  }),
  // Surrender
  z.strictObject({ type: z.literal("resultDecided"), losingTeam: teamSchema }),
  seatEvent("surrenderProposed"),
  z.strictObject({
    type: z.literal("surrenderVoted"),
    seat: seatSchema,
    vote: surrenderVoteChoiceSchema,
  }),
  z.strictObject({ type: z.literal("surrenderFailed") }),
  z.strictObject({ type: z.literal("surrendered"), team: teamSchema }),
  // End of match
  z.strictObject({
    type: z.literal("matchEnded"),
    summary: matchSummarySchema,
  }),
]) satisfies z.ZodType<RedactedEngineEvent>;

// ---------------------------------------------------------------------------
// Room events

/** Why an identity left the room permanently (rooms spec §3.4). */
export type PlayerLeftReason = "left" | "removed";

/**
 * Why the host role moved (rooms spec §5.3): handed over by the host, after
 * the host transfer wait elapsed, or because the host left or was removed.
 */
export type HostChangeReason = "handedOver" | "waitElapsed" | "hostDeparted";

export type RoomEvent =
  /** A new identity joined, always unseated and Unready. */
  | { type: "playerJoined"; player: PublicPlayer }
  | { type: "playerLeft"; playerId: PlayerId; reason: PlayerLeftReason }
  | { type: "seatTaken"; playerId: PlayerId; seat: number }
  | { type: "seatLeft"; playerId: PlayerId; seat: number }
  /** The host moved a player; `from` is null for an unseated player. */
  | { type: "playerMoved"; playerId: PlayerId; from: number | null; to: number }
  /** The host swapped two players; each seat is the one it now occupies. */
  | {
      type: "playersSwapped";
      first: PlayerId;
      firstSeat: number;
      second: PlayerId;
      secondSeat: number;
    }
  | { type: "firstDealerChanged"; seat: number }
  | { type: "readyChanged"; playerId: PlayerId; ready: boolean }
  /** A seat or first-dealer change, or a finished match, cleared every Ready. */
  | { type: "readinessCleared" }
  | { type: "playerConnected"; playerId: PlayerId }
  | { type: "playerDisconnected"; playerId: PlayerId }
  /** An active match paused because a required seat is missing (§5.1). */
  | { type: "matchStalled" }
  /** Every required seat is back; the match continues. */
  | { type: "matchResumed" }
  /** `hostId` is null while no player is connected to receive the role. */
  | { type: "hostChanged"; hostId: PlayerId | null; reason: HostChangeReason }
  | { type: "reactionSent"; playerId: PlayerId; reaction: ReactionId }
  /**
   * The host's Restart session: everyone is unseated and Unready and the room
   * returns to `arranging` with this newly chosen first dealer (§4.1).
   */
  | { type: "sessionReset"; firstDealer: number }
  /** One engine event, already redacted for this recipient. */
  | { type: "engine"; event: RedactedEngineEvent };

export type RoomEventType = RoomEvent["type"];

const playerEvent = <Type extends string>(type: Type) =>
  z.strictObject({ type: z.literal(type), playerId: playerIdSchema });

export const roomEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("playerJoined"),
    player: publicPlayerSchema,
  }),
  z.strictObject({
    type: z.literal("playerLeft"),
    playerId: playerIdSchema,
    reason: z.enum(["left", "removed"]),
  }),
  z.strictObject({
    type: z.literal("seatTaken"),
    playerId: playerIdSchema,
    seat: seatSchema,
  }),
  z.strictObject({
    type: z.literal("seatLeft"),
    playerId: playerIdSchema,
    seat: seatSchema,
  }),
  z.strictObject({
    type: z.literal("playerMoved"),
    playerId: playerIdSchema,
    from: seatSchema.nullable(),
    to: seatSchema,
  }),
  z.strictObject({
    type: z.literal("playersSwapped"),
    first: playerIdSchema,
    firstSeat: seatSchema,
    second: playerIdSchema,
    secondSeat: seatSchema,
  }),
  z.strictObject({ type: z.literal("firstDealerChanged"), seat: seatSchema }),
  z.strictObject({
    type: z.literal("readyChanged"),
    playerId: playerIdSchema,
    ready: z.boolean(),
  }),
  z.strictObject({ type: z.literal("readinessCleared") }),
  playerEvent("playerConnected"),
  playerEvent("playerDisconnected"),
  z.strictObject({ type: z.literal("matchStalled") }),
  z.strictObject({ type: z.literal("matchResumed") }),
  z.strictObject({
    type: z.literal("hostChanged"),
    hostId: playerIdSchema.nullable(),
    reason: z.enum(["handedOver", "waitElapsed", "hostDeparted"]),
  }),
  z.strictObject({
    type: z.literal("reactionSent"),
    playerId: playerIdSchema,
    reaction: reactionIdSchema,
  }),
  z.strictObject({ type: z.literal("sessionReset"), firstDealer: seatSchema }),
  z.strictObject({
    type: z.literal("engine"),
    event: redactedEngineEventSchema,
  }),
]) satisfies z.ZodType<RoomEvent>;
