# scraper

Fetching job postings from LinkedIn's logged-out guest endpoints: the throttled HTTP client, the backoff policy, the search card parser, and the job detail parser. Guest endpoints only, no login, cookies, or browser automation. Everything is under `src/scraper/`, re-exported from `src/scraper/index.ts`; shared types (`Card`, `Job`, `ScrapeResult`) are in `src/scraper/types.ts`. The loop calls one function, `scrapeSearch`, per configured search.

## Docs

- [client.md](client.md) - `LinkedInClient`: headers, request spacing, per-cycle budget, proxy, timeout, status mapping, error classes, and the pause contract with the loop.
- [backoff.md](backoff.md) - the rate limit ladder and block pause, and why the state is in memory only.
- [search.md](search.md) - search URL to guest endpoint mapping, paging and stop rules, card parsing, the `ScrapeResult` contract, and what `deferred` means.
- [detail.md](detail.md) - the detail sources in precedence order, field paths and selectors, `htmlToText`, and the `stale` and `gone` skip reasons.
- [fixtures.md](fixtures.md) - `pnpm scrape`, the committed fixtures, and when to refresh them.

## Known limitations

- The guest index is not the logged-in AI search. Result sets overlap heavily but do not match exactly.
- `f_TPR` is approximate at the window edge. A posting slightly older than the window can still appear, which is why the detail timestamp is checked again.
- Region-locked and Easy Apply postings can render an empty description on the guest pages. They are stored with `description: null`, never dropped.
- Automated access is against LinkedIn's terms. At this volume, from public logged-out pages, the practical exposure is a temporary IP throttle rather than an account action, but it is not zero.
