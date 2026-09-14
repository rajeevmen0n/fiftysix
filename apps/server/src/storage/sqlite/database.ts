import { resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

type DatabaseSchema = Record<never, never>;

export type SqliteDatabaseTarget =
  | { readonly kind: "memory" }
  | {
      readonly kind: "file";
      readonly pathKind: "absolute" | "relative";
      readonly path: string;
    };

export interface OpenSqliteDatabase {
  readonly kysely: Kysely<DatabaseSchema>;
  checkHealth(): void;
}

function targetFilename(target: SqliteDatabaseTarget): string {
  if (target.kind === "memory") {
    return ":memory:";
  }

  return target.pathKind === "relative" ? resolve(target.path) : target.path;
}

export function openSqliteDatabase(
  target: SqliteDatabaseTarget,
): OpenSqliteDatabase {
  const sqlite = new BetterSqlite3(targetFilename(target));

  try {
    sqlite.pragma("foreign_keys = ON");

    return {
      kysely: new Kysely<DatabaseSchema>({
        dialect: new SqliteDialect({ database: sqlite }),
      }),
      checkHealth() {
        sqlite.prepare("SELECT 1").get();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
