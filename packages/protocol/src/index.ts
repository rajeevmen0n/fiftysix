import type { EngineBoundary } from "@fiftysix/engine";

export type {
  ClientMessage,
  HelloMessage,
  ProtocolErrorCode,
  ProtocolErrorMessage,
  ServerMessage,
} from "./connection.js";
export {
  clientMessageSchema,
  helloMessageSchema,
  serverMessageSchema,
} from "./connection.js";
export type { HealthResponse } from "./health.js";
export { healthResponseSchema } from "./health.js";

export type ProtocolBoundary = EngineBoundary;
