import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../test/helpers/fixture.ts";
import type { ClassifyInput, ClassifyResult, Verdict } from "../classifier/types.ts";
import type { Config } from "../config.ts";
import { Alerter } from "../notifier/alerts.ts";
import type { Notification, Notifier } from "../notifier/types.ts";
import { JOB_VIEW_URL } from "../scraper/detail.ts";
import { type Fetch, type FetchResponse, LinkedInClient } from "../scraper/http.ts";
import { PAGE_SIZE, parseCards, SEARCH_URL } from "../scraper/search.ts";
import { CLASSIFIER_DOWN_THRESHOLD, Loop, NO_CARDS_THRESHOLD } from "./loop.ts";
import { openStore } from "./store.ts";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const POLL_MS = 300_000;

const YES: Verdict = { relevant: "yes", degreeOk: "yes", workAuth: "none", reason: "fine" };
const NO: Verdict = { relevant: "yes", degreeOk: "no", workAuth: "none", reason: "PhD only" };
const UNCLEAR: Verdict = {
  relevant: "unclear",
  degreeOk: "unclear",
  workAuth: "unclear",
  reason: "classifier error: x",
};

/** Baseline: the captured search page yields 10 cards in 8 dedupe keys. */
const FIXTURE_CARDS = parseCards(fixture("search-page0.html"));
const FIXTURE_KEYS = 8;

interface Detail {
  description?: string | null;
  /** Minutes before NOW. */
  age?: number;
}

/** A search page in the live card markup, one card per entry. */
function page(cards: { id: string; title?: string; company?: string; location?: string }[]) {
  const items = cards
    .map(
      ({ id, title = `Intern ${id}`, company = "Acme", location = "Austin, TX" }) => `<li>
  <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-${id}?position=1"></a>
  <h3 class="base-search-card__title">${title}</h3>
  <h4 class="base-search-card__subtitle">${company}</h4>
  <span class="job-search-card__location">${location}</span>
  <time datetime="2026-09-05">1 hour ago</time>
</li>`,
    )
    .join("\n");
  return `<ul>${items}</ul>`;
}

/** A view page whose JSON-LD carries only description and date, so card fields fill the rest. */
function viewPage(detail: Detail): string {
  const posting: Record<string, unknown> = {
    "@type": "JobPosting",
    datePosted: new Date(NOW - (detail.age ?? 5) * 60_000).toISOString(),
  };
  if (detail.description !== null) posting.description = detail.description ?? "<p>Body</p>";
  return `<script type="application/ld+json">${JSON.stringify(posting)}</script>`;
}

interface HarnessOptions {
  /** Search pages by search label, then by page index. Defaults to the fixture page. */
  pages?: Record<string, string[]>;
  details?: Record<string, Detail>;
  searches?: number;
  verdicts?: (input: ClassifyInput) => ClassifyResult;
}

function config(searches: number): Config {
  return {
    searches: Array.from({ length: searches }, (_, i) => ({
      label: `s${i}`,
      keywords: `s${i}`,
      params: { sortBy: "DD" },
    })),
    pollIntervalSec: POLL_MS / 1000,
    recencySec: 3600,
    firstCycleRecencySec: 600,
    maxPages: 5,
    classifier: {
      model: "m",
      program: "p",
      graduation: "g",
      term: "summer 2027",
      fields: "software engineering",
      reasoningEffort: "low",
    },
    dedupe: { windowDays: 14 },
    notifier: "telegram",
  };
}

