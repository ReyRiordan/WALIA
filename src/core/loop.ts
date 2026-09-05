import type { Logger } from "pino";
import type { Classifier, Verdict } from "../classifier/types.ts";
import type { Config } from "../config.ts";
import { log as rootLog } from "../log.ts";
import type { Alerter } from "../notifier/alerts.ts";
import { toNotification } from "../notifier/format.ts";
import type { Notifier } from "../notifier/types.ts";
import type { LinkedInClient } from "../scraper/http.ts";
import { scrapeSearch } from "../scraper/search.ts";
import type { Job } from "../scraper/types.ts";
import { type Group, groupByKey } from "./dedupe.ts";
import type { Store } from "./store.ts";

const DAY_MS = 24 * 60 * 60_000;

/** Consecutive empty first pages for one search before `no_cards` fires. */
export const NO_CARDS_THRESHOLD = 3;
/** Consecutive classifier failures before `classifier_down` fires. */
export const CLASSIFIER_DOWN_THRESHOLD = 3;
/** Poll intervals without a successful cycle before `/health` reports `stale`. */
export const STALE_INTERVALS = 3;

export interface LoopOptions {
  config: Config;
  store: Store;
  client: LinkedInClient;
  notifier: Notifier;
  classifier: Classifier;
  alerter: Alerter;
  /** Epoch ms. */
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  log?: Logger;
}

export interface SearchSummary {
  label: string;
  jobs: number;
  inserted: number;
  deferred: number;
  cardsOnFirstPage: number;
  halted: string | null;
}

/** What one `runCycle` did. Logged at the end of every cycle. */
export interface CycleSummary {
  searches: SearchSummary[];
  /** Groups that passed the notification window. */
  groups: number;
  /** Groups dropped on `relevant === "no"` or `degreeOk === "no"`. */
  suppressed: number;
  /** Notification rows created this cycle. */
  created: number;
  /** Rows sent this cycle, including retries from earlier cycles. */
  sent: number;
  /** Sends that threw. Their rows stay unsent. */
  failed: number;
}

export interface LoopStatus {
  status: "ok" | "paused" | "stale" | "notifier_down";
  lastCycleAt: number | null;
  lastSuccessfulCycleAt: number | null;
  pausedUntil: number | null;
  notifierReady: boolean;
}

/**
 * The poll loop. One cycle at a time on a `setTimeout` chain: scrape every search, group new
 * jobs by dedupe key, classify one job per group, create notification rows, then drain every
 * unsent row in id order. Every collaborator is injected so tests run against fakes.
 */
export class Loop {
  private readonly config: Config;
  private readonly store: Store;
  private readonly client: LinkedInClient;
  private readonly notifier: Notifier;
  private readonly classifier: Classifier;
  private readonly alerter: Alerter;
  private readonly now: () => number;
  private readonly setTimeout: typeof globalThis.setTimeout;
  private readonly clearTimeout: typeof globalThis.clearTimeout;
  private readonly log: Logger;

  private readonly startedAt: number;
  private firstCycle = true;
  private stopping = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private running: Promise<CycleSummary> | null = null;
  private lastCycleAt: number | null = null;
  private lastSuccessfulCycleAt: number | null = null;
  private readonly emptyCycles = new Map<string, number>();
  private classifierErrors = 0;

  constructor(opts: LoopOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.client = opts.client;
    this.notifier = opts.notifier;
    this.classifier = opts.classifier;
    this.alerter = opts.alerter;
    this.now = opts.now ?? Date.now;
    this.setTimeout = opts.setTimeout ?? globalThis.setTimeout;
    this.clearTimeout = opts.clearTimeout ?? globalThis.clearTimeout;
    this.log = opts.log ?? rootLog.child({ component: "loop" });
    this.startedAt = this.now();
  }

  /** Runs the first cycle now and schedules the rest. Returns immediately. */
  start(): void {
    void this.tick();
  }

