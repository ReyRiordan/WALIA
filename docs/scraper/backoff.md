# Backoff

Code: `src/scraper/backoff.ts`.

A pure function, `next(state, signal, now)`, with no I/O. The client owns the state and calls it after every mapped response. Transient errors and 404s never reach it.

| Signal | Effect |
| --- | --- |
| `ok` | level 0, pause cleared |
| `rate_limited` | pause for the ladder entry at the current level, then level + 1. Consecutive 429s pause 2, 5, 15, 60, 60, ... minutes. |
| `blocked` | pause one hour, level unchanged |

State is `{ level, pausedUntil }` in memory only. Nothing is persisted, so a restart mid-pause forgets the pause. The cost is at most one extra request, which re-enters backoff at level one if LinkedIn is still refusing.
