# WALIA

WALIA polls LinkedIn's public (logged-out) job search for new internship postings that match saved searches, runs each posting through an LLM eligibility check, dedupes it against a persistent store, and posts each new match to a Telegram group of master's students. The name predates the switch from WhatsApp to Telegram; delivery sits behind a notifier interface so a WhatsApp adapter can be added later.

## Codebase

Source lives in src/, one directory per component (`src/core`, `src/scraper`, `src/classifier`, `src/notifier`, `src/ops`), with `src/config.ts`, `src/log.ts`, and `src/index.ts` at the top. Unit tests are colocated as `src/**/*.test.ts`; captured LinkedIn responses go in test/fixtures/ and are read through test/helpers/fixture.ts. Documentation lives in docs/, split by component:

- docs/scraper/ - LinkedIn fetching and parsing
- docs/classifier/ - LLM eligibility check via OpenRouter
- docs/notifier/ - Telegram delivery, message formatting, admin alerts
- docs/core/ - polling loop, store, dedupe, config
- docs/operations/ - running, deploying to Railway, alerting

Stack: single TypeScript process on Node 24 run directly with Node's type stripping (no tsx, no enums, no namespaces, no parameter properties; relative imports use `.ts` specifiers), SQLite via the built-in `node:sqlite`, grammY for Telegram, OpenRouter for the classifier, zod for validation, pino for logging, hosted on Railway with one volume.

## Exploration Workflow

When starting a task, read docs/<component>/README.md for the relevant component first. Its doc map points to the specific docs, and those docs point to the code files. Do this before opening any code.

Keep the docs current. Do not end a session with changes and stale docs. Docs describe the current state only, never history or specific issues/PRs. Cut anything redundant with another layer of the chain.

## Commands

pnpm 10 (`npm i -g pnpm`, then `pnpm install`).

- `pnpm dev` runs `src/index.ts` under `node --watch` with `.env` loaded if present, piped through pino-pretty. Point `TELEGRAM_GROUP_CHAT_ID` in `.env` at a private test group first; `CONFIG_PATH` selects an alternate config.json.
- `pnpm scrape [--search <label>] [--pages <n>] [--recency <sec>] [--save-fixtures] [--save-eval]` runs one real search against LinkedIn and prints every request and job. With `--save-fixtures` it refreshes test/fixtures/; with `--save-eval` it writes unlabelled classifier eval files to test/eval/eligibility/. See docs/scraper/fixtures.md and docs/classifier/eval.md.
- `pnpm notify:test` sends one sample notification to the group and one line to the admin chat over real Telegram. Point `TELEGRAM_GROUP_CHAT_ID` at a private test group first.
- `pnpm eval:classifier` runs the labelled files in test/eval/eligibility/ through the classifier against real OpenRouter and exits 1 on any false `no` or call error. Costs money; not in CI. See docs/classifier/eval.md.
- `pnpm test` runs vitest once. `pnpm lint` runs Biome check. `pnpm format` writes Biome formatting. `pnpm typecheck` runs tsc over src and test.
- `pnpm build` emits dist/ from tsconfig.build.json (tests excluded). `pnpm start` runs dist/index.js.
- `docker build -t walia .` then `docker run --env-file .env walia` mirrors the Railway deploy.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and a Docker build on every push and pull request. No git hooks.

Use the GitHub CLI (`gh`) for all GitHub-related tasks. Work is tracked as GitHub issues, one per component, each grilled into a ticket before implementation.

## Glossary

- **cycle**: one run of the poll loop across all configured searches, on a fixed interval (default 5 min).
- **search**: one LinkedIn job search URL from config.json, parsed into guest endpoint params.
- **guest endpoint**: LinkedIn's logged-out `jobs-guest` API. No login, no cookies.
- **card**: one `<li>` in a search response. Yields id, title, company, location, posted date.
- **detail**: the job view page fetched per new id for the full description (JSON-LD).
- **dedupe key**: `normalise(company) + "|" + normalise(title)`, location excluded, so per-city clones of one role collapse.
- **notification**: one message per dedupe key, with each location linked to its own posting and an optional tag line.
- **stale**: `skip` reason for a job whose detail timestamp is older than `recencySec`. Stored as seen, never sent.
- **gone**: `skip` reason for a job whose detail fetch returned 404 or 410. Stored as seen, never sent.
- **deferred**: an unseen id that got no detail fetch because the cycle budget ran out. Counted, not queued; it is found again next cycle.
- **soft filter**: classifier verdict `degree_ok = no` suppresses a job; `unclear` sends it with a tag; missing description sends it untagged.
- **verdict**: the classifier's answer for one group: `degreeOk`, `workAuth`, and a one-sentence `reason`. `null` on a row means never classified; `unclear` means the model could not tell or the call failed.
- **notifier**: the delivery interface (start, isReady, send, sendAdmin, stop). Telegram is the first adapter.
