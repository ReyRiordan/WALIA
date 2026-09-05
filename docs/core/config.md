# Configuration

Code: `src/config.ts` (schemas, URL parsing, loaders), `src/log.ts` (logger), `src/index.ts` (boot).

Two inputs, both validated with zod before anything else runs. Any failure logs one error line listing every issue with its path, then exits 1. There is no partial boot.

## config.json

Pure JSON, no env interpolation. `CONFIG_PATH` selects an alternate file for dev runs, such as one with fewer searches. The Telegram chat ids are env, not config, so a private test group is a matter of `.env`. `searches`, `classifier.model`, `classifier.program`, and `classifier.graduation` are required; the rest default.

| Field | Default | Notes |
| --- | --- | --- |
| `searches[].url` | required | A LinkedIn job search URL pasted from the browser. Parsed as below. |
| `searches[].label` | keywords string | Shown in logs. |
| `pollIntervalSec` | 300 | Floor of 60. |
| `recencySec` | 3600 | Steady-state `f_TPR` window. |
| `firstCycleRecencySec` | 600 | `f_TPR` window on the first cycle after boot. |
| `maxPages` | 5 | Search pages fetched per search per cycle. |
| `classifier.model` | required | OpenRouter model id. No default because it sets the cost. |
| `classifier.program` | required | Who the students are, in prose. Goes into the prompt verbatim. See docs/classifier/prompt.md. |
| `classifier.graduation` | required | Expected graduation, e.g. `"May 2028"`. Goes into the prompt verbatim. |
| `classifier.reasoningEffort` | `"low"` | OpenRouter `reasoning.effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. See docs/classifier/client.md. |
| `dedupe.windowDays` | 14 | |
| `notifier` | `"telegram"` | Enum with the one value. |

All integers must be positive. Recency belongs to config, not the URL. The scraper sets `f_TPR=r<n>` per request from `recencySec` or `firstCycleRecencySec`.

## Search URL parsing

Each `searches[].url` becomes a `Search`: `{ label, keywords, params }`.

- Host must be `www.linkedin.com`. Path must be `/jobs/search/` or `/jobs/search-results/`; both mean the same thing.
- `keywords` is required and is lifted out of the query string.
- Dropped: `origin`, `trk`, `currentJobId`, `referralSearchId`, `position`, `pageNum`, `start`, `f_TPR`.
- `sortBy` is forced to `DD`.
- Every other param (`geoId`, `location`, `f_E`, `f_JT`, `f_WT`, ...) passes through into `params` unchanged. The loader does not know what they mean and injects no default `geoId`.
- An `f_TPR` in the URL that differs from `recencySec` logs a warning at boot and is ignored.

## Environment

Loaded from the process env. `pnpm dev` passes `--env-file-if-exists=.env`; Railway injects its own. `.env.example` lists every variable.

| Variable | Default | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | Redacted in logs. |
| `TELEGRAM_GROUP_CHAT_ID` | required | Kept as a string. |
| `TELEGRAM_ADMIN_CHAT_ID` | required | Kept as a string. |
| `OPENROUTER_API_KEY` | required | Redacted in logs. |
| `DATA_DIR` | `./data` | SQLite lives here. |
| `CONFIG_PATH` | `./config.json` | |
| `LOG_LEVEL` | `info` | pino level. |
| `PORT` | `3000` | Health endpoint. Railway sets it. |
| `PROXY_URL` | none | Must be a valid URL when set. Applies to LinkedIn requests only, via undici `ProxyAgent`. See docs/scraper/client.md. |

## Logging

`src/log.ts` exports the pino root logger. JSON to stdout, level from `LOG_LEVEL`. The bot token and OpenRouter key are redacted by path, so a logged env or config object never contains them. The dev script pipes output through pino-pretty.
