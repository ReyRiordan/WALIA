# Loop

Code: `src/core/loop.ts`. Composed in `src/index.ts`.

```ts
new Loop({ config, store, client, notifier, classifier, alerter, now?, setTimeout?, clearTimeout?, log? })
loop.start()                       // first cycle now, then the setTimeout chain
await loop.stop()                  // stop flag, clear timer, wait for the in-flight cycle
loop.status(): LoopStatus          // what /health reports
await loop.runCycle(now?): CycleSummary   // one cycle; tests call this directly

NO_CARDS_THRESHOLD = 3; CLASSIFIER_DOWN_THRESHOLD = 3; STALE_INTERVALS = 3
```

One process, one cycle at a time. Every collaborator is injected, so `loop.test.ts` runs a real `LinkedInClient` and a real in-memory `Store` against a scripted fetch, a fake notifier and classifier, and a fake clock and timer.

## Scheduling

`start()` runs the first cycle immediately with `firstCycleRecencySec`; every later cycle uses `recencySec`. Nothing posted before boot is recovered. After each cycle the next one is scheduled with one `setTimeout` at the later of `now + pollIntervalSec` and `client.pausedUntil()`, so a backoff pause pushes the whole cycle back rather than running it to fail on the first request. Cycles never overlap.

## Cycle

`runCycle(now)` runs these steps with the same `now` throughout:

1. `client.beginCycle()`.
2. For each search in config order: `scrapeSearch`, then `store.insertJobs` on everything it returned, skipped jobs included. Jobs already in the store are not collected. A posting that matches two searches is `isSeen` by the second and costs one detail fetch. `deferred` is logged and nothing else; the ids come back next cycle. `halted.signal` maps to a `rate_limited` or `blocked` alert; a transient halt is a warning.
3. `groupByKey` over every fresh job without `skip`, then drop each group whose key has a `notifications` row in the last `dedupe.windowDays`. A covered key never reaches the classifier.
4. Per group, classify the first job that has a description and store the verdict on that row only. Other clones keep a null verdict. A group with no description anywhere skips the classifier and goes out untagged. `degreeOk === "no"` suppresses the group, which creates no row, so a later clone of the same key is not blocked.
5. Sort the surviving groups by the newest `postedAt` among their jobs, ascending, groups with no timestamp first, then `createNotifications` in one transaction. Row ids therefore ascend in posting order across searches and the newest posting is the last message in the chat.
6. Drain. If `notifier.isReady()` is false the rows wait. Otherwise every `unsentNotifications()` row goes out in id order, so a row left over from a crash or a failed send is sent before this cycle's rows, through the same code. The group is rebuilt with `groupByKey(row.jobs)` and the verdict is taken from whichever job has one. Each success is followed by `markSent` for that one row. A `send` that throws leaves its row unsent, alerts `send_failed`, and the drain moves on. A readiness flip to false mid-drain stops it.
7. Record `lastCycleAt`, and `lastSuccessfulCycleAt` when nothing threw. Log the `CycleSummary`.

## Failure

`runCycle` never rejects. A throw that escapes a step (a store error, a grouping bug, anything that is not a `ScrapeError` handled inside the scraper) logs at error, alerts `cycle_failed`, and leaves `lastSuccessfulCycleAt` alone, so `/health` shows the loop going stale while the process keeps running. The next cycle is scheduled as usual. A restart would lose the in-memory backoff state and fire another first cycle at LinkedIn, so only boot failures exit the process.

## Alert counters

The `Alerter` only throttles (docs/notifier/alerts.md). The counters live here.

| Condition | Rule |
| --- | --- |
| `no_cards` | One search reports `cardsOnFirstPage === 0` for 3 consecutive cycles that did not halt. One counter per search, reset by any cycle with cards. A halted cycle neither counts nor resets. Fires every cycle past the third; the hourly throttle caps that at one message. A genuinely quiet hour can trip it; the text names the search. |
| `classifier_down` | 3 consecutive `ClassifyResult.error !== null` across groups and cycles, reset by any clean answer. |
| `rate_limited`, `blocked` | Mapped straight from `halted.signal`, once per search per cycle. |
| `send_failed` | Any `send` that threw. |
| `cycle_failed` | The caught cycle error above. |

## Shutdown

`stop()` sets a stopping flag and clears the pending timer. The running cycle checks the flag after each search, before each classify, and before each send, and returns at the first one it finds set; the one in-flight await finishes naturally. `stop()` resolves when that cycle returns. Every store write is one transaction and an unsent row is retried on the next boot, so returning between steps loses nothing. The 10 s deadline and the exit codes are in `src/index.ts`; see docs/operations/run.md.

## Status

`status()` feeds `/health` (docs/operations/health.md). `status` is `notifier_down` when `isReady()` is false, else `paused` when `pausedUntil` is in the future, else `stale` when the last successful cycle, or boot when there is none yet, is more than `STALE_INTERVALS * pollIntervalSec` ago, else `ok`.

## CycleSummary

Logged at info as `cycle finished`, with `stopped: true` when the cycle returned early on the stop flag.

| Field | Meaning |
| --- | --- |
| `searches[]` | Per search: `label`, `jobs` fetched, `inserted`, `deferred`, `cardsOnFirstPage`, `halted` signal or null. |
| `groups` | Groups that passed the window. |
| `suppressed` | Groups dropped on `degreeOk === "no"`. |
| `created` | Notification rows created this cycle. |
| `sent` | Rows sent this cycle, retries included. |
| `failed` | Sends that threw. Their rows stay unsent. |
