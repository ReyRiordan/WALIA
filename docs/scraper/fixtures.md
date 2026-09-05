# Fixtures and the scrape script

Code: `scripts/scrape.ts`, `test/helpers/fixture.ts`. Fixtures live in `test/fixtures/`.

## pnpm scrape

```
pnpm scrape [--search <label>] [--pages <n>] [--recency <sec>] [--save-fixtures] [--save-eval]
```

Runs one real `scrapeSearch` with `isSeen: () => false` against the first configured search, or the one whose label matches `--search`. It loads `.env` and `CONFIG_PATH` the same way the app does and honours `PROXY_URL`. `--pages` defaults to 1 and `--recency` to `recencySec` from config. Output goes through pino-pretty: one line per request with status, elapsed time, and count, then one line per job with id, title, company, location, `postedAt`, `skip`, and description length, then a summary with `deferred` and `halted`.

`--save-fixtures` tees the raw bodies of specific requests into `test/fixtures/` under stable names. After the scrape it resets the budget and makes two extra requests: the fragment for the first card, captured even when the view page already had everything, and a search page at `start=990`, which is the highest offset LinkedIn answers with an empty 200 rather than a 400.

`--save-eval` writes every scraped job with a description as an unlabelled classifier eval file under `test/eval/eligibility/`, never overwriting. See docs/classifier/eval.md.

## Files

| File | Source |
| --- | --- |
| `search-page0.html` | search page at `start=0` |
| `search-empty.html` | search page at `start=990` |
| `job-view.html` | `/jobs/view/{id}` for the first card on page 0 |
| `job-fragment.html` | `jobs-guest/jobs/api/jobPosting/{id}` for the same card |
| `search-markup-changed.html` | hand-edited copy of `search-page0.html` |

Fixtures are raw. Guest responses carry no personal data, and the tracking tokens in hrefs are noise. Biome ignores the directory.

`search-markup-changed.html` is committed once and never refreshed. It was made by renaming the `base-card`, `base-search-card`, and `job-search-card` class prefixes and rewriting the `/jobs/view/` hrefs so no id matches. It proves `parseCards` returns `[]` without throwing when LinkedIn changes the markup.

## When to refresh

Run `pnpm scrape --save-fixtures --recency 86400` when a fixture test fails or the parser-broken alert fires, then run `pnpm test` on the fresh capture. The one-day window matters: the card test expects a full page of ten, and a one-hour window can hold fewer. Do not refresh on a schedule.
