# Detail

Code: `src/scraper/detail.ts`.

```ts
fetchDetail(client, card, { recencySec, searchLabel, now }): Promise<Job>
parseJobPostingJsonLd(html): DetailFields | null
parseDetailFragment(html, now?): DetailFields | null
parseRelativeTime(label): number | null
htmlToText(html): string
```

`fetchDetail` GETs `https://www.linkedin.com/jobs/view/{id}` and tries the sources below in order, stopping at the first that returns fields. Card fields fill any gap; `description` is `null` when no source had one.

## Sources

**JSON-LD** (`parseJobPostingJsonLd`). Every `script[type="application/ld+json"]` is parsed, unparsable ones skipped, and the first object with `@type: "JobPosting"` wins, including inside a `@graph` array.

| Field | Path |
| --- | --- |
| `title` | `title` |
| `company` | `hiringOrganization.name` |
| `location` | first `jobLocation`, `address.addressLocality`, `addressRegion`, `addressCountry` joined with `", "`, blanks skipped |
| `description` | `description` through `htmlToText` |
| `postedAt` | `datePosted` |

The guest view page currently ships no JSON-LD at all. The parser stays first in line because it is the cheapest and most stable source whenever it does appear.

**Top-card markup** (`parseDetailFragment`). The view page and the guest fragment at `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}` share this markup, so it is parsed from the view page body first and the fragment is only requested when the view page has neither source. Returns `null` when the description container is absent.

| Field | Selector |
| --- | --- |
| `title` | `h1.top-card-layout__title` (view page) or `h2.top-card-layout__title` (fragment) |
| `company` | `a.topcard__org-name-link` |
| `location` | first `span.topcard__flavor--bullet` |
| `description` | `div.show-more-less-html__markup` through `htmlToText` |
| `postedAt` | `span.posted-time-ago__text`, "57 minutes ago" resolved against `now` |

`parseRelativeTime` accepts `N second|minute|hour|day|week|month(s) ago` and "just now"; anything else is `null` and leaves `postedAt` unset.

## htmlToText

Loads the markup with cheerio, replaces `br` with a newline, ends every `li` with one, wraps block elements (`p`, `div`, `ul`, `ol`, headings, `tr`) in newlines, takes the text, then collapses three or more newlines to two and trims. Entities decode as a side effect of `.text()`.

## Skip reasons

`postedAt` is the detail timestamp, else the card date at midnight UTC, else `null`. Only the detail timestamp decides recency: when it is older than `now - recencySec`, the job gets `skip: "stale"`. The card date is day-granular and already acted as the pre-filter, so a job with no detail time is sent rather than skipped.

A `NotFoundError` (404 or 410) from either request returns the card fields with `description: null` and `skip: "gone"`, without trying the fragment. Every other `ScrapeError` propagates to `scrapeSearch`.

The loop stores both `stale` and `gone` jobs as seen and never sends them. Each then costs one detail request ever instead of one per cycle.