  /**
   * Sets the stop flag, clears the pending timer, and resolves once the in-flight cycle has
   * returned at its next step boundary. Safe to call twice.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      this.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
  }

  status(): LoopStatus {
    const now = this.now();
    const pausedUntil = this.client.pausedUntil()?.getTime() ?? null;
    const notifierReady = this.notifier.isReady();
    const reference = this.lastSuccessfulCycleAt ?? this.startedAt;
    const stale = now - reference > STALE_INTERVALS * this.config.pollIntervalSec * 1000;
    let status: LoopStatus["status"] = "ok";
    if (!notifierReady) status = "notifier_down";
    else if (pausedUntil !== null) status = "paused";
    else if (stale) status = "stale";
    return {
      status,
      lastCycleAt: this.lastCycleAt,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt,
      pausedUntil,
      notifierReady,
    };
  }

  /** One cycle. Never throws: a failure is logged, alerted as `cycle_failed`, and summarised. */
  runCycle(now: number = this.now()): Promise<CycleSummary> {
    const run = this.runCycleInner(now);
    this.running = run;
    return run.finally(() => {
      if (this.running === run) this.running = null;
    });
  }

  private async runCycleInner(now: number): Promise<CycleSummary> {
    const summary: CycleSummary = {
      searches: [],
      groups: 0,
      suppressed: 0,
      created: 0,
      sent: 0,
      failed: 0,
    };
    const recencySec = this.firstCycle ? this.config.firstCycleRecencySec : this.config.recencySec;
    this.firstCycle = false;
    this.log.info({ recencySec, at: new Date(now).toISOString() }, "cycle started");
    try {
      await this.cycle(now, recencySec, summary);
      this.lastSuccessfulCycleAt = now;
      this.log.info({ ...summary, stopped: this.stopping }, "cycle finished");
    } catch (err) {
      this.log.error({ err, ...summary }, "cycle failed");
      await this.alerter.alert("cycle_failed", `cycle threw: ${(err as Error).message}`);
    } finally {
      this.lastCycleAt = now;
    }
    return summary;
  }

  private async cycle(now: number, recencySec: number, summary: CycleSummary): Promise<void> {
    this.client.beginCycle();
    const fresh: Job[] = [];
    for (const search of this.config.searches) {
      fresh.push(...(await this.scrape(search, recencySec, now, summary)));
      if (this.stopping) return;
    }

    const windowStart = now - this.config.dedupe.windowDays * DAY_MS;
    const groups = groupByKey(fresh).filter(
      (g) => !this.store.keyNotifiedSince(g.key, windowStart),
    );
    summary.groups = groups.length;

    const passing: Group[] = [];
    for (const group of groups) {
      if (this.stopping) return;
      if (await this.classify(group, now)) passing.push(group);
      else summary.suppressed += 1;
    }

    passing.sort((a, b) => newestPostedAt(a) - newestPostedAt(b));
    summary.created = this.store.createNotifications(passing, now).length;

    await this.drain(now, summary);
  }

  private async scrape(
    search: Config["searches"][number],
    recencySec: number,
    now: number,
    summary: CycleSummary,
  ): Promise<Job[]> {
    const result = await scrapeSearch(this.client, search, {
      recencySec,
      maxPages: this.config.maxPages,
      isSeen: (id) => this.store.hasJob(id),
      now: () => now,
    });
    const fresh = result.jobs.filter((job) => !this.store.hasJob(job.id));
    const inserted = this.store.insertJobs(result.jobs, now);
    const halted = result.halted?.signal ?? null;
    const line: SearchSummary = {
      label: search.label,
      jobs: result.jobs.length,
      inserted,
      deferred: result.deferred,
      cardsOnFirstPage: result.cardsOnFirstPage,
      halted,
    };
    summary.searches.push(line);
    this.log.info({ ...line, skipped: result.jobs.filter((j) => j.skip).length }, "search scraped");

    if (halted === "rate_limited" || halted === "blocked") {
      await this.alerter.alert(halted, `${search.label}: ${result.halted?.message}`);
    } else if (halted !== null) {
      this.log.warn({ label: search.label, err: result.halted }, "search halted");
    }

    if (result.cardsOnFirstPage > 0) {
      this.emptyCycles.set(search.label, 0);
    } else if (halted === null) {
      const count = (this.emptyCycles.get(search.label) ?? 0) + 1;
      this.emptyCycles.set(search.label, count);
      if (count >= NO_CARDS_THRESHOLD) {
        await this.alerter.alert(
          "no_cards",
          `${search.label}: no cards on the first page for ${count} consecutive cycles`,
        );
      }
    }

    return fresh.filter((job) => !job.skip);
  }

