import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../test/helpers/fixture.ts";
import type { Search } from "../config.ts";
import { JOB_VIEW_URL } from "./detail.ts";
import { BudgetExhaustedError, RateLimitError } from "./errors.ts";
import { buildSearchUrl, PAGE_SIZE, parseCards, SEARCH_URL, scrapeSearch } from "./search.ts";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const search: Search = {
  label: "test",
  keywords: '"summer 2027" (SWE OR AI) intern',
  params: { geoId: "103644278", sortBy: "DD", f_WT: "2" },
};

/** A minimal search page with the live card markup. */
function page(cards: { id: string; date?: string }[]): string {
  const items = cards
    .map(
      ({ id, date = "2026-09-05" }) => `<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/swe-intern-at-acme-${id}?position=1&amp;trackingId=abc"></a>
    <h3 class="base-search-card__title"> SWE Intern ${id} </h3>
    <h4 class="base-search-card__subtitle"><a href="#">Acme &amp; Co</a></h4>
    <span class="job-search-card__location">Austin, TX</span>
    <time class="job-search-card__listdate" datetime="${date}">1 hour ago</time>
  </div>
</li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>\n<ul>${items}</ul>`;
}

function viewPage(id: string): string {
  const posting = {
    "@type": "JobPosting",
    title: `Detail ${id}`,
    datePosted: new Date(NOW - 10 * 60_000).toISOString(),
    description: "<p>Desc</p>",
    hiringOrganization: { name: "Acme" },
  };
  return `<script type="application/ld+json">${JSON.stringify(posting)}</script>`;
}

/** Fake client: search pages by start offset, JSON-LD detail pages by id, errors by URL substring. */
function fakeClient(pages: string[], errors: Record<string, Error> = {}) {
  const get = vi.fn(async (url: string) => {
    for (const [needle, err] of Object.entries(errors)) if (url.includes(needle)) throw err;
    if (url.startsWith(SEARCH_URL)) {
      const start = Number(new URL(url).searchParams.get("start"));
      return pages[start / PAGE_SIZE] ?? page([]);
    }
    if (url.startsWith(JOB_VIEW_URL)) return viewPage(url.slice(JOB_VIEW_URL.length));
    throw new Error(`unscripted url ${url}`);
  });
  return { get };
}

type Fake = ReturnType<typeof fakeClient>;
const ids = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: String(1_000_000 + from + i) }));
const urls = (client: Fake) => client.get.mock.calls.map((c) => c[0]);
const searchCalls = (client: Fake) => urls(client).filter((u) => u.startsWith(SEARCH_URL)).length;
const detailCalls = (client: Fake) => urls(client).filter((u) => u.startsWith(JOB_VIEW_URL)).length;

const baseOpts = { recencySec: 3600, maxPages: 5, isSeen: () => false, now: () => NOW };

describe("buildSearchUrl", () => {
  it("maps a search onto the guest endpoint with recency and offset", () => {
    const url = new URL(buildSearchUrl(search, 3600, 20));
    expect(`${url.origin}${url.pathname}`).toBe(SEARCH_URL);
    expect(url.searchParams.get("keywords")).toBe(search.keywords);
    expect(url.searchParams.get("f_TPR")).toBe("r3600");
    expect(url.searchParams.get("start")).toBe("20");
    expect(url.searchParams.get("sortBy")).toBe("DD");
    expect(url.searchParams.get("geoId")).toBe("103644278");
    expect(url.searchParams.get("f_WT")).toBe("2");
  });
});

