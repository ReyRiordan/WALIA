import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../test/helpers/fixture.ts";
import {
  fetchDetail,
  htmlToText,
  JOB_FRAGMENT_URL,
  JOB_VIEW_URL,
  parseDetailFragment,
  parseJobPostingJsonLd,
  parseRelativeTime,
} from "./detail.ts";
import { NotFoundError, RateLimitError } from "./errors.ts";
import type { Card } from "./types.ts";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const HOUR = 3_600_000;

const card: Card = {
  id: "4463709485",
  title: "Card title",
  company: "Card Co",
  location: "Card City, XX",
  postedOn: "2026-09-05",
  href: "https://www.linkedin.com/jobs/view/card-title-at-card-co-4463709485?trk=x",
};

const posting = {
  "@type": "JobPosting",
  title: "SWE Intern",
  datePosted: "2026-09-05T11:30:00.000Z",
  description: "<p>Build things &amp; ship them.</p><ul><li>One</li><li>Two</li></ul>",
  hiringOrganization: { "@type": "Organization", name: "Acme" },
  jobLocation: [
    {
      "@type": "Place",
      address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" },
    },
  ],
};

function jsonLdPage(data: Record<string, unknown>, wrap?: "graph"): string {
  const body = wrap === "graph" ? { "@graph": [{ "@type": "Thing" }, data] } : data;
  return `<html><head>
<script type="application/ld+json">not json</script>
<script type="application/ld+json">${JSON.stringify(body)}</script>
</head><body></body></html>`;
}

