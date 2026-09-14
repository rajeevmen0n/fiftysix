export interface Clock {
  now(): number;
}

export function createSystemClock(): Clock {
  return {
    now: Date.now,
  };
}
