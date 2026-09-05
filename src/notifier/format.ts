import type { Verdict } from "../classifier/types.ts";
import type { Group } from "../core/dedupe.ts";
import type { Notification } from "./types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escapes `&`, `<`, `>`, `"` for Telegram HTML text and attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Tags for a verdict. Wording is decided here, once; adapters print the strings. */
function tagsFor(verdict: Verdict | null): string[] {
  if (!verdict) return [];
  const tags: string[] = [];
  if (verdict.degreeOk === "unclear") tags.push("eligibility unclear");
  if (verdict.workAuth === "no_sponsorship") tags.push("no sponsorship");
  if (verdict.workAuth === "citizen_only") tags.push("US citizens only");
  return tags;
}

/**
 * Lifts a group and its single verdict into plain notification data. One posting per
 * location, first appearance wins, so each city links to one listing.
 */
export function toNotification(group: Group, verdict: Verdict | null): Notification {
  const seen = new Set<string>();
  const postings: Notification["postings"] = [];
  for (const job of group.jobs) {
    if (seen.has(job.location)) continue;
    seen.add(job.location);
    postings.push({ location: job.location, url: job.url });
  }
  return {
    key: group.key,
    title: group.title,
    company: group.company,
    postings,
    tags: tagsFor(verdict),
  };
}

/** Telegram HTML: bold title, company, one linked location per posting, optional tag line. */
export function formatNotification(n: Notification): string {
  const lines = [
    `<b>${escapeHtml(n.title)}</b>`,
    escapeHtml(n.company),
    n.postings
      .map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.location)}</a>`)
      .join(" · "),
  ];
  if (n.tags.length > 0) lines.push(`⚠️ ${n.tags.join(" · ")}`);
  return lines.join("\n");
}
