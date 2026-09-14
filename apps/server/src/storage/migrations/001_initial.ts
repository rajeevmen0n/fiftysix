import type { Migration } from "kysely";

/**
 * Intentional no-domain-table baseline. Kysely's migration metadata verifies
 * discovery and locking while leaving 002_rooms available for the room schema.
 */
export const initialMigration: Migration = {
  up: () => Promise.resolve(),
  down: () => Promise.resolve(),
};
