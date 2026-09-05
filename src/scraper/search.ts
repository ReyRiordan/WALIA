import * as cheerio from "cheerio";
import type { Search } from "../config.ts";
import { fetchDetail } from "./detail.ts";
import { BudgetExhaustedError, ScrapeError } from "./errors.ts";
import type { LinkedInClient } from "./http.ts";
import type { Card, ScrapeResult } from "./types.ts";

export const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
export const PAGE_SIZE = 10;
const ID_RE = /-(\d{6,})(?:[?/]|$)/;
const DAY_MS = 24 * 60 * 60_000;

export interface ScrapeOpts {
  recencySec: number;
  maxPages: number;
  isSeen(id: string): boolean;
  /** Epoch ms. */
  now?(): number;
}

/** The guest "load more" endpoint for one page of a search. */
export function buildSearchUrl(search: Search, recencySec: number, start: number): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keywords", search.keywords);
  for (const [key, value] of Object.entries(search.params)) url.searchParams.set(key, value);
  url.searchParams.set("f_TPR", `r${recencySec}`);
  url.searchParams.set("start", String(start));
  return url.toString();
}

/** One `Card` per `<li>` with a `/jobs/view/` link carrying an id. Never throws. */
export function parseCards(html: string): Card[] {
  const $ = cheerio.load(html);
  const cards: Card[] = [];
  $("li").each((_, li) => {
    const el = $(li);
    const link = el.find('a[href*="/jobs/view/"]').first();
    const href = link.attr("href") ?? "";
    const id = ID_RE.exec(href)?.[1];
    if (!id) return;
    const clean = (sel: string) => el.find(sel).first().text().replace(/\s+/g, " ").trim();
    cards.push({
      id,
      title: clean("h3.base-search-card__title"),
      company: clean("h4.base-search-card__subtitle"),
      location: clean("span.job-search-card__location"),
      postedOn: el.find("time[datetime]").first().attr("datetime") ?? null,
      href,
    });
  });
  return cards;
}

/**
 * True when the card cannot be inside the window: its date is day-granular in an unknown
 * timezone, so a card is dropped only when the end of its posted day plus a full day of
 * margin is still before the window start.
 */
function beforeWindow(card: Card, windowStart: number): boolean {
  if (!card.postedOn) return false;
  const day = Date.parse(`${card.postedOn}T00:00:00Z`);
  if (Number.isNaN(day)) return false;
  return day + 2 * DAY_MS < windowStart;
}

/**
 * Page through one search, fetch details for unseen cards, and return whatever was collected
 * before the budget ran out or the client threw. Assumes `client.beginCycle()` has been called.
 */
export async function scrapeSearch(
  client: Pick<LinkedInClient, "get">,
  search: Search,
  opts: ScrapeOpts,
): Promise<ScrapeResult> {
  const now = opts.now ?? Date.now;
  const windowStart = now() - opts.recencySec * 1000;
  const result: ScrapeResult = { jobs: [], deferred: 0, cardsOnFirstPage: 0 };
  const unseen: Card[] = [];
  const ids = new Set<string>();

  const halt = (err: unknown, fetched: number) => {
    if (!(err instanceof ScrapeError)) throw err;
    result.deferred = unseen.length - fetched;
    if (!(err instanceof BudgetExhaustedError)) result.halted = err;
    return result;
  };

  try {
    for (let page = 0; page < opts.maxPages; page++) {
      const cards = parseCards(
        await client.get(buildSearchUrl(search, opts.recencySec, page * PAGE_SIZE)),
      );
      if (page === 0) result.cardsOnFirstPage = cards.length;
      let added = 0;
      for (const card of cards) {
        if (ids.has(card.id) || opts.isSeen(card.id) || beforeWindow(card, windowStart)) continue;
        ids.add(card.id);
        unseen.push(card);
        added += 1;
      }
      // A short page is the last one; a page with nothing new means nothing older is new either.
      if (cards.length < PAGE_SIZE || added === 0) break;
    }
  } catch (err) {
    return halt(err, 0);
  }

  const detailOpts = { recencySec: opts.recencySec, searchLabel: search.label, now };
  for (const card of unseen) {
    try {
      result.jobs.push(await fetchDetail(client, card, detailOpts));
    } catch (err) {
      return halt(err, result.jobs.length);
    }
  }
  return result;
}
