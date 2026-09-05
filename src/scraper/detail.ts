import * as cheerio from "cheerio";
import { NotFoundError } from "./errors.ts";
import type { LinkedInClient } from "./http.ts";
import type { Card, Job } from "./types.ts";

export const JOB_VIEW_URL = "https://www.linkedin.com/jobs/view/";
export const JOB_FRAGMENT_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/";

export interface DetailFields {
  title?: string;
  company?: string;
  location?: string;
  /** Plain text. `null` when the source exists but carries no description. */
  description?: string | null;
  postedAt?: Date | null;
}

export interface FetchDetailOpts {
  recencySec: number;
  searchLabel: string;
  /** Epoch ms. */
  now(): number;
}

const BLOCK_TAGS = "p, div, ul, ol, h1, h2, h3, h4, h5, h6, tr";

/**
 * Strip markup to plain text. Blocks are wrapped in newlines, so adjacent paragraphs leave a
 * blank line between them; `br` and `li` end a line without one.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html, null, false);
  $("br").replaceWith("\n");
  $("li").append("\n");
  $(BLOCK_TAGS).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  return $.root()
    .text()
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (node["@type"] === "JobPosting") return node;
  if ("@graph" in node) return findJobPosting(node["@graph"]);
  return null;
}

function jsonLdLocation(jobLocation: unknown): string | undefined {
  const first = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (!isRecord(first)) return undefined;
  const address = isRecord(first.address) ? first.address : first;
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
    .map(text)
    .filter((p): p is string => p !== undefined);
  return parts.length ? parts.join(", ") : undefined;
}

function parseDate(value: unknown): Date | null | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The `JobPosting` object from the view page's JSON-LD, or null when there is none. */
export function parseJobPostingJsonLd(html: string): DetailFields | null {
  const $ = cheerio.load(html);
  let posting: Record<string, unknown> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (posting) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      return;
    }
    posting = findJobPosting(parsed);
  });
  if (!posting) return null;
  const p: Record<string, unknown> = posting;
  const org = isRecord(p.hiringOrganization) ? p.hiringOrganization : {};
  const description = text(p.description);
  return {
    title: text(p.title),
    company: text(org.name),
    location: jsonLdLocation(p.jobLocation),
    description: description ? htmlToText(description) || null : null,
    postedAt: parseDate(p.datePosted),
  };
}

const RELATIVE_UNITS_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** "57 minutes ago" to milliseconds. Null when the text is not a relative time. */
export function parseRelativeTime(label: string): number | null {
  const cleaned = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (cleaned === "just now" || cleaned === "now") return 0;
  const match = /^(\d+)\+? (second|minute|hour|day|week|month)s? ago$/.exec(cleaned);
  if (!match) return null;
  const unit = RELATIVE_UNITS_MS[match[2] ?? ""];
  return unit === undefined ? null : Number(match[1]) * unit;
}

/**
 * Fields from the top-card markup shared by the view page and the guest `jobPosting/{id}`
 * fragment. Null when the description container is absent. `postedAt` comes from the relative
 * "N minutes ago" label, resolved against `now`.
 */
export function parseDetailFragment(html: string, now: number = Date.now()): DetailFields | null {
  const $ = cheerio.load(html);
  const markup = $("div.show-more-less-html__markup").first();
  if (markup.length === 0) return null;
  const description = htmlToText(markup.html() ?? "");
  const ago = parseRelativeTime($("span.posted-time-ago__text").first().text());
  return {
    title: text($("h1.top-card-layout__title, h2.top-card-layout__title").first().text()),
    company: text($("a.topcard__org-name-link").first().text()),
    location: text($("span.topcard__flavor--bullet").first().text()),
    description: description || null,
    postedAt: ago === null ? undefined : new Date(now - ago),
  };
}

function cardDate(card: Card): Date | null {
  if (!card.postedOn) return null;
  const date = new Date(`${card.postedOn}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function goneJob(card: Card, searchLabel: string): Job {
  return {
    id: card.id,
    title: card.title,
    company: card.company,
    location: card.location,
    description: null,
    url: `${JOB_VIEW_URL}${card.id}`,
    postedAt: cardDate(card),
    searchLabel,
    skip: "gone",
  };
}

/**
 * Fetch the view page for a card and merge its detail fields over the card fields. Sources in
 * order: JSON-LD on the view page, top-card markup on the view page, then the guest fragment
 * endpoint. Never throws NotFoundError; other ScrapeErrors propagate.
 */
export async function fetchDetail(
  client: Pick<LinkedInClient, "get">,
  card: Card,
  opts: FetchDetailOpts,
): Promise<Job> {
  let fields: DetailFields | null;
  try {
    const view = await client.get(`${JOB_VIEW_URL}${card.id}`);
    fields = parseJobPostingJsonLd(view) ?? parseDetailFragment(view, opts.now());
    if (fields === null) {
      fields = parseDetailFragment(await client.get(`${JOB_FRAGMENT_URL}${card.id}`), opts.now());
    }
  } catch (err) {
    if (err instanceof NotFoundError) return goneJob(card, opts.searchLabel);
    throw err;
  }
  const detail = fields ?? {};
  const job: Job = {
    id: card.id,
    title: detail.title ?? card.title,
    company: detail.company ?? card.company,
    location: detail.location ?? card.location,
    description: detail.description ?? null,
    url: `${JOB_VIEW_URL}${card.id}`,
    postedAt: detail.postedAt ?? cardDate(card),
    searchLabel: opts.searchLabel,
  };
  // Only a detail timestamp is precise enough to judge recency. The card date is day-granular
  // and already served as the pre-filter, so a job with no detail time is sent, not skipped.
  const posted = detail.postedAt?.getTime();
  if (posted !== undefined && posted < opts.now() - opts.recencySec * 1000) job.skip = "stale";
  return job;
}
