import { type MigrationProvider, Migrator } from "kysely";

import { initialMigration } from "../migrations/001_initial.js";
import type { ApplicationStorage } from "../storage.js";
import { openSqliteDatabase, type SqliteDatabaseTarget } from "./database.js";

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { "001_initial": initialMigration };
  },
};

function parseSqliteDatabaseUrl(databaseUrl: string): SqliteDatabaseTarget {
  const sqliteUrlPrefix = "sqlite://";

  if (!databaseUrl.toLowerCase().startsWith(sqliteUrlPrefix)) {
    throw new Error(`Invalid SQLite database URL "${databaseUrl}"`);
  }

  const target = databaseUrl.slice(sqliteUrlPrefix.length);

  if (target === ":memory:") {
    return { kind: "memory" };
  }

  if (target.startsWith("./") && target.length > 2) {
    return { kind: "file", pathKind: "relative", path: target };
  }

  if (target.startsWith("/") && target.length > 1) {
    return { kind: "file", pathKind: "absolute", path: target };
  }

  throw new Error(
    `Invalid SQLite database URL "${databaseUrl}"; expected sqlite://./relative.db, sqlite:///absolute/path.db, or sqlite://:memory:`,
  );
}

export async function openSqliteStorage(
  databaseUrl: string,
): Promise<ApplicationStorage> {
  const database = openSqliteDatabase(parseSqliteDatabaseUrl(databaseUrl));
  const migrator = new Migrator({
    db: database.kysely,
    provider: migrationProvider,
  });
  let closePromise: Promise<void> | null = null;

  return {
    async migrate() {
      const result = await migrator.migrateToLatest();

      if (result.error !== undefined) {
        throw new Error("Failed to migrate the SQLite database", {
          cause: result.error,
        });
      }
    },
    async checkHealth() {
      database.checkHealth();
    },
    close() {
      closePromise ??= database.kysely.destroy();
      return closePromise;
    },
  };
}
