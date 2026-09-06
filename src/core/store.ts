import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DegreeOk, Relevant, Verdict, WorkAuth } from "../classifier/types.ts";
import type { Job } from "../scraper/types.ts";
import { dedupeKey, type Group } from "./dedupe.ts";

/** A job as read back from the store. */
export interface StoredJob extends Job {
  firstSeenAt: number;
  verdict: Verdict | null;
}

/** A notification row whose message has not been confirmed sent. */
export interface PendingNotification {
  id: number;
  key: string;
  createdAt: number;
  jobs: StoredJob[];
}

/**
 * Ordered, append-only. `PRAGMA user_version` is the cursor: on open, every entry past
 * the current version runs in its own transaction and bumps the version.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE jobs (
    linkedin_id       TEXT PRIMARY KEY,
    dedupe_key        TEXT NOT NULL,
    title             TEXT NOT NULL,
    company           TEXT NOT NULL,
    location          TEXT NOT NULL,
    description       TEXT,
    url               TEXT NOT NULL,
    posted_at         INTEGER,
    first_seen_at     INTEGER NOT NULL,
    search_label      TEXT NOT NULL,
    skip              TEXT,
    degree_ok         TEXT,
    work_auth         TEXT,
    classifier_reason TEXT,
    classified_at     INTEGER
  );
  CREATE INDEX jobs_dedupe_key ON jobs(dedupe_key);

  CREATE TABLE notifications (
    id           INTEGER PRIMARY KEY,
    dedupe_key   TEXT NOT NULL,
    linkedin_ids TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    sent_at      INTEGER,
    message_id   TEXT
  );
  CREATE INDEX notifications_key_created ON notifications(dedupe_key, created_at);`,
  "ALTER TABLE jobs ADD COLUMN relevant TEXT",
];

interface JobRow {
  linkedin_id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  url: string;
  posted_at: number | null;
  first_seen_at: number;
  search_label: string;
  skip: "stale" | "gone" | null;
  /** NULL on rows classified before the column existed; read back as "unclear". */
  relevant: Relevant | null;
  degree_ok: DegreeOk | null;
  work_auth: WorkAuth | null;
  classifier_reason: string | null;
}

interface NotificationRow {
  id: number;
  dedupe_key: string;
  linkedin_ids: string;
  created_at: number;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return new Store(db);
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export class Store {
  readonly #db: DatabaseSync;
  readonly #hasJob: StatementSync;
  readonly #insertJob: StatementSync;
  readonly #getJob: StatementSync;
  readonly #setVerdict: StatementSync;
  readonly #keyNotifiedSince: StatementSync;
  readonly #insertNotification: StatementSync;
  readonly #markSent: StatementSync;
  readonly #unsent: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#hasJob = db.prepare("SELECT 1 FROM jobs WHERE linkedin_id = ?");
    this.#insertJob = db.prepare(
      `INSERT OR IGNORE INTO jobs (linkedin_id, dedupe_key, title, company, location, description,
         url, posted_at, first_seen_at, search_label, skip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#getJob = db.prepare("SELECT * FROM jobs WHERE linkedin_id = ?");
    this.#setVerdict = db.prepare(
      `UPDATE jobs SET relevant = ?, degree_ok = ?, work_auth = ?, classifier_reason = ?,
         classified_at = ?
       WHERE linkedin_id = ?`,
    );
    this.#keyNotifiedSince = db.prepare(
      "SELECT 1 FROM notifications WHERE dedupe_key = ? AND created_at >= ? LIMIT 1",
    );
    this.#insertNotification = db.prepare(
      "INSERT INTO notifications (dedupe_key, linkedin_ids, created_at) VALUES (?, ?, ?)",
    );
    this.#markSent = db.prepare(
      "UPDATE notifications SET sent_at = ?, message_id = ? WHERE id = ?",
    );
    this.#unsent = db.prepare(
      "SELECT id, dedupe_key, linkedin_ids, created_at FROM notifications WHERE sent_at IS NULL ORDER BY id",
    );
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The scraper's `isSeen`. */
  hasJob(id: string): boolean {
    return this.#hasJob.get(id) !== undefined;
  }

  /** `INSERT OR IGNORE` in one transaction. Returns the number of rows actually inserted. */
  insertJobs(jobs: Job[], now: number): number {
    return this.#transaction(() => {
      let inserted = 0;
      for (const job of jobs) {
        const result = this.#insertJob.run(
          job.id,
          dedupeKey(job),
          job.title,
          job.company,
          job.location,
          job.description,
          job.url,
          job.postedAt ? job.postedAt.getTime() : null,
          now,
          job.searchLabel,
          job.skip ?? null,
        );
        inserted += Number(result.changes);
      }
      return inserted;
    });
  }

  /** Rows for the given ids, in input order. Unknown ids are skipped. */
  getJobs(ids: string[]): StoredJob[] {
    const jobs: StoredJob[] = [];
    for (const id of ids) {
      const row = this.#getJob.get(id) as JobRow | undefined;
      if (row) jobs.push(toStoredJob(row));
    }
    return jobs;
  }

  setVerdict(id: string, verdict: Verdict, now: number): void {
    this.#setVerdict.run(
      verdict.relevant,
      verdict.degreeOk,
      verdict.workAuth,
      verdict.reason,
      now,
      id,
    );
  }

  /** True when any notification row for the key, sent or not, has `created_at >= sinceMs`. */
  keyNotifiedSince(key: string, sinceMs: number): boolean {
    return this.#keyNotifiedSince.get(key, sinceMs) !== undefined;
  }

  /** One row per group in one transaction. Returns the new row ids in input order. */
  createNotifications(groups: Group[], now: number): number[] {
    return this.#transaction(() =>
      groups.map((group) => {
        const ids = JSON.stringify(group.jobs.map((job) => job.id));
        return Number(this.#insertNotification.run(group.key, ids, now).lastInsertRowid);
      }),
    );
  }

  /** Stamps `sent_at` and the shared `message_id` on every id in one transaction. */
  markSent(ids: number[], messageId: string, now: number): void {
    this.#transaction(() => {
      for (const id of ids) this.#markSent.run(now, messageId, id);
    });
  }

  /** Every row with `sent_at IS NULL`, oldest first, with its jobs rehydrated. */
  unsentNotifications(): PendingNotification[] {
    const rows = this.#unsent.all() as unknown as NotificationRow[];
    return rows.map((row) => ({
      id: row.id,
      key: row.dedupe_key,
      createdAt: row.created_at,
      jobs: this.getJobs(parseIds(row)),
    }));
  }

  close(): void {
    this.#db.close();
  }
}

function toStoredJob(row: JobRow): StoredJob {
  const job: StoredJob = {
    id: row.linkedin_id,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    url: row.url,
    postedAt: row.posted_at === null ? null : new Date(row.posted_at),
    searchLabel: row.search_label,
    firstSeenAt: row.first_seen_at,
    verdict:
      row.degree_ok === null || row.work_auth === null
        ? null
        : {
            relevant: row.relevant ?? "unclear",
            degreeOk: row.degree_ok,
            workAuth: row.work_auth,
            reason: row.classifier_reason ?? "",
          },
  };
  if (row.skip !== null) job.skip = row.skip;
  return job;
}

/** A row whose JSON is not a string array is corruption, not something to skip. */
function parseIds(row: NotificationRow): string[] {
  const parsed: unknown = JSON.parse(row.linkedin_ids);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new Error(`notifications row ${row.id}: linkedin_ids is not a string array`);
  }
  return parsed;
}
