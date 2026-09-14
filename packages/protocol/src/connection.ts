import { z } from "zod";

const maximumHelloTokenLength = 4_096;

export interface HelloMessage {
  type: "hello";
  token: string;
}

export const helloMessageSchema: z.ZodType<HelloMessage> = z
  .object({
    type: z.literal("hello"),
    token: z.string().min(1).max(maximumHelloTokenLength),
  })
  .strict();

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

const protocolErrorMessageSchema: z.ZodType<ProtocolErrorMessage> = z
  .object({
    type: z.literal("error"),
    code: z.enum([
      "hello_required",
      "invalid_message",
      "message_too_large",
      "origin_not_allowed",
      "invalid_token",
    ]),
  })
  .strict();

export const clientMessageSchema: z.ZodType<HelloMessage> = helloMessageSchema;
export const serverMessageSchema: z.ZodType<ProtocolErrorMessage> =
  protocolErrorMessageSchema;

export type ClientMessage = HelloMessage;
export type ServerMessage = ProtocolErrorMessage;
