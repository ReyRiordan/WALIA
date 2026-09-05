import { describe, expect, it } from "vitest";
import { type BackoffState, BLOCK_PAUSE_MS, INITIAL_STATE, next } from "./backoff.ts";

const MIN = 60_000;

describe("backoff policy", () => {
  it("climbs the ladder 2, 5, 15, 60, 60 minutes on consecutive rate limits", () => {
    let state: BackoffState = INITIAL_STATE;
    const pauses: number[] = [];
    for (let i = 0; i < 5; i++) {
      state = next(state, "rate_limited", 0);
      pauses.push((state.pausedUntil ?? 0) / MIN);
    }
    expect(pauses).toEqual([2, 5, 15, 60, 60]);
    expect(state.level).toBe(5);
  });

  it("offsets the pause from now", () => {
    expect(next(INITIAL_STATE, "rate_limited", 1_000).pausedUntil).toBe(1_000 + 2 * MIN);
  });

  it("ok resets level and pause", () => {
    const paused = next(next(INITIAL_STATE, "rate_limited", 0), "rate_limited", 0);
    expect(next(paused, "ok", 0)).toEqual({ level: 0, pausedUntil: null });
  });

  it("blocked pauses one hour and keeps the level", () => {
    const state = next({ level: 3, pausedUntil: null }, "blocked", 500);
    expect(state).toEqual({ level: 3, pausedUntil: 500 + BLOCK_PAUSE_MS });
  });
});
