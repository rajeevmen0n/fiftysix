import { openSqliteStorage } from "./sqlite/sqlite-storage.js";

export interface ApplicationStorage {
  migrate(): Promise<void>;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageFactory {
  open(databaseUrl: string): Promise<ApplicationStorage>;
}

function databaseUrlScheme(databaseUrl: string): string | null {
  return /^([a-z][a-z\d+.-]*):/i.exec(databaseUrl)?.[1]?.toLowerCase() ?? null;
}

export function createStorageFactory(): StorageFactory {
  return {
    async open(databaseUrl) {
      const scheme = databaseUrlScheme(databaseUrl);

      if (scheme === "sqlite") {
        return openSqliteStorage(databaseUrl);
      }

      const displayedScheme = scheme === null ? "missing" : `${scheme}:`;
      throw new Error(
        `Unsupported database URL scheme "${displayedScheme}"; expected "sqlite:"`,
      );
    },
  };
}
