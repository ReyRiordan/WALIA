# Handoff: LinkedIn Internship Poller (Guest-Endpoint Scraper)

Language/framework agnostic. Describes the endpoints, request shape, parsing targets, polling loop, and failure handling needed to implement "option 1" from the research phase.

---

## 1. Scope

**Inputs**
- `keywords` — boolean search string (quotes, parentheses, `OR`, `AND`, `NOT` are honoured by LinkedIn's guest search).
- `recency_seconds` — only postings from the last N seconds (LinkedIn's `f_TPR` filter).
- `geo` — optional; default United States (`geoId=103644278`).

**Outputs per job**
- `id` (LinkedIn numeric job ID — the dedupe key)
- `title`
- `company`
- `location`
- `description` (full text)
- `url` (`https://www.linkedin.com/jobs/view/{id}`)

Nothing else is required. Salary, applicant count, recruiter etc. are inconsistent on the guest surface and should be ignored.

---

## 2. URL → request mapping

The user-facing search URL:

```
https://www.linkedin.com/jobs/search/?keywords="summer%202027"%20(SWE%20OR%20"software%20engineer"%20OR%20"machine%20learning"%20OR%20AI)%20intern&geoId=103644278&f_TPR=r86400&sortBy=DD
```

maps 1:1 onto the logged-out "load more" endpoint by swapping the path and adding `start`:

```
GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
    ?keywords=<url-encoded boolean string>
    &geoId=103644278
    &f_TPR=r86400
    &sortBy=DD
    &start=0
```

| Param | Meaning | Notes |
|---|---|---|
| `keywords` | Search string | URL-encode the whole thing. `"` → `%22`, space → `%20` or `+`, `(`/`)` can stay literal or be encoded. Keep the boolean operators uppercase. |
| `geoId` | Location by LinkedIn geo ID | `103644278` = United States. Alternatively `location=United%20States` (free text) works; `geoId` is more precise. |
| `f_TPR` | Time posted | `r` + seconds. `r86400` = 24 h, `r3600` = 1 h, `r604800` = 7 d. Any integer works. |
| `sortBy` | `DD` = most recent first, `R` = relevance | Use `DD` so new jobs are always on page 1. |
| `start` | Pagination offset | 0, 10, 20, … (see §3). |

Parameters you do **not** need and should strip if present in a pasted URL: `origin`, `referralSearchId`, `currentJobId`, `trk`, `position`, `pageNum`.

**Note on the Aug‑2026 search overhaul:** the logged-in UI is now an "AI search" at `/jobs/search-results/` that only honours `f_TPR`, `f_C`, `f_AL`, `f_EA` as URL filters. The guest endpoint is a separate, older index; it ignores the AI ranking but still honours `keywords`, `geoId`, `f_TPR`, `sortBy`. Expect the guest result set to overlap heavily with, but not exactly match, what you see logged in. If a pasted link uses `/jobs/search-results/`, treat it identically — the query params are the same.

**Headers.** None are strictly required. Send a normal desktop browser `User-Agent` and `Accept-Language: en-US,en;q=0.9` anyway; it's free and avoids the trivial bot fingerprint. Do **not** send cookies.

---

## 3. Search response and pagination

- Response is an **HTML fragment** (not JSON): a list of `<li>` elements, one per job card.
- **Page size is 10.** Increment `start` by 10. (Older tutorials say 25; that is no longer true. A `count` parameter is silently ignored.)
- Stop paging when a response contains zero job cards, or when `start` reaches your cap. LinkedIn caps any search at ~1000 results; for a 24 h internship window you will typically need 1–5 pages.
- Because `sortBy=DD` puts newest first, an **early-stop optimisation** is valid: once a page contains only job IDs you've already seen, stop paging.

**Per-card extraction (search page).** Only the job ID is essential here; title/company/location are also present and cheap to grab as a fallback.

| Field | Where to find it (current markup; verify in DevTools before shipping) |
|---|---|
| `id` | `data-entity-urn="urn:li:jobPosting:<ID>"` on the card's top-level `div`, **or** the trailing digits of the `href` of `a.base-card__full-link` (`/jobs/view/<slug>-<ID>?...`). Use a regex on the href (`-(\d{6,})`) as the most robust extractor. |
| `title` | `h3.base-search-card__title` |
| `company` | `h4.base-search-card__subtitle` (contains an `<a>`) |
| `location` | `span.job-search-card__location` |
| posted time | `<time datetime="YYYY-MM-DD">` |

Treat selector names as volatile. Prefer extracting the ID from the URL pattern, which has been stable for years.

---

## 4. Job detail (full description)

Two logged-out sources for the same job. Use **A**, fall back to **B**.

**A. Job view page, JSON-LD (preferred — structured, stable)**

```
GET https://www.linkedin.com/jobs/view/{id}
```

Find `<script type="application/ld+json">` whose JSON has `"@type": "JobPosting"`. Fields:

| Output field | JSON-LD path |
|---|---|
| `title` | `title` |
| `company` | `hiringOrganization.name` |
| `location` | `jobLocation.address` → join `addressLocality`, `addressRegion`, `addressCountry` (may be an array; take the first) |
| `description` | `description` — **contains HTML**; strip tags / convert to text |
| posted | `datePosted` (ISO) |

**B. Guest detail fragment (fallback)**

```
GET https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}
```

Returns an HTML fragment. Description lives in `div.show-more-less-html__markup`; title in `h2.top-card-layout__title`; company in `a.topcard__org-name-link`; location in `span.topcard__flavor--bullet`.

**Detail fetch policy:** only fetch details for job IDs **not already in your store**. This is the single biggest lever on request volume.

---

## 5. Polling loop

```
every INTERVAL (recommend 5 min; range 1–10):
    page = 0
    new_ids = []
    loop:
        cards = GET search(start=page*10)
        if no cards: break
        ids_on_page = extract ids
        unseen = ids_on_page - store
        new_ids += unseen
        if unseen is empty: break          # newest-first ⇒ nothing older is new
        page += 1
        if page >= MAX_PAGES (e.g. 5): break
        sleep(jitter 2–5 s)

    for id in new_ids:
        detail = GET job view(id)  →  parse JSON-LD
        store.add(id, {title, company, location, description, url, first_seen=now})
        notify(...)
        sleep(jitter 2–5 s)
```

**Store:** any persistent key/value (SQLite, a JSON file, etc.) keyed by job ID. Keep it forever or prune after ~30 days; either way it must survive restarts, or every restart re-notifies the whole window.

**Repost handling (optional):** LinkedIn re-lists jobs with a new ID. If duplicate notifications become annoying, add a secondary dedupe on `normalise(title) + normalise(company)` within a 14‑day window.

**Recency sanity check:** `f_TPR` occasionally lets a stale item through. If the search card's `<time datetime>` or JSON-LD `datePosted` is older than `recency_seconds`, drop it.

---

## 6. Request budget & throttling (see accompanying research note)

- Space every request by **2–5 s with jitter**; never fire requests concurrently.
- Cap **≤ ~15 requests per cycle** (search pages + detail fetches). If a cycle needs more, defer the remainder to the next cycle.
- Cap **~150 requests/hour** overall from one IP; the poller should almost never approach this in steady state.
- On first run (cold store) the 24 h window may contain 50–150 jobs. Either accept a slow first cycle spread across many minutes, or seed the store from the search cards only (title/company/location) and back-fill descriptions gradually.

---

## 7. Response handling

| Status / signal | Meaning | Action |
|---|---|---|
| `200` with job cards | Normal | Parse |
| `200` with zero cards on page 0 | Search genuinely empty **or** markup changed | If it persists for several cycles while the same URL shows results in a browser, raise a "parser broken" alert |
| `429` | Rate limited | Stop the cycle. Back off: 2 min → 5 min → 15 min → 60 min, reset on success. Do **not** retry immediately. |
| `302`/`303` to `/authwall` or `/login` | LinkedIn has decided this IP is a bot | Treat as a hard block: pause polling for **≥ 1 hour**, then resume at reduced rate |
| `999` | Legacy LinkedIn bot-block code (rare now) | Same as authwall |
| `5xx` / timeout | Transient | Retry once after 30 s, otherwise skip the cycle |
| Detail page has no JSON-LD | Job removed, or markup changed | Try source B; if that also fails, store the card-level data and mark `description = null` |

Log the status code, elapsed time and result count of every request. Alert on any cycle with a 429/authwall, and on three consecutive cycles that return zero cards.

---

## 8. Deployment notes

- Run from a **residential** connection if possible (home machine, Raspberry Pi, always-on laptop). Datacenter IPs (AWS, GCP, Hetzner, DigitalOcean…) get throttled noticeably sooner on the guest endpoint.
- If you must use a cloud host and get blocked repeatedly, the cheapest fix is a single residential/mobile proxy rather than a rotating pool — the volume here doesn't justify rotation.
- No login, no cookies, no browser automation. Plain HTTP GETs are sufficient and are the lowest-fingerprint option.
- Keep the two parsers (search cards, JSON-LD) in isolated, easily replaceable functions; they are the only parts expected to break.

---

## 9. Known limitations

- Guest index ≠ logged-in AI search; result sets overlap but are not identical.
- `f_TPR` is approximate at the edges (a job "posted 25 hours ago" may still appear under `r86400`).
- Some postings are region-locked or "Easy Apply"-only and render an empty description on the guest surface; store `description = null` rather than failing.
- LinkedIn's ToS prohibits automated access. This is public, logged-out data at a hobby volume, so the practical exposure is a temporary IP throttle, not an account action — but it is not zero.
