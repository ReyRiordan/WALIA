# Running locally

Code: `src/index.ts`. Scripts in `package.json`.

## Setup

1. `pnpm install`.
2. Copy `.env.example` to `.env`. Point `TELEGRAM_GROUP_CHAT_ID` at a private test group and `TELEGRAM_ADMIN_CHAT_ID` at your own chat with the bot. The bot never polls Telegram, so a dev instance and the Railway instance can share one token without conflict; only the chat ids keep dev messages out of the real group.
3. Optionally `CONFIG_PATH=./config.dev.json` for a config with fewer searches. `DATA_DIR` defaults to the gitignored `./data`, so the dev store is separate from anything deployed.

There is no dry-run flag and no console notifier. A dev run is a real run against LinkedIn and a real Telegram group; the env is what makes it safe.

## `pnpm dev`

Runs `src/index.ts` under `node --watch` with `.env` loaded, piped through pino-pretty. Boot order: config, store, LinkedIn client, classifier, `notifier.start()` (a bad token exits 1), health server on `PORT`, then the first cycle.

`--watch` restarts on every save, and every restart fires a first cycle against LinkedIn with `firstCycleRecencySec`. Stop the watcher while editing, or you will spend a request budget per keystroke. `pnpm start` after `pnpm build` runs the compiled `dist/` without the watcher.

## Stopping

Ctrl-C (SIGINT) or SIGTERM sets the stop flag, clears the pending cycle timer, and waits for the running cycle to return at its next step boundary (after a search, before a classify, before a send). Then the health server closes, the notifier stops, the store closes, and the process exits 0. If that takes longer than 10 s the process exits 1. A second signal exits 1 immediately. Exiting mid-cycle is safe: a notification row that was created but not marked sent is retried on the next boot, at worst as a duplicate message.

## Reading the log

Every line has a `component`: `loop`, `scraper`, `classifier`, `notifier`, `alerts`, `health`.

| Line | Meaning |
| --- | --- |
| `config loaded` | Boot. Lists searches, intervals, model, `graduation`, `term`, `fields`, `dataDir`, `port`. |
| `telegram bot ready` | `getMe` passed. |
| `health server listening` | `/health` is up. Railway's healthcheck passes from here. |
| `cycle started` | With `recencySec` in use, 600 on the first cycle by default. |
| `linkedin request` | One per request: `url`, `status`, `elapsedMs`, `count` toward the 15 per cycle. |
| `search scraped` | Per search: `jobs`, `inserted`, `deferred`, `cardsOnFirstPage`, `halted`, `skipped`. |
| `search halted` | A transient scrape error ended the search early. |
| `request skipped, backoff pause active` | Rate limited or blocked; nothing fetched until `pausedUntil`. |
| `openrouter request` | One per classifier attempt, with tokens and the verdict. |
| `group suppressed` | With `field`: `relevant` or `degreeOk` came back `no`. |
| `no description in group; sending untagged` | No classifier call for this group. |
| `notification sent` | With `messageId`, and `retry: true` when the row came from an earlier cycle. |
| `send failed; row stays unsent` | Retried next cycle. |
| `notifier not ready; unsent rows wait for a later cycle` | The bot lost the group. |
| `alert throttled` | The same condition fired within the hour. |
| `cycle finished` | The `CycleSummary` (docs/core/loop.md). |
| `cycle failed` | A throw caught at the cycle boundary. The admin gets `[cycle_failed]`. |
| `next cycle scheduled` | `nextCycleAt` and `delaySec`, which exceeds the poll interval during a pause. |
| `shutting down` / `stopped` | The signal path above. |

`curl localhost:3000/health` shows the same state as JSON; see health.md.