function harness(opts: HarnessOptions = {}) {
  let t = NOW;
  const fetchErrors = new Map<string, () => FetchResponse | Error>();
  const fetch = vi.fn<Fetch>(async (url) => {
    for (const [needle, reply] of fetchErrors) {
      if (url.includes(needle)) {
        const r = reply();
        if (r instanceof Error) throw r;
        return r;
      }
    }
    if (url.startsWith(SEARCH_URL)) {
      const u = new URL(url);
      const label = u.searchParams.get("keywords") ?? "";
      const index = Number(u.searchParams.get("start")) / PAGE_SIZE;
      const body =
        opts.pages?.[label]?.[index] ?? (index === 0 ? fixture("search-page0.html") : "");
      return { status: 200, url, text: async () => body };
    }
    if (url.startsWith(JOB_VIEW_URL)) {
      const id = url.slice(JOB_VIEW_URL.length);
      return { status: 200, url, text: async () => viewPage(opts.details?.[id] ?? {}) };
    }
    throw new Error(`unscripted url ${url}`);
  });
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
  const log = silent as any;
  const client = new LinkedInClient({
    fetch,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    log,
  });

  const sent: Notification[] = [];
  const admin: string[] = [];
  let ready = true;
  let nextMessageId = 1;
  const notifier: Notifier & { setReady(v: boolean): void; failNext: Error | null } = {
    failNext: null,
    setReady: (v) => {
      ready = v;
    },
    start: async () => {},
    isReady: () => ready,
    send: vi.fn(async (n: Notification) => {
      if (notifier.failNext) {
        const err = notifier.failNext;
        notifier.failNext = null;
        throw err;
      }
      sent.push(n);
      return { messageId: String(nextMessageId++) };
    }),
    sendAdmin: vi.fn(async (text: string) => {
      admin.push(text);
    }),
    stop: async () => {},
  };

  const classify = vi.fn(async (input: ClassifyInput): Promise<ClassifyResult> => {
    return opts.verdicts?.(input) ?? { verdict: YES, error: null };
  });

  const timers: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const setTimeout = vi.fn(((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setTimeout);
  const clearTimeout = vi.fn(((id: unknown) => {
    cleared.push(id);
  }) as typeof globalThis.clearTimeout);

  const store = openStore(":memory:");
  const loop = new Loop({
    config: config(opts.searches ?? 1),
    store,
    client,
    notifier,
    classifier: { classify },
    alerter: new Alerter(notifier, { now: () => t, log }),
    now: () => t,
    setTimeout,
    clearTimeout,
    log,
  });

  return {
    loop,
    store,
    client,
    notifier,
    classify,
    sent,
    admin,
    timers,
    cleared,
    fetch,
    log: silent,
    scriptFetch: (needle: string, reply: () => FetchResponse | Error) =>
      fetchErrors.set(needle, reply),
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    /** Lets a cycle started by `start()` finish. Nothing in the harness waits on real timers. */
    flush: async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const detailCalls = (h: ReturnType<typeof harness>) =>
  h.fetch.mock.calls.filter(([url]) => url.startsWith(JOB_VIEW_URL)).length;

describe("Loop.runCycle", () => {
  it("first run sends one message per key; second run sends nothing", async () => {
    const h = harness();
    const first = await h.loop.runCycle();
    expect(first.searches).toEqual([
      { label: "s0", jobs: 10, inserted: 10, deferred: 0, cardsOnFirstPage: 10, halted: null },
    ]);
    expect(first).toMatchObject({
      groups: FIXTURE_KEYS,
      created: FIXTURE_KEYS,
      sent: FIXTURE_KEYS,
    });
    expect(h.sent).toHaveLength(FIXTURE_KEYS);
    expect(new Set(h.sent.map((n) => n.key)).size).toBe(FIXTURE_KEYS);
    const spectrum = h.sent.find((n) => n.company === "Spectrum");
    expect(spectrum?.postings.map((p) => p.location)).toEqual([
      "Greenwood Village, CO",
      "Englewood, CO",
    ]);
    expect(h.classify).toHaveBeenCalledTimes(FIXTURE_KEYS);
    expect(h.store.unsentNotifications()).toEqual([]);

    h.advance(POLL_MS);
    const second = await h.loop.runCycle();
    expect(second).toMatchObject({ groups: 0, created: 0, sent: 0 });
    expect(second.searches[0]).toMatchObject({ jobs: 0, inserted: 0 });
    expect(h.sent).toHaveLength(FIXTURE_KEYS);
    expect(detailCalls(h)).toBe(10);
  });

  it("uses firstCycleRecencySec on the first cycle and recencySec after", async () => {
    const h = harness();
    await h.loop.runCycle();
    await h.loop.runCycle();
    const tprs = h.fetch.mock.calls
      .map(([url]) => url)
      .filter((u) => u.startsWith(SEARCH_URL))
      .map((u) => new URL(u).searchParams.get("f_TPR"));
    expect(tprs[0]).toBe("r600");
    expect(tprs.at(-1)).toBe("r3600");
  });

  it("stores stale and gone jobs as seen without sending them", async () => {
    const [a, b] = FIXTURE_CARDS.map((c) => c.id) as [string, string];
    const h = harness({ details: { [a]: { age: 60 } } });
    h.scriptFetch(`${JOB_VIEW_URL}${b}`, () => ({
      status: 404,
      url: `${JOB_VIEW_URL}${b}`,
      text: async () => "",
    }));
    const summary = await h.loop.runCycle();
    expect(summary.searches[0]).toMatchObject({ jobs: 10, inserted: 10 });
    expect(h.store.hasJob(a)).toBe(true);
    expect(h.store.hasJob(b)).toBe(true);
    expect(h.store.getJobs([a, b]).map((j) => j.skip)).toEqual(["stale", "gone"]);
    expect(h.sent.some((n) => n.postings.some((p) => p.url.endsWith(a)))).toBe(false);
    expect(h.sent.some((n) => n.postings.some((p) => p.url.endsWith(b)))).toBe(false);
  });

  it("a send that throws leaves the row unsent and the next run sends it once", async () => {
    const h = harness();
    h.notifier.failNext = new Error("telegram 500");
    const first = await h.loop.runCycle();
    expect(first).toMatchObject({ created: FIXTURE_KEYS, sent: FIXTURE_KEYS - 1, failed: 1 });
    expect(h.admin).toEqual([expect.stringMatching(/^\[send_failed\] .*telegram 500/)]);
    const unsent = h.store.unsentNotifications();
    expect(unsent).toHaveLength(1);

    h.advance(POLL_MS);
    const second = await h.loop.runCycle();
    expect(second).toMatchObject({ created: 0, sent: 1, failed: 0 });
    expect(h.sent).toHaveLength(FIXTURE_KEYS);
    expect(h.sent.at(-1)?.key).toBe(unsent[0]?.key);
    expect(h.store.unsentNotifications()).toEqual([]);
  });

  it("degreeOk no creates no row, and the verdict lands on the classified job only", async () => {
    const h = harness({
      verdicts: (input) => ({ verdict: input.company === "Spectrum" ? NO : YES, error: null }),
    });
    const summary = await h.loop.runCycle();
    expect(summary).toMatchObject({
      groups: FIXTURE_KEYS,
      suppressed: 1,
      created: FIXTURE_KEYS - 1,
      sent: FIXTURE_KEYS - 1,
    });
    expect(h.sent.some((n) => n.company === "Spectrum")).toBe(false);
    expect(h.store.keyNotifiedSince("spectrum|2027 summer intern software engineer", 0)).toBe(
      false,
    );
    const spectrum = FIXTURE_CARDS.filter((c) => c.company === "Spectrum").map((c) => c.id);
    const verdicts = h.store.getJobs(spectrum).map((j) => j.verdict?.degreeOk ?? null);
    expect(verdicts).toEqual(["no", null]);
  });

  it("a group with no description gets no classify call and no tag", async () => {
    const [scaleAi] = FIXTURE_CARDS.filter((c) => c.company === "Scale AI");
    if (!scaleAi) throw new Error("fixture changed");
    const h = harness({
      details: { [scaleAi.id]: { description: null } },
      verdicts: () => ({ verdict: UNCLEAR, error: null }),
    });
    await h.loop.runCycle();
    expect(h.classify).toHaveBeenCalledTimes(FIXTURE_KEYS - 1);
    expect(h.classify.mock.calls.some(([i]) => i.company === "Scale AI")).toBe(false);
    const scale = h.sent.find((n) => n.company === "Scale AI");
    expect(scale?.tags).toEqual([]);
    expect(h.sent.filter((n) => n.company !== "Scale AI").every((n) => n.tags.length > 0)).toBe(
      true,
    );
  });

  it("notifier not ready stores rows and sends nothing, then sends them once ready", async () => {
    const h = harness();
    h.notifier.setReady(false);
    const first = await h.loop.runCycle();
    expect(first).toMatchObject({ created: FIXTURE_KEYS, sent: 0, failed: 0 });
    expect(h.notifier.send).not.toHaveBeenCalled();
    expect(h.store.unsentNotifications()).toHaveLength(FIXTURE_KEYS);
    expect(h.loop.status().status).toBe("notifier_down");

    h.notifier.setReady(true);
    h.advance(POLL_MS);
    const second = await h.loop.runCycle();
    expect(second).toMatchObject({ created: 0, sent: FIXTURE_KEYS });
    expect(h.sent).toHaveLength(FIXTURE_KEYS);
    expect(h.store.unsentNotifications()).toEqual([]);
  });

  it("stops the drain when the notifier flips not ready mid-way", async () => {
    const h = harness();
    h.notifier.send = vi.fn(async (n: Notification) => {
      h.sent.push(n);
      h.notifier.setReady(false);
      return { messageId: "1" };
    });
    const summary = await h.loop.runCycle();
    expect(summary.sent).toBe(1);
    expect(h.store.unsentNotifications()).toHaveLength(FIXTURE_KEYS - 1);
  });

  it("the stop flag halts between steps", async () => {
    const h = harness({ searches: 2 });
    let stop: Promise<void> | null = null;
    h.classify.mockImplementationOnce(async () => {
      stop = h.loop.stop();
      return { verdict: YES, error: null };
    });
    const summary = await h.loop.runCycle();
    await stop;
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ created: 0, sent: 0 });
    expect(h.store.unsentNotifications()).toEqual([]);
  });

  it("stop() waits for the in-flight cycle and clears the pending timer", async () => {
    const h = harness();
    h.loop.start();
    await h.flush();
    expect(h.timers).toHaveLength(1);
    await h.loop.stop();
    expect(h.cleared).toEqual([1]);
    h.timers[0]?.fn();
    await h.flush();
    expect(h.fetch.mock.calls.filter(([u]) => u.startsWith(SEARCH_URL))).toHaveLength(2);
  });

  it("no_cards fires on the third consecutive empty cycle for one search", async () => {
    const h = harness({
      searches: 2,
      pages: { s0: [fixture("search-empty.html")], s1: [page([{ id: "7000001" }])] },
    });
    for (let i = 1; i < NO_CARDS_THRESHOLD; i++) {
      await h.loop.runCycle();
      h.advance(POLL_MS);
    }
    expect(h.admin).toEqual([]);
    await h.loop.runCycle();
    expect(h.admin).toEqual([expect.stringMatching(/^\[no_cards\] s0: /)]);
  });

  it("no_cards resets on a cycle with cards and does not count halted cycles", async () => {
    const h = harness({ pages: { s0: [fixture("search-empty.html")] } });
    await h.loop.runCycle();
    h.advance(POLL_MS);
    h.scriptFetch(SEARCH_URL, () => ({ status: 429, url: SEARCH_URL, text: async () => "" }));
    await h.loop.runCycle();
    expect(h.admin).toEqual([expect.stringMatching(/^\[rate_limited\] s0: /)]);
    expect(h.loop.status().status).toBe("paused");
    h.advance(3 * 60_000);
    h.scriptFetch(SEARCH_URL, () => ({
      status: 200,
      url: SEARCH_URL,
      text: async () => fixture("search-page0.html"),
    }));
    await h.loop.runCycle();
    h.advance(POLL_MS);
    h.scriptFetch(SEARCH_URL, () => ({
      status: 200,
      url: SEARCH_URL,
      text: async () => fixture("search-empty.html"),
    }));
    for (let i = 0; i < NO_CARDS_THRESHOLD - 1; i++) {
      await h.loop.runCycle();
      h.advance(POLL_MS);
    }
    expect(h.admin).toHaveLength(1);
    await h.loop.runCycle();
    expect(h.admin[1]).toMatch(/^\[no_cards\]/);
  });

  it("classifier_down fires on the third consecutive error and resets on a clean answer", async () => {
    let errors = 0;
    const h = harness({
      verdicts: () =>
        errors++ < CLASSIFIER_DOWN_THRESHOLD - 1
          ? { verdict: UNCLEAR, error: "timeout" }
          : { verdict: YES, error: null },
    });
    await h.loop.runCycle();
    expect(h.admin).toEqual([]);
    expect(h.sent).toHaveLength(FIXTURE_KEYS);

    const h2 = harness({ verdicts: () => ({ verdict: UNCLEAR, error: "http 502" }) });
    await h2.loop.runCycle();
    expect(h2.admin).toEqual([expect.stringMatching(/^\[classifier_down\] 3 consecutive.*502/)]);
    expect(h2.sent).toHaveLength(FIXTURE_KEYS);
    expect(h2.sent.every((n) => n.tags.includes("eligibility unclear"))).toBe(true);
  });

  it("a thrown store error yields cycle_failed and the next run still works", async () => {
    const h = harness();
    vi.spyOn(h.store, "createNotifications").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const first = await h.loop.runCycle();
    expect(first).toMatchObject({ groups: FIXTURE_KEYS, created: 0, sent: 0 });
    expect(h.admin).toEqual(["[cycle_failed] cycle threw: disk full"]);
    expect(h.log.error).toHaveBeenCalledWith(expect.anything(), "cycle failed");
    expect(h.loop.status()).toMatchObject({ lastCycleAt: NOW, lastSuccessfulCycleAt: null });

    h.advance(POLL_MS);
    const secondAt = h.now();
    const second = await h.loop.runCycle();
    expect(second).toMatchObject({ groups: 0, created: 0, sent: 0 });
    expect(h.loop.status().lastSuccessfulCycleAt).toBe(secondAt);
  });

  it("orders groups by newest postedAt across two searches, unknown first", async () => {
    const h = harness({
      searches: 2,
      pages: {
        s0: [
          page([
            { id: "8000001", title: "A" },
            { id: "8000002", title: "B" },
          ]),
        ],
        s1: [
          page([
            { id: "8000003", title: "C" },
            { id: "8000004", title: "D" },
          ]),
        ],
      },
      details: {
        "8000001": { age: 2 },
        "8000002": { age: 9 },
        "8000003": { age: 1 },
        "8000004": { age: 5 },
      },
    });
    h.scriptFetch(`${JOB_VIEW_URL}8000004`, () => ({
      status: 200,
      url: `${JOB_VIEW_URL}8000004`,
      text: async () => '<div class="show-more-less-html__markup"><p>Body</p></div>',
    }));
    await h.loop.runCycle();
    expect(h.sent.map((n) => n.title)).toEqual(["D", "B", "A", "C"]);
  });

  it("a posting seen by two searches is fetched once", async () => {
    const shared = page([{ id: "9000001" }]);
    const h = harness({ searches: 2, pages: { s0: [shared], s1: [shared] } });
    const summary = await h.loop.runCycle();
    expect(detailCalls(h)).toBe(1);
    expect(summary.searches.map((s) => s.inserted)).toEqual([1, 0]);
    expect(h.sent).toHaveLength(1);
  });

  it("a key inside the window is dropped before classification", async () => {
    const h = harness();
    await h.loop.runCycle();
    h.advance(POLL_MS);
    h.classify.mockClear();
    const [card] = FIXTURE_CARDS;
    if (!card) throw new Error("fixture changed");
    const clone = page([
      { id: "9100001", title: card.title, company: card.company, location: "Remote" },
    ]);
    h.scriptFetch(SEARCH_URL, () => ({ status: 200, url: SEARCH_URL, text: async () => clone }));
    const summary = await h.loop.runCycle();
    expect(summary).toMatchObject({ groups: 0, created: 0 });
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.store.hasJob("9100001")).toBe(true);
  });
});

describe("Loop.start", () => {
  it("runs the first cycle immediately and schedules the next one at the poll interval", async () => {
    const h = harness();
    h.loop.start();
    await h.flush();
    expect(h.sent).toHaveLength(FIXTURE_KEYS);
    expect(h.timers.map((t) => t.ms)).toEqual([POLL_MS]);
    h.advance(POLL_MS);
    const secondAt = h.now();
    h.timers[0]?.fn();
    await h.flush();
    expect(h.timers).toHaveLength(2);
    expect(h.loop.status().lastCycleAt).toBe(secondAt);
  });

  it("schedules the next cycle at pausedUntil when that is later", async () => {
    const h = harness();
    h.scriptFetch(SEARCH_URL, () => ({ status: 999, url: SEARCH_URL, text: async () => "" }));
    h.loop.start();
    await h.flush();
    expect(h.admin).toEqual([expect.stringMatching(/^\[blocked\]/)]);
    const pausedUntil = h.client.pausedUntil()?.getTime();
    expect(pausedUntil).toBeDefined();
    expect(h.timers[0]?.ms).toBe((pausedUntil as number) - h.now());
    expect(h.timers[0]?.ms).toBeGreaterThan(POLL_MS);
  });
});

describe("Loop.status", () => {
  it("is ok after a cycle, stale after three idle intervals", async () => {
    const h = harness();
    expect(h.loop.status()).toEqual({
      status: "ok",
      lastCycleAt: null,
      lastSuccessfulCycleAt: null,
      pausedUntil: null,
      notifierReady: true,
    });
    await h.loop.runCycle();
    expect(h.loop.status()).toMatchObject({
      status: "ok",
      lastCycleAt: NOW,
      lastSuccessfulCycleAt: NOW,
    });
    h.advance(3 * POLL_MS + 1);
    expect(h.loop.status().status).toBe("stale");
  });

  it("is stale when no cycle has succeeded since boot", () => {
    const h = harness();
    h.advance(3 * POLL_MS + 1);
    expect(h.loop.status().status).toBe("stale");
  });
});
