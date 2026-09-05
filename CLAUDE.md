# WALIA

WALIA polls LinkedIn's public (logged-out) job search for new internship postings that match saved searches, runs each posting through an LLM eligibility check, dedupes it against a persistent store, and posts a digest of new matches to a Telegram group of master's students. The name predates the switch from WhatsApp to Telegram; delivery sits behind a notifier interface so a WhatsApp adapter can be added later.

## Codebase

No source tree exists yet. All documentation lives in docs/, split by component:

- docs/scraper/ - LinkedIn fetching and parsing
- docs/classifier/ - LLM eligibility check via OpenRouter
- docs/notifier/ - Telegram delivery, digest formatting, admin alerts
- docs/core/ - polling loop, store, dedupe, config
- docs/operations/ - running, deploying to Railway, alerting

Planned stack: single TypeScript process on Node 22, SQLite via better-sqlite3, grammY for Telegram, OpenRouter for the classifier, hosted on Railway with one volume. `linkedin-guest-scraper-handoff.md` is the reference for LinkedIn endpoints, parsing targets, and throttling until docs/scraper/ replaces it.

## Exploration Workflow

When starting a task, read docs/<component>/README.md for the relevant component first. Its doc map points to the specific docs, and those docs point to the code files. Do this before opening any code.

Keep the docs current. Do not end a session with changes and stale docs. Docs describe the current state only, never history or specific issues/PRs. Cut anything redundant with another layer of the chain.

## Commands

No code yet. Planned tooling is pnpm, tsx for dev, tsc for build, vitest for tests, Biome for lint and format. Fill in the exact commands when the scaffold lands.

Use the GitHub CLI (`gh`) for all GitHub-related tasks. Work is tracked as GitHub issues, one per component, each grilled into a ticket before implementation.

## Glossary

- **cycle**: one run of the poll loop across all configured searches, on a fixed interval (default 5 min).
- **search**: one LinkedIn job search URL from config.json, parsed into guest endpoint params.
- **guest endpoint**: LinkedIn's logged-out `jobs-guest` API. No login, no cookies.
- **card**: one `<li>` in a search response. Yields id, title, company, location, posted date.
- **detail**: the job view page fetched per new id for the full description (JSON-LD).
- **dedupe key**: `normalise(company) + "|" + normalise(title)`, location excluded, so per-city clones of one role collapse.
- **digest**: the single message sent per cycle, one line per dedupe key with locations grouped.
- **soft filter**: classifier verdict `degree_ok = no` suppresses a job; `unclear` sends it with a tag; missing description sends it untagged.
- **notifier**: the delivery interface (start, isReady, sendDigest, sendAdmin). Telegram is the first adapter.