describe("parseCards", () => {
  it("parses ten cards from the captured page", () => {
    const cards = parseCards(fixture("search-page0.html"));
    expect(cards).toHaveLength(10);
    for (const card of cards) {
      expect(card.id).toMatch(/^\d{6,}$/);
      expect(card.title).toMatch(/\S/);
      expect(card.company).toMatch(/\S/);
      expect(card.location).toMatch(/\S/);
      expect(card.postedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(card.href).toContain("/jobs/view/");
    }
    expect(new Set(cards.map((c) => c.id)).size).toBe(10);
  });

  it("returns no cards for the empty page and the renamed markup", () => {
    expect(parseCards(fixture("search-empty.html"))).toEqual([]);
    expect(parseCards(fixture("search-markup-changed.html"))).toEqual([]);
  });

  it("never throws on junk input", () => {
    expect(parseCards("")).toEqual([]);
    expect(parseCards('<li><a href="/jobs/view/no-id-here">x</a></li>')).toEqual([]);
    expect(parseCards(" <<>>")).toEqual([]);
  });

  it("collapses whitespace and decodes entities in text fields", () => {
    const [card] = parseCards(page([{ id: "1234567" }]));
    expect(card).toEqual({
      id: "1234567",
      title: "SWE Intern 1234567",
      company: "Acme & Co",
      location: "Austin, TX",
      postedOn: "2026-09-05",
      href: expect.stringContaining("/jobs/view/swe-intern-at-acme-1234567"),
    });
  });

  it("leaves text fields empty when their elements are missing", () => {
    const [card] = parseCards('<li><a href="/jobs/view/x-1234567">x</a></li>');
    expect(card).toMatchObject({
      id: "1234567",
      title: "",
      company: "",
      location: "",
      postedOn: null,
    });
  });
});

describe("scrapeSearch", () => {
  it("fetches details for every unseen card and reports cardsOnFirstPage", async () => {
    const client = fakeClient([page(ids(3))]);
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.cardsOnFirstPage).toBe(3);
    expect(result.jobs.map((j) => j.title)).toEqual([
      "Detail 1000000",
      "Detail 1000001",
      "Detail 1000002",
    ]);
    expect(result.jobs[0]).toMatchObject({
      company: "Acme",
      searchLabel: "test",
      url: `${JOB_VIEW_URL}1000000`,
    });
    expect(result.deferred).toBe(0);
    expect(result.halted).toBeUndefined();
    expect(searchCalls(client)).toBe(1);
  });

  it("stops paging on an empty page", async () => {
    const client = fakeClient([page(ids(10)), page([])]);
    await scrapeSearch(client, search, baseOpts);
    expect(searchCalls(client)).toBe(2);
  });

  it("does not request another page after a short one", async () => {
    const client = fakeClient([page(ids(10)), page(ids(4, 10)), page(ids(10, 20))]);
    const result = await scrapeSearch(client, search, baseOpts);
    expect(searchCalls(client)).toBe(2);
    expect(result.jobs).toHaveLength(14);
  });

  it("stops paging when a page adds nothing unseen", async () => {
    const seen = new Set(ids(10, 10).map((c) => c.id));
    const client = fakeClient([page(ids(10)), page(ids(10, 10)), page(ids(10, 20))]);
    const result = await scrapeSearch(client, search, {
      ...baseOpts,
      isSeen: (id) => seen.has(id),
    });
    expect(searchCalls(client)).toBe(2);
    expect(result.jobs).toHaveLength(10);
  });

  it("stops at maxPages", async () => {
    const client = fakeClient([page(ids(10)), page(ids(10, 10)), page(ids(10, 20))]);
    const result = await scrapeSearch(client, search, { ...baseOpts, maxPages: 2 });
    expect(searchCalls(client)).toBe(2);
    expect(result.jobs).toHaveLength(20);
  });

  it("dedupes an id repeated across pages", async () => {
    const client = fakeClient([page(ids(10)), page(ids(10, 9))]);
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.jobs).toHaveLength(19);
    expect(detailCalls(client)).toBe(19);
  });

  it("drops cards dated more than a day before the window without fetching details", async () => {
    const client = fakeClient([
      page([
        { id: "1000000", date: "2026-09-05" },
        { id: "1000001", date: "2026-09-04" },
        { id: "1000002", date: "2026-09-03" },
        { id: "1000003", date: "not-a-date" },
      ]),
    ]);
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.jobs.map((j) => j.id)).toEqual(["1000000", "1000001", "1000003"]);
    expect(detailCalls(client)).toBe(3);
    expect(result.cardsOnFirstPage).toBe(4);
  });

  it("reports deferred without halted when the budget runs out mid-details", async () => {
    const url = `${JOB_VIEW_URL}1000002`;
    const client = fakeClient([page(ids(5))], { [url]: new BudgetExhaustedError(url) });
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.jobs).toHaveLength(2);
    expect(result.deferred).toBe(3);
    expect(result.halted).toBeUndefined();
  });

  it("returns jobs so far plus halted when a rate limit lands mid-details", async () => {
    const url = `${JOB_VIEW_URL}1000003`;
    const err = new RateLimitError(url, 429);
    const client = fakeClient([page(ids(5))], { [url]: err });
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.jobs).toHaveLength(3);
    expect(result.deferred).toBe(2);
    expect(result.halted).toBe(err);
  });

  it("halts on a search page error with the first page count intact", async () => {
    const err = new RateLimitError("x", 429);
    const client = fakeClient([page(ids(10))], { "start=10": err });
    const result = await scrapeSearch(client, search, baseOpts);
    expect(result.cardsOnFirstPage).toBe(10);
    expect(result.jobs).toEqual([]);
    expect(result.deferred).toBe(10);
    expect(result.halted).toBe(err);
  });

  it("rethrows non-scrape errors", async () => {
    const client = fakeClient([page(ids(1))], { "start=0": new TypeError("boom") });
    await expect(scrapeSearch(client, search, baseOpts)).rejects.toBeInstanceOf(TypeError);
  });
});
