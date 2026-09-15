import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfig } from "./config.js";
import type { EngineConfig, StakeTier } from "./types.js";

function config56(stakeTiers: readonly StakeTier[]): EngineConfig {
  return {
    gameType: "56",
    playerCount: 4,
    includeEightsAndSevens: false,
    illegalPlayMode: "block",
    startingTokens: 10,
    stakeTiers,
    redealThreshold: 2,
    surrenderOption: "off",
  };
}

function issuesFor(config: EngineConfig): readonly string[] {
  const rejection = validateConfig(config);
  assert.notEqual(rejection, null);
  const issues = rejection?.details.issues;
  assert.ok(Array.isArray(issues));
  return issues as string[];
}

describe("validateConfig stake-tier ordering", () => {
  it("rejects a win stake that decreases at a higher bid", () => {
    const issues = issuesFor(
      config56([
        { fromBid: 28, toBid: 39, winStake: 3, lossStake: 2 },
        { fromBid: 40, toBid: 56, winStake: 2, lossStake: 3 },
      ]),
    );

    assert.ok(
      issues.includes(
        "stakeTiers[1].winStake must not be lower than the previous tier's",
      ),
    );
  });

  it("rejects a loss stake that decreases at a higher bid", () => {
    const issues = issuesFor(
      config56([
        { fromBid: 28, toBid: 39, winStake: 1, lossStake: 4 },
        { fromBid: 40, toBid: 56, winStake: 2, lossStake: 3 },
      ]),
    );

    assert.ok(
      issues.includes(
        "stakeTiers[1].lossStake must not be lower than the previous tier's",
      ),
    );
  });

  it("accepts equal stakes and stakes that increase with the bid", () => {
    assert.equal(
      validateConfig(
        config56([
          { fromBid: 28, toBid: 39, winStake: 1, lossStake: 2 },
          { fromBid: 40, toBid: 47, winStake: 1, lossStake: 3 },
          { fromBid: 48, toBid: 56, winStake: 2, lossStake: 3 },
        ]),
      ),
      null,
    );
  });

  it("rejects malformed values without letting them mask later decreases", () => {
    const malformed = config56([
      { fromBid: 28, toBid: 39, winStake: 5, lossStake: 6 },
      {
        fromBid: 40,
        toBid: 47,
        winStake: Number.NaN,
        lossStake: "invalid",
      } as unknown as StakeTier,
      { fromBid: 48, toBid: 56, winStake: 4, lossStake: 5 },
    ]);

    assert.doesNotThrow(() => validateConfig(malformed));
    const issues = issuesFor(malformed);
    assert.ok(
      issues.includes(
        "stakeTiers[1].winStake must be a whole number from 1 through 999",
      ),
    );
    assert.ok(
      issues.includes(
        "stakeTiers[1].lossStake must be a whole number from 1 through 999",
      ),
    );
    assert.ok(
      issues.includes(
        "stakeTiers[2].winStake must not be lower than the previous tier's",
      ),
    );
    assert.ok(
      issues.includes(
        "stakeTiers[2].lossStake must not be lower than the previous tier's",
      ),
    );
  });

  it("rejects malformed bid bounds without throwing", () => {
    const malformed = config56([
      {
        fromBid: Symbol("fromBid"),
        toBid: Symbol("toBid"),
        winStake: 1,
        lossStake: 2,
      } as unknown as StakeTier,
    ]);

    assert.doesNotThrow(() => validateConfig(malformed));
    assert.ok(
      issuesFor(malformed).includes(
        "stakeTiers[0] bid bounds must be whole numbers",
      ),
    );
  });
});
