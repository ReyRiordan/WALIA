import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "../scraper/types.ts";
import type { Group } from "./dedupe.ts";
import { dedupeKey, groupByKey } from "./dedupe.ts";
import { MIGRATIONS, openStore, renameLegacyStore, type Store } from "./store.ts";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const DAY = 86_400_000;

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    title: "SWE Intern",
    company: "Acme",
    location: "Austin, TX",
    description: `Description for ${id}`,
    url: `https://www.linkedin.com/jobs/view/${id}`,
    postedAt: new Date(NOW - 60_000),
    searchLabel: "test",
    ...over,
  };
}

describe("renameLegacyStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "malja-legacy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames walia.db and its sidecars when malja.db is absent", () => {
    for (const suffix of ["", "-wal", "-shm"])
      writeFileSync(join(dir, `walia.db${suffix}`), suffix);
    renameLegacyStore(dir);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(join(dir, `walia.db${suffix}`))).toBe(false);
      expect(readFileSync(join(dir, `malja.db${suffix}`), "utf8")).toBe(suffix);
    }
  });

  it("skips missing sidecars", () => {
    writeFileSync(join(dir, "walia.db"), "");
    renameLegacyStore(dir);
    expect(existsSync(join(dir, "malja.db"))).toBe(true);
    expect(existsSync(join(dir, "malja.db-wal"))).toBe(false);
  });

  it("leaves everything alone once malja.db exists", () => {
    writeFileSync(join(dir, "malja.db"), "new");
    writeFileSync(join(dir, "walia.db"), "old");
    renameLegacyStore(dir);
    expect(readFileSync(join(dir, "malja.db"), "utf8")).toBe("new");
    expect(existsSync(join(dir, "walia.db"))).toBe(true);
  });

  it("does nothing in an empty directory", () => {
    renameLegacyStore(dir);
    expect(existsSync(join(dir, "malja.db"))).toBe(false);
  });
});

describe("openStore on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "malja-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the directory, runs migrations once, and reopens without rerunning them", () => {
    const path = join(dir, "nested", "malja.db");
    const first = openStore(path);
    expect(first.insertJobs([job("1")], NOW)).toBe(1);
    first.close();
    expect(existsSync(path)).toBe(true);

    const second = openStore(path);
    expect(second.hasJob("1")).toBe(true);
    second.close();

    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
  });

  it("migrates a version-1 file and reads its classified rows as relevant unclear", () => {
    const path = join(dir, "malja.db");
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0] as string);
    db.exec("PRAGMA user_version = 1");
    db.prepare(
      `INSERT INTO jobs (linkedin_id, dedupe_key, title, company, location, description, url,
         first_seen_at, search_label, degree_ok, work_auth, classifier_reason, classified_at)
       VALUES ('1', 'acme|swe intern', 'SWE Intern', 'Acme', 'Austin, TX', 'd', 'u', ?, 'test',
         'yes', 'none', 'Says BS/MS.', ?)`,
    ).run(NOW, NOW + 5);
    db.prepare(
      `INSERT INTO jobs (linkedin_id, dedupe_key, title, company, location, url, first_seen_at,
         search_label)
       VALUES ('2', 'acme|swe intern', 'SWE Intern', 'Acme', 'Chicago, IL', 'u', ?, 'test')`,
    ).run(NOW);
    db.close();

    const store = openStore(path);
    expect(store.getJobs(["1"])[0]?.verdict).toEqual({
      relevant: "unclear",
      degreeOk: "yes",
      workAuth: "none",
      reason: "Says BS/MS.",
    });
    expect(store.getJobs(["2"])[0]?.verdict).toBeNull();
    store.setVerdict("2", { relevant: "no", degreeOk: "yes", workAuth: "none", reason: "FT" }, NOW);
    expect(store.getJobs(["2"])[0]?.verdict?.relevant).toBe("no");
    store.close();

    const reopened = new DatabaseSync(path);
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    reopened.close();
  });
});

