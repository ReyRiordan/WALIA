# Alerts

Code: `src/notifier/alerts.ts`.

```ts
type AlertCondition =
  | "rate_limited" | "blocked" | "no_cards" | "send_failed" | "classifier_down" | "cycle_failed";

class Alerter {
  constructor(notifier: Pick<Notifier, "sendAdmin">, opts?: { intervalMs?: number; now?: () => number })
  alert(condition: AlertCondition, text: string): Promise<void>
}
```

`Alerter` wraps `sendAdmin` with one map of condition to last-sent time. The same condition sends at most once per hour. A throttled call logs at `info` with the condition and the seconds until it can fire again. The message is the text prefixed with the condition in brackets, so the admin sees `[blocked] ...`. `alert` never throws; `sendAdmin` already swallows, and the alerter logs anything that still escapes.

Detection stays in the loop, which has the cross-cycle counters (docs/core/loop.md). The alerter only throttles.

| Condition | Detected from | Threshold |
| --- | --- | --- |
| `rate_limited`, `blocked` | The scraper's `ScrapeError` signal. The names match so the loop maps `halted.signal` straight through. | Every halted search. |
| `no_cards` | `cardsOnFirstPage` at zero for one search. | 3 consecutive unhalted cycles, per search. |
| `send_failed` | A `send` that threw after auto-retry gave up. | Every throw. |
| `classifier_down` | `ClassifyResult.error` not null. | 3 consecutive. |
| `cycle_failed` | A throw caught at the cycle boundary. The loop continues; `/health` goes stale. | Every cycle that throws. |

There is no recovery message. Quiet is the recovery signal. There are no per-condition intervals.
