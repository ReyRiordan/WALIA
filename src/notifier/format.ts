import type { Verdict } from "../classifier/types.ts";
import type { Group } from "../core/dedupe.ts";
import type { Notification, Tag } from "./types.ts";

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

/** Tags for a verdict. Wording and level are decided here, once; adapters print them. */
function tagsFor(verdict: Verdict | null): Tag[] {
  if (!verdict) return [];
  const tags: Tag[] = [];
  if (verdict.degreeOk === "unclear") tags.push({ text: "eligibility unclear", level: "info" });
  if (verdict.workAuth === "no_sponsorship") tags.push({ text: "no sponsorship", level: "info" });
  if (verdict.workAuth === "citizen_only") tags.push({ text: "US citizens only", level: "warn" });
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

/** Telegram HTML: bold title, italic company, one linked location per posting, optional tag line. */
export function formatNotification(n: Notification): string {
  const lines = [
    `<b>${escapeHtml(n.title)}</b>`,
    `<i>${escapeHtml(n.company)}</i>`,
    n.postings
      .map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.location)}</a>`)
      .join(" · "),
  ];
  if (n.tags.length > 0) {
    const glyph = n.tags.some((t) => t.level === "warn") ? "⚠️" : "ℹ️";
    lines.push(`${glyph} ${n.tags.map((t) => t.text).join(" · ")}`);
  }
  return lines.join("\n");
}
