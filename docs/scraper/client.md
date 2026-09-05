# LinkedIn guest client

Code: `src/scraper/http.ts` (client), `src/scraper/errors.ts` (error classes).

`LinkedInClient` is the only thing that talks to LinkedIn. One instance per process, built in the entry point and passed to `scrapeSearch`. Every collaborator is injected so tests run with a fake clock and no real sleeps.

```ts
new LinkedInClient({ fetch?, sleep?, now?, proxyUrl?, log? })
client.beginCycle()       // resets the request count; the loop calls it once per cycle
client.remaining()        // requests left this cycle
client.pausedUntil()      // Date while backoff is active, else null
await client.get(url)     // body text, or a ScrapeError subclass
```

## Requests

- Headers are a pinned desktop Chrome `User-Agent` and `Accept-Language: en-US,en;q=0.9`. No cookies.
- Redirects are followed. `/jobs/view/{id}` legitimately 301s to a slugged URL, so the final `response.url` is inspected afterwards instead. A path starting with `/authwall` or `/login` is a block.
- Each request aborts after `REQUEST_TIMEOUT_MS` (15 s).
- When `proxyUrl` is set, one undici `ProxyAgent` is built in the constructor and passed as `dispatcher` on every fetch. Nothing else in the process is proxied.
- Every request logs `{ url, status, elapsedMs, count }` at info on the `scraper` child logger. A failed fetch logs `status: null` and the error.

## Spacing and budget

`get` calls are serialised through a promise chain, so two callers never interleave. Before each request the client sleeps until the gap since the previous request is a random value in `[MIN_GAP_MS, MAX_GAP_MS]` (2 to 5 s). The gap spans searches and cycles. A gap that has already passed is not slept again.

`MAX_REQUESTS_PER_CYCLE` (15) is a constant, not config. The count spans every search in the cycle, spent in config order with no per-search reservation. Retries count. Once it hits zero, `get` throws `BudgetExhaustedError` without fetching. Ids left unfetched are not queued anywhere; they turn up again next cycle because they are not in the store.

## Status mapping

| Response | Backoff | Result |
| --- | --- | --- |
| 200 | `ok` | body text |
| 200, final URL on `/authwall` or `/login` | `blocked` | `BlockedError` |
| 429 | `rate_limited` | `RateLimitError` |
| 999 | `blocked` | `BlockedError` |
| 404, 410 | unchanged | `NotFoundError` |
| 5xx, network error, timeout | unchanged | sleep `TRANSIENT_RETRY_DELAY_MS` (30 s), retry once; second failure is `TransientError` |
| anything else | unchanged | `TransientError`, no retry |

The retry needs budget too. With none left it throws `BudgetExhaustedError`.

## Errors

All subclasses of `ScrapeError` with `signal`, `url`, and optional `status`. Callers branch on class or `signal`; raw status codes never leave the client.

| Class | `signal` |
| --- | --- |
| `RateLimitError` | `rate_limited` |
| `BlockedError` | `blocked` |
| `TransientError` | `transient` |
| `NotFoundError` | `not_found` |
| `BudgetExhaustedError` | `budget` |

## Pause contract

After a 429 or a block the client holds `pausedUntil` (see [backoff.md](backoff.md)). While it is in the future, `get` throws `RateLimitError` or `BlockedError` matching the last signal, logs a warning, and makes no request. The loop reads `client.pausedUntil()` after each cycle and schedules the next one at the later of the poll interval and that time.
