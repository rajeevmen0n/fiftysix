import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countGraphemes, nameComparisonKey, normalizeName } from "./names.js";

function accepted(raw: string): {
  displayName: string;
  normalizedName: string;
} {
  const result = normalizeName(raw);
  if (!result.ok) {
    assert.fail(
      `expected ${JSON.stringify(raw)} to be accepted: ${result.reason}`,
    );
  }
  return result;
}

function rejection(raw: string): string {
  const result = normalizeName(raw);
  if (result.ok) {
    assert.fail(`expected ${JSON.stringify(raw)} to be rejected`);
  }
  return result.reason;
}

describe("normalizeName", () => {
  it("trims and NFKC-normalizes the display name", () => {
    assert.equal(accepted("  Anu  ").displayName, "Anu");
    assert.equal(accepted("\u3000Ｒａｊｕ\u3000").displayName, "Raju");
    assert.equal(accepted("ﬁfty").displayName, "fifty");
    assert.equal(accepted("Anu  Raj").displayName, "Anu  Raj");
  });

  it("compares names case-insensitively and locale-independently", () => {
    assert.equal(
      accepted("ANU").normalizedName,
      accepted("anu").normalizedName,
    );
    assert.equal(
      accepted("Straße").normalizedName,
      accepted("STRASSE").normalizedName,
    );
    assert.equal(
      accepted("ΟΔΟΣ").normalizedName,
      accepted("οδοσ").normalizedName,
    );
    assert.equal(
      accepted("Ｒａｊｕ").normalizedName,
      accepted("RAJU").normalizedName,
    );
    assert.notEqual(
      accepted("Anu").normalizedName,
      accepted("Anil").normalizedName,
    );
    assert.equal(nameComparisonKey("Anu"), accepted("anu").normalizedName);
  });

  it("counts user-perceived characters, keeping Malayalam and emoji sequences", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // family emoji
    assert.equal(countGraphemes(family), 1);
    assert.equal(accepted(family.repeat(24)).displayName, family.repeat(24));
    assert.equal(rejection(family.repeat(25)), "tooLong");
    const malayalam = "അനു ക്ഷേത്ര";
    assert.equal(accepted(malayalam).displayName, malayalam.normalize("NFKC"));
    const chillu = "ന്\u200D"; // na + virama + ZWJ
    assert.equal(accepted(chillu).displayName.includes("\u200D"), true);
  });

  it("accepts 1 to 24 characters after trimming", () => {
    assert.equal(accepted("A").displayName, "A");
    assert.equal(accepted("x".repeat(24)).displayName.length, 24);
    assert.equal(rejection("x".repeat(25)), "tooLong");
    assert.equal(rejection(""), "empty");
    assert.equal(rejection(" \u3000\u00A0 "), "empty");
  });

  it("requires at least one visible character", () => {
    for (const invisible of [
      "\u200D", // ZWJ
      "\u200C\u200D", // ZWNJ + ZWJ
      "\u200B", // zero-width space
      "\u2060", // word joiner
      "\uFEFF", // byte-order mark
      "\u3164", // Hangul filler
      "\u00AD", // soft hyphen
      " \u200D \uFE0F ",
    ]) {
      assert.equal(rejection(invisible), "empty", JSON.stringify(invisible));
    }
    assert.equal(accepted("\u200DA").displayName, "\u200DA");
  });

  it("keeps ZWJ and ZWNJ inside Malayalam names", () => {
    for (const name of [
      "അവന്\u200D", // chillu written with ZWJ
      "ക്\u200Cഷ", // ZWNJ-separated conjunct
      "മീര ന്\u200Dറ", // ZWJ inside a longer name
    ]) {
      const result = accepted(name);
      assert.equal(result.displayName, name.normalize("NFKC"));
      assert.equal(
        /[\u200C\u200D]/u.test(result.displayName),
        true,
        JSON.stringify(name),
      );
    }
  });

  it("rejects control characters, line separators and ill-formed text", () => {
    assert.equal(rejection("A\u0000B"), "invalidCharacters");
    assert.equal(rejection("A\nB"), "invalidCharacters");
    assert.equal(rejection("A\u007FB"), "invalidCharacters");
    assert.equal(rejection("A\u0085B"), "invalidCharacters");
    assert.equal(rejection("A\u2028B"), "invalidCharacters");
    assert.equal(rejection("A\u2029B"), "invalidCharacters");
    assert.equal(rejection("A\uD800B"), "invalidCharacters");
    assert.equal(rejection("Anu\n"), "invalidCharacters");
  });

  it("rejects bidirectional embedding, override and isolate controls", () => {
    for (const code of [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ]) {
      const name = `Anu${String.fromCodePoint(code)}Raj`;
      assert.equal(rejection(name), "invalidCharacters", code.toString(16));
    }
  });
});
