import { randomBytes, randomInt } from "node:crypto";

export interface RandomSource {
  bytes(length: number): Uint8Array;
  integer(maxExclusive: number): number;
}

export function createCryptoRandomSource(): RandomSource {
  return {
    bytes: randomBytes,
    integer: randomInt,
  };
}
