import { describe, expect, it } from "vitest";
import type { Verdict } from "../classifier/types.ts";
import type { Group } from "../core/dedupe.ts";
import type { Job } from "../scraper/types.ts";
import { escapeHtml, formatNotification, toNotification } from "./format.ts";
import type { Notification } from "./types.ts";

function job(id: string, location: string): Job {
  return {
    id,
    title: "Software Engineer Intern",
    company: "Spectrum",
    location,
    description: null,
    url: `https://www.linkedin.com/jobs/view/${id}`,
    postedAt: null,
    searchLabel: "test",
  };
}

function group(...jobs: Job[]): Group {
  const first = jobs[0] as Job;
  return {
    key: "spectrum|software engineer intern",
    title: first.title,
    company: first.company,
    locations: [...new Set(jobs.map((j) => j.location))],
    jobs,
  };
}

function verdict(v: Partial<Verdict>): Verdict {
  return { relevant: "yes", degreeOk: "yes", workAuth: "none", reason: "", ...v };
}

describe("escapeHtml", () => {
  it("escapes the four characters Telegram HTML needs", () => {
    expect(escapeHtml('R&D Intern <Summer> "2027"')).toBe(
      "R&amp;D Intern &lt;Summer&gt; &quot;2027&quot;",
    );
  });
});

describe("toNotification", () => {
  it("keeps one posting per location in first-appearance order", () => {
    const n = toNotification(
      group(
        job("111", "Greenwood Village, CO"),
        job("222", "Englewood, CO"),
        job("333", "Englewood, CO"),
      ),
      null,
    );
    expect(n.key).toBe("spectrum|software engineer intern");
    expect(n.postings).toEqual([
      { location: "Greenwood Village, CO", url: "https://www.linkedin.com/jobs/view/111" },
      { location: "Englewood, CO", url: "https://www.linkedin.com/jobs/view/222" },
    ]);
  });

  it.each<[Partial<Verdict> | null, string[]]>([
    [{ degreeOk: "unclear" }, ["eligibility unclear"]],
    [{ relevant: "unclear" }, []],
    [{ relevant: "no" }, []],
    [{ workAuth: "no_sponsorship" }, ["no sponsorship"]],
    [{ workAuth: "citizen_only" }, ["US citizens only"]],
    [{ workAuth: "none" }, []],
    [{ workAuth: "unclear" }, []],
    [
      { degreeOk: "unclear", workAuth: "no_sponsorship" },
      ["eligibility unclear", "no sponsorship"],
    ],
    [null, []],
  ])("maps verdict %j to tags %j", (v, tags) => {
    const n = toNotification(group(job("1", "Austin, TX")), v === null ? null : verdict(v));
    expect(n.tags).toEqual(tags);
  });
});

describe("formatNotification", () => {
  const base: Notification = {
    key: "k",
    title: "Software Engineer Intern",
    company: "Spectrum",
    postings: [
      { location: "Greenwood Village, CO", url: "https://www.linkedin.com/jobs/view/111" },
    ],
    tags: [],
  };

  it("renders one posting with no tag line", () => {
    expect(formatNotification(base)).toBe(
      [
        "<b>Software Engineer Intern</b>",
        "Spectrum",
        '<a href="https://www.linkedin.com/jobs/view/111">Greenwood Village, CO</a>',
      ].join("\n"),
    );
  });

  it("renders two postings and both tags", () => {
    const n: Notification = {
      ...base,
      postings: [
        ...base.postings,
        { location: "Englewood, CO", url: "https://www.linkedin.com/jobs/view/222" },
      ],
      tags: ["eligibility unclear", "no sponsorship"],
    };
    expect(formatNotification(n)).toBe(
      [
        "<b>Software Engineer Intern</b>",
        "Spectrum",
        '<a href="https://www.linkedin.com/jobs/view/111">Greenwood Village, CO</a> · <a href="https://www.linkedin.com/jobs/view/222">Englewood, CO</a>',
        "⚠️ eligibility unclear · no sponsorship",
      ].join("\n"),
    );
  });

  it("escapes title, company, and location", () => {
    const n: Notification = {
      ...base,
      title: "R&D Intern <Summer>",
      company: 'Bain & "Co"',
      postings: [{ location: "A <B>", url: "https://www.linkedin.com/jobs/view/1?a=1&b=2" }],
    };
    expect(formatNotification(n)).toBe(
      [
        "<b>R&amp;D Intern &lt;Summer&gt;</b>",
        "Bain &amp; &quot;Co&quot;",
        '<a href="https://www.linkedin.com/jobs/view/1?a=1&amp;b=2">A &lt;B&gt;</a>',
      ].join("\n"),
    );
  });
});
