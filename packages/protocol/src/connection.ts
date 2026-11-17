import { z } from "zod";

import { accessTokenSchema } from "./rooms/model.js";

/** The first message on every connection (rooms spec §7.2). */
export interface HelloMessage {
  type: "hello";
  token: string;
}

export const helloMessageSchema = z.strictObject({
  type: z.literal("hello"),
  token: accessTokenSchema,
}) satisfies z.ZodType<HelloMessage>;

/** Connection- and protocol-level failures (rooms spec §7.3). */
export type ProtocolErrorCode =
  | "hello_required"
  | "invalid_message"
  | "message_too_large"
  | "origin_not_allowed"
  | "invalid_token";

export interface ProtocolErrorMessage {
  type: "error";
  code: ProtocolErrorCode;
}

export const protocolErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  code: z.enum([
    "hello_required",
    "invalid_message",
    "message_too_large",
    "origin_not_allowed",
    "invalid_token",
  ]),
}) satisfies z.ZodType<ProtocolErrorMessage>;
