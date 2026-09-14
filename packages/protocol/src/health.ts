import { z } from "zod";

export type HealthResponse = { status: "ok" } | { status: "unavailable" };

export const healthResponseSchema: z.ZodType<HealthResponse> =
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok") }).strict(),
    z.object({ status: z.literal("unavailable") }).strict(),
  ]);
