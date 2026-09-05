export type ErrorSignal = "rate_limited" | "blocked" | "transient" | "not_found" | "budget";

interface ScrapeErrorFields {
  signal: ErrorSignal;
  url: string;
  status?: number;
}

/** Base class for everything the client throws. Callers never see raw status codes. */
export class ScrapeError extends Error {
  readonly signal: ErrorSignal;
  readonly url: string;
  readonly status: number | undefined;

  constructor(message: string, fields: ScrapeErrorFields, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScrapeError";
    this.signal = fields.signal;
    this.url = fields.url;
    this.status = fields.status;
  }
}

/** 429, or any request made while paused after a 429. */
export class RateLimitError extends ScrapeError {
  constructor(url: string, status?: number) {
    super(`rate limited: ${url}`, { signal: "rate_limited", url, status });
    this.name = "RateLimitError";
  }
}

/** 999, a final URL on /authwall or /login, or any request made while paused after a block. */
export class BlockedError extends ScrapeError {
  constructor(url: string, status?: number) {
    super(`blocked: ${url}`, { signal: "blocked", url, status });
    this.name = "BlockedError";
  }
}

/** 5xx, network error, or timeout on both attempts; or an unexpected status. */
export class TransientError extends ScrapeError {
  constructor(url: string, status?: number, cause?: unknown) {
    super(`transient failure: ${url}`, { signal: "transient", url, status }, { cause });
    this.name = "TransientError";
  }
}

/** 404 or 410. */
export class NotFoundError extends ScrapeError {
  constructor(url: string, status: number) {
    super(`not found: ${url}`, { signal: "not_found", url, status });
    this.name = "NotFoundError";
  }
}

/** The per-cycle request cap is spent. */
export class BudgetExhaustedError extends ScrapeError {
  constructor(url: string) {
    super(`request budget exhausted: ${url}`, { signal: "budget", url });
    this.name = "BudgetExhaustedError";
  }
}
