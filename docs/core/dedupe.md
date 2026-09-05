# Dedupe

Code: `src/core/dedupe.ts`. Pure functions, no store. The loop decides which groups pass the window and the classifier verdicts.

```ts
normalise(s): string
dedupeKey(job): string          // normalise(company) + "|" + normalise(title)
groupByKey(jobs): Group[]

interface Group { key: string; title: string; company: string; locations: string[]; jobs: Job[] }
```

## normalise

Lowercase, replace every run of characters that are not letters or digits (`/[^\p{L}\p{N}]+/gu`) with one space, trim. The same function is used for title and company. Nothing else: no season or year removal, no token sorting, no location awareness, no corporate-suffix list, so "Stripe, Inc." and "Stripe" stay different companies. Missing a job costs far more than a duplicate line. Tighten only if real digests show a dupe problem.

## Key

`normalise(company) + "|" + normalise(title)`. Location is left out so per-city clones of one role collapse into one line. Baseline from `test/fixtures/search-page0.html`:

| Raw title | Company | Locations | Collapses |
| --- | --- | --- | --- |
| 2027 Summer Intern: Software Engineer | Spectrum | Greenwood Village, CO / Englewood, CO | yes, one line |
| AI Engineering Intern (Summer 2027) | Bain & Company | Buffalo-Niagara Falls Area / San Francisco, CA | yes, one line |
| Software Engineer Intern (Summer 2027 - Austin) | Optiver | Austin, TX | no, city is in the title |
| Software Engineer Intern (Summer 2027 - Chicago) | Optiver | Chicago, IL | no |

## Grouping

`groupByKey` returns one `Group` per key. Groups keep first-appearance order, and so do locations within a group. Locations are deduped by exact string. `title` and `company` come from the first job in the group, which is the newest since the scraper returns newest first.

## Window

A key is covered when any `notifications` row for it has `created_at` within `dedupe.windowDays`, whether or not the row has been sent. The store answers this through `keyNotifiedSince(key, now - windowDays)`. Three edge cases, all decided:

- A pending unsent row covers the key. The new id is not appended to it, so the extra city is lost from the digest. That is what "per-city clones collapse" means.
- The window is measured from `created_at`, never `sent_at`.
- A job the classifier suppressed (`degree_ok = no`) creates no row, so it never blocks a later clone of the same key.