  /** Classifies the first job with a description. False when the group is suppressed. */
  private async classify(group: Group, now: number): Promise<boolean> {
    const job = group.jobs.find((j) => j.description !== null);
    if (!job || job.description === null) {
      this.log.info({ key: group.key }, "no description in group; sending untagged");
      return true;
    }
    const result = await this.classifier.classify({
      title: job.title,
      company: job.company,
      description: job.description,
    });
    this.store.setVerdict(job.id, result.verdict, now);
    if (result.error === null) {
      this.classifierErrors = 0;
    } else {
      this.classifierErrors += 1;
      if (this.classifierErrors >= CLASSIFIER_DOWN_THRESHOLD) {
        await this.alerter.alert(
          "classifier_down",
          `${this.classifierErrors} consecutive failures, last: ${result.error}`,
        );
      }
    }
    const field = suppressedBy(result.verdict);
    if (field !== null) {
      this.log.info({ key: group.key, field, reason: result.verdict.reason }, "group suppressed");
      return false;
    }
    return true;
  }

  /** Sends every unsent row in id order, so retries from earlier cycles go out first. */
  private async drain(now: number, summary: CycleSummary): Promise<void> {
    if (!this.notifier.isReady()) {
      this.log.warn("notifier not ready; unsent rows wait for a later cycle");
      return;
    }
    for (const row of this.store.unsentNotifications()) {
      if (this.stopping || !this.notifier.isReady()) return;
      const group = groupByKey(row.jobs)[0];
      if (!group) {
        this.log.error({ id: row.id, key: row.key }, "notification row has no jobs; skipped");
        continue;
      }
      const verdict: Verdict | null = row.jobs.find((j) => j.verdict !== null)?.verdict ?? null;
      let messageId: string;
      try {
        ({ messageId } = await this.notifier.send(toNotification(group, verdict)));
      } catch (err) {
        summary.failed += 1;
        this.log.error({ err, id: row.id, key: row.key }, "send failed; row stays unsent");
        await this.alerter.alert("send_failed", `${row.key}: ${(err as Error).message}`);
        continue;
      }
      this.store.markSent([row.id], messageId, now);
      summary.sent += 1;
      this.log.info(
        { id: row.id, key: row.key, messageId, retry: row.createdAt !== now },
        "notification sent",
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    await this.runCycle();
    if (this.stopping) return;
    const now = this.now();
    const pausedUntil = this.client.pausedUntil()?.getTime() ?? 0;
    const nextAt = Math.max(now + this.config.pollIntervalSec * 1000, pausedUntil);
    this.log.info(
      { nextCycleAt: new Date(nextAt).toISOString(), delaySec: Math.round((nextAt - now) / 1000) },
      "next cycle scheduled",
    );
    this.timer = this.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, nextAt - now);
  }
}

/** The verdict field that suppresses the group, relevance first, or null when it goes out. */
function suppressedBy(verdict: Verdict): "relevant" | "degreeOk" | null {
  if (verdict.relevant === "no") return "relevant";
  if (verdict.degreeOk === "no") return "degreeOk";
  return null;
}

/** Newest `postedAt` in the group as epoch ms; groups with no timestamp sort first. */
function newestPostedAt(group: Group): number {
  let newest = 0;
  for (const job of group.jobs) {
    const t = job.postedAt?.getTime() ?? 0;
    if (t > newest) newest = t;
  }
  return newest;
}
