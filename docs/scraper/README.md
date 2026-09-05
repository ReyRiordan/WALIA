# scraper

Fetching job postings from LinkedIn's logged-out guest endpoints: the throttled HTTP client, the backoff policy, the search card parser, and the job detail (JSON-LD) parser. Guest endpoints only, no login, cookies, or browser automation. Everything is under `src/scraper/`, re-exported from `src/scraper/index.ts`; shared types (`Card`, `Job`, `ScrapeResult`) are in `src/scraper/types.ts`.

For the endpoints themselves and the parsing targets, `linkedin-guest-scraper-handoff.md` at the repo root is still the reference until the parser docs replace it.

## Docs

- [client.md](client.md) - `LinkedInClient`: headers, request spacing, per-cycle budget, proxy, timeout, status mapping, error classes, and the pause contract with the loop.
- [backoff.md](backoff.md) - the rate limit ladder and block pause, and why the state is in memory only.
