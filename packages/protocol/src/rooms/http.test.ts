import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRoomRequestSchema,
  defaultStakeTiers,
  httpErrorResponseSchema,
  joinRoomRequestSchema,
  maximumNameBytes,
  openTableRequestSchema,
  pinSchema,
  playerNameSchema,
  roomSettingsInputSchema,
} from "./http.js";
import { roomRejectionCodes, roomSettingsSchema } from "./model.js";

const basic56 = {
  gameType: "56",
  playerCount: 4,
  includeEightsAndSevens: false,
  illegalPlayMode: "block",
} as const;
const basic28 = {
  gameType: "28",
  playerCount: 4,
  illegalPlayMode: "autoStop",
} as const;

function accepts(value: unknown): boolean {
  return roomSettingsInputSchema.safeParse(value).success;
}

describe("player names", () => {
  it("accepts ordinary, Malayalam, joiner and emoji names", () => {
    for (const name of [
      "Anu",
      "  Anu  ",
      "മീര",
      // Chillu written with ZWJ, and a ZWNJ-separated conjunct.
      "അവന്\u200d",
      "ക്\u200cഷ",
      "👨‍👩‍👧‍👦",
      "🇮🇳",
      "Rájeev",
    ]) {
      assert.equal(playerNameSchema.parse(name), name);
    }
  });

  it("bounds the UTF-8 length at 1,024 bytes", () => {
    const fourByte = "😀";
    assert.equal(
      playerNameSchema.safeParse(fourByte.repeat(256)).success,
      true,
    );
    assert.equal(
      playerNameSchema.safeParse(`${fourByte.repeat(256)}a`).success,
      false,
    );
    assert.equal(
      playerNameSchema.safeParse("a".repeat(maximumNameBytes)).success,
      true,
    );
    assert.equal(
      playerNameSchema.safeParse("മ".repeat(342)).success,
      false,
      "342 three-byte characters are 1,026 bytes",
    );
  });

  it("rejects empty, multi-line, control-character and ill-formed names", () => {
    for (const name of [
      "",
      "a\u0000b",
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u001bb",
      "a\u007fb",
      "a\u0085b",
      "a b",
      "a b",
      "a\ud800b",
      "\udc00",
      "a\u202Eb",
      "a\u202Ab",
      "a\u2066b",
      "a\u2069b",
      42,
      null,
    ]) {
      assert.equal(
        playerNameSchema.safeParse(name).success,
        false,
        JSON.stringify(name),
      );
    }
  });
});

describe("PINs", () => {
  it("accepts exactly four ASCII digits", () => {
    for (const pin of ["0000", "1234", "9999"]) {
      assert.equal(pinSchema.parse(pin), pin);
    }
    for (const pin of [
      "123",
      "12345",
      "12a4",
      " 1234",
      "1234\n",
      "١٢٣٤",
      "１２３４",
      "",
      1234,
    ]) {
      assert.equal(pinSchema.safeParse(pin).success, false, String(pin));
    }
  });
});

