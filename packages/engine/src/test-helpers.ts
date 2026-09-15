// Shared test-only utilities. Not part of the engine's public surface
// (index.ts never exports from here) and never imported by production code.

/**
 * Recursively freezes a value in place and returns it, so a test can prove
 * `decide`/`act`/`evolve` never mutate a caller-owned input: any attempted
 * write throws instead of silently succeeding.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