/** A fake client whose replies are keyed by URL. Anything unscripted throws. */
function fakeClient(replies: Record<string, string | Error>) {
  const get = vi.fn(async (url: string) => {
    const reply = replies[url];
    if (reply === undefined) throw new Error(`unscripted url ${url}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { get };
}

const viewUrl = `${JOB_VIEW_URL}${card.id}`;
const fragmentUrl = `${JOB_FRAGMENT_URL}${card.id}`;
const opts = { recencySec: 3600, searchLabel: "test", now: () => NOW };

describe("htmlToText", () => {
  it("turns br, p, and li into newlines and decodes entities", () => {
    const text = htmlToText(
      "<p>Hello &amp; <strong>welcome</strong></p>Line one<br>Line two<ul><li>A</li><li>B</li></ul>",
    );
    expect(text).toBe("Hello & welcome\nLine one\nLine two\nA\nB");
  });

  it("separates paragraphs with a blank line", () => {
    expect(htmlToText("<p>a</p><p>b</p><ul><li>c</li></ul>")).toBe("a\n\nb\n\nc");
  });

  it("collapses runs of blank lines to one", () => {
    expect(htmlToText("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
  });

  it("returns an empty string for markup with no text", () => {
    expect(htmlToText("<div><span></span></div>")).toBe("");
  });
});

describe("parseRelativeTime", () => {
  it.each([
    ["57 minutes ago", 57 * 60_000],
    ["1 hour ago", HOUR],
    ["3 days ago", 3 * 24 * HOUR],
    ["  2 weeks ago ", 14 * 24 * HOUR],
    ["Just now", 0],
  ])("%s", (label, ms) => {
    expect(parseRelativeTime(label)).toBe(ms);
  });

  it("returns null for anything else", () => {
    expect(parseRelativeTime("")).toBeNull();
    expect(parseRelativeTime("Posted yesterday")).toBeNull();
  });
});

describe("parseJobPostingJsonLd", () => {
  it("reads title, company, joined location, plain-text description, and a Date", () => {
    expect(parseJobPostingJsonLd(jsonLdPage(posting))).toEqual({
      title: "SWE Intern",
      company: "Acme",
      location: "Austin, TX, US",
      description: "Build things & ship them.\n\nOne\nTwo",
      postedAt: new Date("2026-09-05T11:30:00.000Z"),
    });
  });

  it("finds the posting inside @graph and skips unparsable scripts", () => {
    expect(parseJobPostingJsonLd(jsonLdPage(posting, "graph"))?.title).toBe("SWE Intern");
  });

  it("returns null when no script carries a JobPosting", () => {
    const other = '<script type="application/ld+json">{"@type":"WebPage"}</script>';
    expect(parseJobPostingJsonLd(other)).toBeNull();
    expect(parseJobPostingJsonLd("<html></html>")).toBeNull();
  });

  it("yields description null when the posting has none", () => {
    const { description: _, ...rest } = posting;
    expect(parseJobPostingJsonLd(jsonLdPage(rest))?.description).toBeNull();
  });
});

describe("parseDetailFragment", () => {
  it("reads the guest fragment fixture", () => {
    const fields = parseDetailFragment(fixture("job-fragment.html"), NOW);
    expect(fields?.title).toMatch(/\S/);
    expect(fields?.company).toMatch(/\S/);
    expect(fields?.location).toMatch(/\S/);
    expect(fields?.description).toMatch(/\S/);
    expect(fields?.description).not.toMatch(/<[a-z]+|&[a-z]+;/i);
    expect(fields?.postedAt).toBeInstanceOf(Date);
    expect(fields?.postedAt?.getTime()).toBeLessThanOrEqual(NOW);
  });

  it("reads the same top-card markup from the view page fixture", () => {
    const view = parseDetailFragment(fixture("job-view.html"), NOW);
    const fragment = parseDetailFragment(fixture("job-fragment.html"), NOW);
    expect(view).toEqual(fragment);
  });

  it("returns null when the description container is absent", () => {
    expect(parseDetailFragment('<h2 class="top-card-layout__title">x</h2>')).toBeNull();
  });

  it("leaves postedAt undefined when there is no relative time", () => {
    const fields = parseDetailFragment('<div class="show-more-less-html__markup">Body</div>');
    expect(fields).toEqual({
      title: undefined,
      company: undefined,
      location: undefined,
      description: "Body",
      postedAt: undefined,
    });
  });
});

describe("fetchDetail", () => {
  it("uses JSON-LD from the view page and makes one request", async () => {
    const client = fakeClient({ [viewUrl]: jsonLdPage(posting) });
    const job = await fetchDetail(client, card, opts);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(job).toEqual({
      id: card.id,
      title: "SWE Intern",
      company: "Acme",
      location: "Austin, TX, US",
      description: "Build things & ship them.\n\nOne\nTwo",
      url: viewUrl,
      postedAt: new Date("2026-09-05T11:30:00.000Z"),
      searchLabel: "test",
    });
  });

  it("parses the captured view page without a second request", async () => {
    const client = fakeClient({ [viewUrl]: fixture("job-view.html") });
    const job = await fetchDetail(client, card, opts);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(job.description).toMatch(/\S/);
    expect(job.title).not.toBe(card.title);
    expect(job.postedAt).toBeInstanceOf(Date);
  });

  it("falls through to the fragment endpoint when the view page has neither source", async () => {
    const client = fakeClient({
      [viewUrl]: "<html><body>app shell</body></html>",
      [fragmentUrl]: fixture("job-fragment.html"),
    });
    const job = await fetchDetail(client, card, opts);
    expect(client.get.mock.calls.map((c) => c[0])).toEqual([viewUrl, fragmentUrl]);
    expect(job.description).toMatch(/\S/);
  });

  it("keeps card fields and description null when both sources are empty", async () => {
    const client = fakeClient({ [viewUrl]: "<html></html>", [fragmentUrl]: "<div></div>" });
    const job = await fetchDetail(client, card, opts);
    expect(job).toEqual({
      id: card.id,
      title: card.title,
      company: card.company,
      location: card.location,
      description: null,
      url: viewUrl,
      postedAt: new Date("2026-09-05T00:00:00.000Z"),
      searchLabel: "test",
    });
  });

  it("does not judge recency from the card date alone", async () => {
    const stale = { ...card, postedOn: "2026-08-01" };
    const client = fakeClient({ [viewUrl]: "<html></html>", [fragmentUrl]: "<div></div>" });
    const job = await fetchDetail(client, stale, opts);
    expect(job.postedAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(job.skip).toBeUndefined();
  });

  it("marks a posting older than the window as stale", async () => {
    const old = { ...posting, datePosted: new Date(NOW - 2 * HOUR).toISOString() };
    const client = fakeClient({ [viewUrl]: jsonLdPage(old) });
    expect((await fetchDetail(client, card, opts)).skip).toBe("stale");
    const fresh = { ...posting, datePosted: new Date(NOW - HOUR / 2).toISOString() };
    const client2 = fakeClient({ [viewUrl]: jsonLdPage(fresh) });
    expect((await fetchDetail(client2, card, opts)).skip).toBeUndefined();
  });

  it("marks a 404 on the view page as gone without a second request", async () => {
    const client = fakeClient({ [viewUrl]: new NotFoundError(viewUrl, 404) });
    const job = await fetchDetail(client, card, opts);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({
      title: card.title,
      description: null,
      postedAt: new Date("2026-09-05T00:00:00.000Z"),
      skip: "gone",
    });
  });

  it("marks a 404 on the fragment as gone", async () => {
    const client = fakeClient({
      [viewUrl]: "<html></html>",
      [fragmentUrl]: new NotFoundError(fragmentUrl, 410),
    });
    expect((await fetchDetail(client, card, opts)).skip).toBe("gone");
  });

  it("propagates other scrape errors", async () => {
    const client = fakeClient({ [viewUrl]: new RateLimitError(viewUrl, 429) });
    await expect(fetchDetail(client, card, opts)).rejects.toBeInstanceOf(RateLimitError);
  });
});
