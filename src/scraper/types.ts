import type { ScrapeError } from "./errors.ts";

/** One `<li>` in a guest search response. */
export interface Card {
  id: string;
  title: string;
  company: string;
  location: string;
  /** From `<time datetime>`, YYYY-MM-DD. */
  postedOn: string | null;
  href: string;
}

/** A card joined with its detail page. What the loop stores and the classifier reads. */
export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  /** Plain text; null when the detail page had no description. */
  description: string | null;
  /** https://www.linkedin.com/jobs/view/{id} */
  url: string;
  postedAt: Date | null;
  searchLabel: string;
  /** The loop stores these as seen and never sends them. */
  skip?: "stale" | "gone";
}

export interface ScrapeResult {
  jobs: Job[];
  /** Unseen ids left without a detail fetch because the cycle budget ran out. */
  deferred: number;
  /** The loop uses this for the three-cycle zero-cards alert. */
  cardsOnFirstPage: number;
  halted?: ScrapeError;
}
