import type { Logger } from "pino";
import { type Dispatcher, ProxyAgent } from "undici";
import { log as rootLog } from "../log.ts";
import { type BackoffState, INITIAL_STATE, next } from "./backoff.ts";
import {
  BlockedError,
  BudgetExhaustedError,
  NotFoundError,
  RateLimitError,
  TransientError,
} from "./errors.ts";

export const MAX_REQUESTS_PER_CYCLE = 15;
export const MIN_GAP_MS = 2_000;
export const MAX_GAP_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const TRANSIENT_RETRY_DELAY_MS = 30_000;
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const BLOCK_PATHS = ["/authwall", "/login"];

/** The parts of a fetch Response the client reads. Tests build these directly. */
export type FetchResponse = Pick<Response, "status" | "url" | "text">;
export type Fetch = (url: string, init: RequestInit) => Promise<FetchResponse>;

export interface LinkedInClientOptions {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms. */
  now?: () => number;
  proxyUrl?: string;
  log?: Logger;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Throttled GET client for LinkedIn guest endpoints. One instance per process, passed to
 * scrapeSearch. Serialises requests, spaces them by a random gap, caps them per cycle, and
 * turns status codes into typed errors while tracking backoff state in memory.
 */
export class LinkedInClient {
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly dispatcher: Dispatcher | undefined;

  private count = 0;
  private lastRequestAt: number | null = null;
  private state: BackoffState = INITIAL_STATE;
  private lastSignal: "rate_limited" | "blocked" | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: LinkedInClientOptions = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? rootLog.child({ component: "scraper" });
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
  }

  /** Resets the per-cycle request count. The loop calls this once per cycle. */
  beginCycle(): void {
    this.count = 0;
  }

  /** Requests left in this cycle. */
  remaining(): number {
    return Math.max(0, MAX_REQUESTS_PER_CYCLE - this.count);
  }

  /** When backoff lifts, or null when not paused. The loop delays the next cycle until then. */
  pausedUntil(): Date | null {
    const until = this.state.pausedUntil;
    return until !== null && until > this.now() ? new Date(until) : null;
  }

  /** Fetch a guest page and return its body. Calls are serialised; see the class doc. */
  get(url: string): Promise<string> {
    const result = this.queue.then(() => this.run(url));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(url: string): Promise<string> {
    this.checkPaused(url);
    this.checkBudget(url);
    await this.waitForGap();
    const first = await this.attempt(url);
    if (first.retry) {
      this.log.warn(
        { url, status: first.status, err: first.cause },
        "transient failure, retrying once",
      );
      await this.sleep(TRANSIENT_RETRY_DELAY_MS);
      this.checkBudget(url);
      const second = await this.attempt(url);
      if (second.retry) throw new TransientError(url, second.status, second.cause);
      return second.body;
    }
    return first.body;
  }

  private checkPaused(url: string): void {
    const until = this.state.pausedUntil;
    if (until === null || this.now() >= until) return;
    this.log.warn(
      { url, pausedUntil: new Date(until).toISOString(), signal: this.lastSignal },
      "request skipped, backoff pause active",
    );
    throw this.lastSignal === "blocked" ? new BlockedError(url) : new RateLimitError(url);
  }

  private checkBudget(url: string): void {
    if (this.remaining() === 0) throw new BudgetExhaustedError(url);
  }

  private async waitForGap(): Promise<void> {
    if (this.lastRequestAt === null) return;
    const target = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
    const elapsed = this.now() - this.lastRequestAt;
    if (elapsed < target) await this.sleep(Math.round(target - elapsed));
  }

  /** One HTTP round trip. Returns a body, or asks for a retry; throws on non-transient statuses. */
  private async attempt(
    url: string,
  ): Promise<{ retry: false; body: string } | { retry: true; status?: number; cause?: unknown }> {
    const started = this.now();
    this.lastRequestAt = started;
    let res: FetchResponse;
    try {
      res = await this.fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      this.count += 1;
      this.log.info(
        { url, status: null, elapsedMs: this.now() - started, count: this.count, err },
        "linkedin request failed",
      );
      return { retry: true, cause: err };
    }
    this.count += 1;
    const status = res.status;
    this.log.info(
      { url, status, elapsedMs: this.now() - started, count: this.count },
      "linkedin request",
    );

    if (status === 200) {
      if (this.isBlockedUrl(res.url)) {
        this.apply("blocked");
        throw new BlockedError(url, status);
      }
      this.apply("ok");
      return { retry: false, body: await res.text() };
    }
    if (status === 429) {
      this.apply("rate_limited");
      throw new RateLimitError(url, status);
    }
    if (status === 999) {
      this.apply("blocked");
      throw new BlockedError(url, status);
    }
    if (status === 404 || status === 410) throw new NotFoundError(url, status);
    if (status >= 500) return { retry: true, status };
    throw new TransientError(url, status);
  }

  private isBlockedUrl(finalUrl: string): boolean {
    if (!finalUrl) return false;
    try {
      const path = new URL(finalUrl).pathname;
      return BLOCK_PATHS.some((p) => path.startsWith(p));
    } catch {
      return false;
    }
  }

  private apply(signal: "ok" | "rate_limited" | "blocked"): void {
    this.state = next(this.state, signal, this.now());
    this.lastSignal = signal === "ok" ? null : signal;
  }
}
