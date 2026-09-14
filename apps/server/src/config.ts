import { z } from "zod";

const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

const nonEmptyString = (name: string) =>
  z
    .string()
    .refine((value) => value.trim().length > 0, `${name} must not be empty`);

const portSchema = z
  .string()
  .regex(/^\d+$/, "PORT must be an integer between 1 and 65535")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65_535));

const pathSchema = z
  .string()
  .refine(
    (value) => value.trim().length > 0,
    "DEBUG_PASSWORD_FILE must not be empty",
  )
  .refine(
    (value) => !value.includes("\0"),
    "DEBUG_PASSWORD_FILE must be an absolute or relative file path",
  );

function parseHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);

    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const hasCredentials = url.username.length > 0 || url.password.length > 0;
    const containsOnlyOrigin =
      url.href === url.origin || url.href === `${url.origin}/`;

    return isHttp && !hasCredentials && containsOnlyOrigin ? url.origin : null;
  } catch {
    return null;
  }
}

const allowedOriginsSchema = z.string().transform((value, context) => {
  const origins = value.split(",").map((origin) => origin.trim());

  if (origins.some((origin) => origin.length === 0)) {
    context.addIssue({
      code: "custom",
      message: "ALLOWED_ORIGINS must not contain empty entries",
    });
    return z.NEVER;
  }

  const parsedOrigins: string[] = [];
  for (const origin of origins) {
    const parsedOrigin = parseHttpOrigin(origin);
    if (parsedOrigin === null) {
      context.addIssue({
        code: "custom",
        message: "ALLOWED_ORIGINS entries must be HTTP(S) origins",
      });
      return z.NEVER;
    }
    parsedOrigins.push(parsedOrigin);
  }

  return parsedOrigins;
});

const environmentSchema = z.object({
  HOST: nonEmptyString("HOST").default("127.0.0.1"),
  PORT: portSchema.default(8056),
  DATABASE_URL: nonEmptyString("DATABASE_URL").default(
    "sqlite://./fiftysix.db",
  ),
  DEBUG_PASSWORD_FILE: pathSchema.optional(),
  ALLOWED_ORIGINS: allowedOriginsSchema.optional(),
  LOG_LEVEL: logLevelSchema.default("info"),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  debugPasswordFile: string | null;
  allowedOrigins: readonly string[] | null;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function parseConfig(
  environment: Readonly<Record<string, string | undefined>>,
): AppConfig {
  const result = environmentSchema.safeParse({
    HOST: environment.HOST,
    PORT: environment.PORT,
    DATABASE_URL: environment.DATABASE_URL,
    DEBUG_PASSWORD_FILE: environment.DEBUG_PASSWORD_FILE,
    ALLOWED_ORIGINS: environment.ALLOWED_ORIGINS,
    LOG_LEVEL: environment.LOG_LEVEL,
  });

  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  return {
    host: result.data.HOST,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    debugPasswordFile: result.data.DEBUG_PASSWORD_FILE ?? null,
    allowedOrigins: result.data.ALLOWED_ORIGINS ?? null,
    logLevel: result.data.LOG_LEVEL,
  };
}