describe("Store", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
  });
  afterEach(() => {
    store.close();
  });

  it("round-trips jobs through insertJobs, hasJob, and getJobs", () => {
    const full = job("1");
    const sparse = job("2", { postedAt: null, description: null, skip: "stale" });
    expect(store.insertJobs([full, sparse], NOW)).toBe(2);
    expect(store.hasJob("1")).toBe(true);
    expect(store.hasJob("2")).toBe(true);
    expect(store.hasJob("3")).toBe(false);

    expect(store.getJobs(["2", "1", "3"])).toEqual([
      { ...sparse, firstSeenAt: NOW, verdict: null },
      { ...full, firstSeenAt: NOW, verdict: null },
    ]);
  });

  it("ignores an existing id and counts only new rows", () => {
    expect(store.insertJobs([job("1")], NOW)).toBe(1);
    expect(store.insertJobs([job("1", { title: "Changed" }), job("2")], NOW + 1)).toBe(1);
    expect(store.getJobs(["1"])[0]?.title).toBe("SWE Intern");
    expect(store.insertJobs([], NOW)).toBe(0);
  });

  it("stores and returns a verdict", () => {
    store.insertJobs([job("1")], NOW);
    const verdict = {
      relevant: "yes",
      degreeOk: "unclear",
      workAuth: "no_sponsorship",
      reason: "PhD preferred",
    } as const;
    store.setVerdict("1", verdict, NOW + 5);
    expect(store.getJobs(["1"])[0]?.verdict).toEqual(verdict);
  });

  it("answers keyNotifiedSince from created_at regardless of sent state", () => {
    const jobs = [job("1"), job("2", { location: "Chicago, IL" })];
    store.insertJobs(jobs, NOW);
    const [group] = groupByKey(jobs) as [Group];
    store.createNotifications([group], NOW);

    expect(store.keyNotifiedSince(group.key, NOW - 14 * DAY)).toBe(true);
    expect(store.keyNotifiedSince(group.key, NOW)).toBe(true);
    expect(store.keyNotifiedSince(group.key, NOW + 1)).toBe(false);
    expect(store.keyNotifiedSince(dedupeKey({ company: "Other", title: "Intern" }), 0)).toBe(false);
  });

  it("keeps rows pending until markSent covers them", () => {
    const a = [job("1"), job("2", { location: "Chicago, IL" })];
    const b = [job("3", { company: "Globex" })];
    store.insertJobs([...a, ...b], NOW);
    const groups = groupByKey([...a, ...b]);
    const ids = store.createNotifications(groups, NOW);
    expect(ids).toHaveLength(2);

    const pending = store.unsentNotifications();
    expect(pending.map((p) => p.id)).toEqual(ids);
    expect(pending[0]).toMatchObject({ key: groups[0]?.key, createdAt: NOW });
    expect(pending[0]?.jobs.map((j) => j.id)).toEqual(["1", "2"]);
    expect(pending[1]?.jobs.map((j) => j.id)).toEqual(["3"]);

    store.markSent([ids[0] as number], "msg-1", NOW + 1000);
    expect(store.unsentNotifications().map((p) => p.id)).toEqual([ids[1]]);

    store.markSent([ids[1] as number], "msg-1", NOW + 1000);
    expect(store.unsentNotifications()).toEqual([]);
    expect(store.keyNotifiedSince(groups[0]?.key as string, NOW)).toBe(true);
  });

  it("rolls back createNotifications when a group throws mid-transaction", () => {
    const jobs = [job("1"), job("2", { company: "Globex" })];
    store.insertJobs(jobs, NOW);
    const [good, bad] = groupByKey(jobs) as [Group, Group];
    const poisoned: Group = {
      ...bad,
      jobs: [
        {
          ...(bad.jobs[0] as Job),
          get id(): string {
            throw new Error("boom");
          },
        },
      ],
    };
    expect(() => store.createNotifications([good, poisoned], NOW)).toThrow("boom");
    expect(store.unsentNotifications()).toEqual([]);
    expect(store.keyNotifiedSince(good.key, 0)).toBe(false);
    // The connection is usable again after the rollback.
    expect(store.createNotifications([good], NOW)).toHaveLength(1);
  });
});
