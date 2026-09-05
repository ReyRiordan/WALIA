import type { Job } from "../scraper/types.ts";

/** One message: every job in a cycle that shares a dedupe key. */
export interface Group {
  key: string;
  title: string;
  company: string;
  locations: string[];
  jobs: Job[];
}

/**
 * Lowercase, collapse every run of non-letter/non-digit characters to one space, trim.
 * Deliberately minimal: "Stripe, Inc." and "Stripe" stay different. A missed job costs
 * more than a duplicate line.
 */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `normalise(company) + "|" + normalise(title)`. Location is excluded so per-city clones collapse. */
export function dedupeKey(job: Pick<Job, "title" | "company">): string {
  return `${normalise(job.company)}|${normalise(job.title)}`;
}

/**
 * Groups jobs by dedupe key. Group order and location order follow first appearance;
 * locations are deduped by exact string; title and company come from the first job.
 */
export function groupByKey(jobs: Job[]): Group[] {
  const groups = new Map<string, Group>();
  for (const job of jobs) {
    const key = dedupeKey(job);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: job.title, company: job.company, locations: [], jobs: [] };
      groups.set(key, group);
    }
    if (!group.locations.includes(job.location)) group.locations.push(job.location);
    group.jobs.push(job);
  }
  return [...groups.values()];
}