describe("room settings", () => {
  it("defaults every advanced 56 setting from design.md", () => {
    const settings = roomSettingsInputSchema.parse(basic56);
    assert.deepEqual(settings, {
      ...basic56,
      startingTokens: 10,
      stakeTiers: defaultStakeTiers["56"],
      redealThreshold: 2,
      surrenderOption: "off",
      roundHistory: "last",
      livePoints: false,
      hostTransferWaitSeconds: 60,
    });
    assert.deepEqual(roomSettingsSchema.parse(settings), settings);
  });

  it("defaults every advanced 28 setting and always includes 8s and 7s", () => {
    const settings = roomSettingsInputSchema.parse(basic28);
    assert.deepEqual(settings, {
      ...basic28,
      includeEightsAndSevens: true,
      startingTokens: 10,
      stakeTiers: defaultStakeTiers["28"],
      redealThreshold: 1,
      surrenderOption: "off",
      roundHistory: "last",
      livePoints: false,
      hostTransferWaitSeconds: 60,
    });
    assert.deepEqual(roomSettingsSchema.parse(settings), settings);
    assert.equal(accepts({ ...basic28, includeEightsAndSevens: true }), true);
    assert.equal(accepts({ ...basic28, includeEightsAndSevens: false }), false);
  });

  it("gives each parse its own copy of the default stake tiers", () => {
    const first = roomSettingsInputSchema.parse(basic56);
    const second = roomSettingsInputSchema.parse(basic56);
    assert.notEqual(first.stakeTiers, second.stakeTiers);
    assert.notEqual(first.stakeTiers[0], defaultStakeTiers["56"][0]);
  });

  it("keeps submitted advanced settings", () => {
    const advanced = {
      startingTokens: 999,
      stakeTiers: [{ fromBid: 28, toBid: 56, winStake: 999, lossStake: 999 }],
      redealThreshold: 0,
      surrenderOption: "on",
      roundHistory: "full",
      livePoints: true,
      hostTransferWaitSeconds: 3_600,
    } as const;
    assert.deepEqual(
      roomSettingsInputSchema.parse({ ...basic56, ...advanced }),
      { ...basic56, ...advanced },
    );
  });

  it("requires every basic setting", () => {
    for (const key of Object.keys(basic56)) {
      const partial: Record<string, unknown> = { ...basic56 };
      delete partial[key];
      assert.equal(accepts(partial), false, key);
    }
    for (const key of ["playerCount", "illegalPlayMode"]) {
      const partial: Record<string, unknown> = { ...basic28 };
      delete partial[key];
      assert.equal(accepts(partial), false, key);
    }
  });

  it("allows only the documented games and player counts", () => {
    for (const playerCount of [4, 6, 8]) {
      assert.equal(accepts({ ...basic56, playerCount }), true);
    }
    for (const playerCount of [2, 5, 10]) {
      assert.equal(accepts({ ...basic56, playerCount }), false);
    }
    assert.equal(accepts({ ...basic28, playerCount: 6 }), false);
    assert.equal(accepts({ ...basic56, gameType: "29" }), false);
    assert.equal(accepts({ ...basic56, illegalPlayMode: "warn" }), false);
  });

  it("enforces the whole-number caps from design.md", () => {
    const cases: [string, number, boolean][] = [
      ["startingTokens", 1, true],
      ["startingTokens", 999, true],
      ["startingTokens", 0, false],
      ["startingTokens", 1_000, false],
      ["startingTokens", 10.5, false],
      ["hostTransferWaitSeconds", 1, true],
      ["hostTransferWaitSeconds", 3_600, true],
      ["hostTransferWaitSeconds", 0, false],
      ["hostTransferWaitSeconds", 3_601, false],
      ["redealThreshold", -1, false],
      ["redealThreshold", 1.5, false],
    ];
    for (const [key, value, ok] of cases) {
      assert.equal(
        accepts({ ...basic56, [key]: value }),
        ok,
        `${key}=${value}`,
      );
    }
  });

  it("caps the redeal threshold per game and player count (rules §9)", () => {
    const caps = [
      [basic56, 4, 13],
      [basic56, 6, 8],
      [basic56, 8, 6],
      [basic28, 4, 6],
    ] as const;
    for (const [basic, playerCount, cap] of caps) {
      const settings = { ...basic, playerCount };
      assert.equal(accepts({ ...settings, redealThreshold: 0 }), true);
      assert.equal(accepts({ ...settings, redealThreshold: cap }), true);
      assert.equal(
        accepts({ ...settings, redealThreshold: cap + 1 }),
        false,
        `${basic.gameType}/${playerCount}`,
      );
    }
  });

  it("bounds stake tier bids to the game's range and stakes to 1–999", () => {
    const tier = (fromBid: number, toBid: number, win = 1, loss = 2) => ({
      fromBid,
      toBid,
      winStake: win,
      lossStake: loss,
    });
    assert.equal(accepts({ ...basic56, stakeTiers: [tier(28, 56)] }), true);
    assert.equal(accepts({ ...basic28, stakeTiers: [tier(14, 28)] }), true);
    for (const stakeTiers of [
      [],
      [tier(27, 56)],
      [tier(28, 57)],
      [tier(28, 56, 0)],
      [tier(28, 56, 1, 1_000)],
      [{ ...tier(28, 56), note: "x" }],
    ]) {
      assert.equal(accepts({ ...basic56, stakeTiers }), false);
    }
    assert.equal(accepts({ ...basic28, stakeTiers: [tier(14, 29)] }), false);
    assert.equal(accepts({ ...basic28, stakeTiers: [tier(13, 28)] }), false);
    assert.equal(
      accepts({ ...basic28, stakeTiers: Array(16).fill(tier(14, 14)) }),
      false,
    );
  });

  it("rejects unknown settings keys", () => {
    assert.equal(accepts({ ...basic56, tablePin: "1234" }), false);
    assert.equal(accepts({ ...basic56, turnTimer: 30 }), false);
  });
});

describe("HTTP requests and responses", () => {
  it("parses a create request with optional PINs", () => {
    const parsed = createRoomRequestSchema.parse({
      settings: basic28,
      name: "Meera",
    });
    assert.equal(parsed.name, "Meera");
    assert.equal(parsed.settings.gameType, "28");
    assert.equal("pin" in parsed, false);
    assert.equal("tablePin" in parsed, false);

    const withPins = createRoomRequestSchema.parse({
      settings: basic56,
      tablePin: "0420",
      name: "Meera",
      pin: "1234",
    });
    assert.equal(withPins.tablePin, "0420");
    assert.equal(withPins.pin, "1234");
  });

  it("rejects malformed create, join and Table requests", () => {
    const create: unknown[] = [
      { settings: basic56 },
      { settings: basic56, name: "a\nb" },
      { settings: basic56, name: "A", pin: "12" },
      { settings: basic56, name: "A", pin: null },
      { settings: basic56, name: "A", tablePin: "abcd" },
      { settings: basic56, name: "A", hostId: "x" },
    ];
    for (const body of create) {
      assert.equal(createRoomRequestSchema.safeParse(body).success, false);
    }
    assert.deepEqual(joinRoomRequestSchema.parse({ name: "A" }), { name: "A" });
    assert.deepEqual(joinRoomRequestSchema.parse({ name: "A", pin: "0000" }), {
      name: "A",
      pin: "0000",
    });
    for (const body of [
      {},
      { name: "A", pin: "00000" },
      { name: "A", seat: 1 },
    ]) {
      assert.equal(joinRoomRequestSchema.safeParse(body).success, false);
    }
    assert.deepEqual(openTableRequestSchema.parse({}), {});
    assert.deepEqual(openTableRequestSchema.parse({ pin: "1111" }), {
      pin: "1111",
    });
    for (const body of [{ pin: "1" }, { pin: "1111", name: "TV" }]) {
      assert.equal(openTableRequestSchema.safeParse(body).success, false);
    }
  });

  it("carries every room rejection code plus the HTTP-only codes", () => {
    for (const code of [
      ...roomRejectionCodes,
      "room_not_found",
      "invalid_request",
    ]) {
      assert.deepEqual(httpErrorResponseSchema.parse({ code }), { code });
    }
    assert.ok(roomRejectionCodes.includes("reaction_rate_limited"));
    assert.ok(roomRejectionCodes.includes("request_too_large"));
    assert.equal(
      httpErrorResponseSchema.safeParse({ code: "teapot" }).success,
      false,
    );
  });
});
