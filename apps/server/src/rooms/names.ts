// Display-name policy (rooms spec §3.1, design.md §9). The protocol schema
// applies the conservative byte bound first; this module is the authoritative
// check that the room service runs before admitting or matching a name.

export const minimumNameCharacters = 1;
export const maximumNameCharacters = 24;

/**
 * Names are single-line: no control character (`Cc`, including NUL, the
 * ASCII controls, DEL and C1 controls such as NEL) and no Unicode line or
 * paragraph separator. Joiners, variation selectors and combining marks are
 * not in these categories, so Malayalam conjuncts and emoji sequences stay.
 * The `Cc` breadth mirrors the provisional protocol rule (rooms spec §3.1).
 *
 * Bidirectional embedding, override and isolate controls (U+202A–U+202E,
 * U+2066–U+2069) are rejected too, so a name cannot reorder the text around
 * it (rooms spec §3.1, provisional). Zero-width joiners and non-joiners stay.
 */
const forbiddenNameCharacter =
  /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

/**
 * A visible character: anything other than whitespace, a control, a format
 * character (such as ZWJ or ZWNJ) or another default-ignorable code point.
 * A name needs at least one (rooms spec §3.1, provisional).
 */
const visibleCharacter =
  /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** Counts user-perceived characters (extended grapheme clusters). */
export function countGraphemes(value: string): number {
  let count = 0;
  for (const _ of graphemes.segment(value)) {
    count += 1;
  }
  return count;
}

/**
 * The case-insensitive comparison key: NFKC, then a locale-independent full
 * case mapping (upper then lower, so for example `ß`/`SS` and `ς`/`σ` match),
 * then NFKC again because case mapping can denormalize.
 */
export function nameComparisonKey(displayName: string): string {
  return displayName
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");
}

/**
 * The stored display-name form of a submitted name: trimmed, NFKC-normalized
 * and trimmed again (normalization can expose new edge whitespace).
 */
export function canonicalDisplayName(raw: string): string {
  return raw.trim().normalize("NFKC").trim();
}

export type NameRejection = "invalidCharacters" | "empty" | "tooLong";

export type NormalizedName =
  | { ok: true; displayName: string; normalizedName: string }
  | { ok: false; reason: NameRejection };

/**
 * Trims and NFKC-normalizes a submitted name, then requires at least one
 * visible character and 1–24 user-perceived characters (rooms spec §3.1).
 * The trimmed, normalized form is the display name; `normalizedName` is the
 * uniqueness key.
 */
export function normalizeName(raw: string): NormalizedName {
  if (!raw.isWellFormed() || forbiddenNameCharacter.test(raw)) {
    return { ok: false, reason: "invalidCharacters" };
  }
  const displayName = canonicalDisplayName(raw);
  if (forbiddenNameCharacter.test(displayName)) {
    return { ok: false, reason: "invalidCharacters" };
  }
  // A name of only format characters (such as a lone ZWJ) survives trimming;
  // it is empty for display purposes (rooms spec §3.1, provisional).
  const length = countGraphemes(displayName);
  if (length < minimumNameCharacters || !visibleCharacter.test(displayName)) {
    return { ok: false, reason: "empty" };
  }
  if (length > maximumNameCharacters) {
    return { ok: false, reason: "tooLong" };
  }
  return {
    ok: true,
    displayName,
    normalizedName: nameComparisonKey(displayName),
  };
}
