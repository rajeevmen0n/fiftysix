import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The room aggregate is pure (rooms spec §2.3, plans R002–R003): its production
// modules import only the engine, the protocol and each other, and never
// read ambient time or randomness.

const pureModules = [
  "types.ts",
  "snapshot.ts",
  "names.ts",
  "invariants.ts",
  "seating.ts",
  "readiness.ts",
  "presence.ts",
  "host.ts",
  "index.ts",
];

const allowedImport = /^(?:@fiftysix\/(?:engine|protocol)|\.\/[a-z-]+\.js)$/;
const ambientInput =
  /\bDate\b|\bMath\.random\b|\bperformance\b|\bcrypto\b|\bprocess\b|\bsetTimeout\b|\bsetInterval\b|\bconsole\b/;

describe("room aggregate purity", () => {
  for (const file of pureModules) {
    it(`${file} imports no I/O and reads no ambient input`, () => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const specifiers = [
        ...source.matchAll(/\bfrom\s+"([^"]+)"/g),
        ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g),
        ...source.matchAll(/^\s*import\s+"([^"]+)"/gm),
      ].map((match) => match[1] ?? "");
      for (const specifier of specifiers) {
        assert.match(specifier, allowedImport, `${file} imports ${specifier}`);
      }
      assert.doesNotMatch(source, /test-helpers/);
      assert.doesNotMatch(source, ambientInput);
    });
  }
});
