/** Pure backoff policy. No I/O, no logging. State lives on the client, in memory only. */

export type Signal = "ok" | "rate_limited" | "blocked";

export interface BackoffState {
  /** Consecutive rate limits since the last success. Indexes the ladder. */
  level: number;
  /** Epoch ms until which no request may be made, or null. */
  pausedUntil: number | null;
}

export const RATE_LIMIT_LADDER_MS = [2, 5, 15, 60].map((m) => m * 60_000);
export const BLOCK_PAUSE_MS = 60 * 60_000;

export const INITIAL_STATE: BackoffState = { level: 0, pausedUntil: null };

export function next(state: BackoffState, signal: Signal, now: number): BackoffState {
  switch (signal) {
    case "ok":
      return { level: 0, pausedUntil: null };
    case "rate_limited": {
      const step = Math.min(state.level, RATE_LIMIT_LADDER_MS.length - 1);
      const pause = RATE_LIMIT_LADDER_MS[step] ?? BLOCK_PAUSE_MS;
      return { level: state.level + 1, pausedUntil: now + pause };
    }
    case "blocked":
      return { level: state.level, pausedUntil: now + BLOCK_PAUSE_MS };
  }
}
