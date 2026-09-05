import { describe, expect, it } from "vitest";
import { fixture } from "../../test/helpers/fixture.ts";
import { parseCards } from "../scraper/search.ts";
import type { Card, Job } from "../scraper/types.ts";
import { dedupeKey, groupByKey, normalise } from "./dedupe.ts";

function toJob(card: Card): Job {
  return {
    id: card.id,
    title: card.title,
    company: card.company,
    location: card.location,
    description: null,
    url: `https://www.linkedin.com/jobs/view/${card.id}`,
    postedAt: card.postedOn ? new Date(card.postedOn) : null,
    searchLabel: "test",
  };
}

describe("normalise", () => {
  it("lowercases and collapses punctuation runs to one space", () => {
    expect(normalise("  Software Engineer Intern (Summer 2027 - Austin) ")).toBe(
      "software engineer intern summer 2027 austin",
    );
    expect(normalise("AI/ML -- Intern!!")).toBe("ai ml intern");
  });

  it("keeps unicode letters and digits", () => {
    expect(normalise("Zürich Straße 3")).toBe("zürich straße 3");
    expect(normalise("東京 Intern")).toBe("東京 intern");
  });

  it("does not strip corporate suffixes", () => {
    expect(normalise("Stripe, Inc.")).toBe("stripe inc");
    expect(normalise("Stripe, Inc.")).not.toBe(normalise("Stripe"));
  });
});

describe("dedupeKey", () => {
  it("joins company and title, ignoring location", () => {
    expect(
      dedupeKey({ company: "Bain & Company", title: "AI Engineering Intern (Summer 2027)" }),
    ).toBe("bain company|ai engineering intern summer 2027");
  });
});

describe("groupByKey", () => {
  const jobs = parseCards(fixture("search-page0.html")).map(toJob);

  it("collapses per-city clones and keeps first-appearance order", () => {
    const groups = groupByKey(jobs);
    expect(groups.length).toBeLessThan(jobs.length);
    expect(groups.map((g) => g.key)).toEqual([...new Set(jobs.map(dedupeKey))]);

    const spectrum = groups.find((g) => g.company === "Spectrum");
    expect(spectrum).toBeDefined();
    expect(spectrum?.title).toBe("2027 Summer Intern: Software Engineer");
    expect(spectrum?.locations).toEqual(["Greenwood Village, CO", "Englewood, CO"]);
    expect(spectrum?.jobs).toHaveLength(2);

    const bain = groups.filter((g) => g.company === "Bain & Company");
    expect(bain).toHaveLength(1);
    expect(bain[0]?.locations).toEqual(["Buffalo-Niagara Falls Area", "San Francisco, CA"]);

    const optiver = groups.filter((g) => g.company === "Optiver");
    expect(optiver.map((g) => g.title)).toEqual([
      "Software Engineer Intern (Summer 2027 - Austin)",
      "Software Engineer Intern (Summer 2027 - Chicago)",
    ]);
  });

  it("dedupes locations by exact string and takes title from the first job", () => {
    const base = jobs[0] as Job;
    const groups = groupByKey([
      { ...base, id: "1", title: "SWE Intern", location: "Austin, TX" },
      { ...base, id: "2", title: "swe intern", location: "Austin, TX" },
      { ...base, id: "3", title: "SWE   Intern", location: "Chicago, IL" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("SWE Intern");
    expect(groups[0]?.locations).toEqual(["Austin, TX", "Chicago, IL"]);
    expect(groups[0]?.jobs.map((j) => j.id)).toEqual(["1", "2", "3"]);
  });
});
