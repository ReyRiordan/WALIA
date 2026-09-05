export { type BackoffState, BLOCK_PAUSE_MS, RATE_LIMIT_LADDER_MS, type Signal } from "./backoff.ts";
export {
  type DetailFields,
  type FetchDetailOpts,
  fetchDetail,
  htmlToText,
  JOB_FRAGMENT_URL,
  JOB_VIEW_URL,
  parseDetailFragment,
  parseJobPostingJsonLd,
} from "./detail.ts";
export {
  BlockedError,
  BudgetExhaustedError,
  type ErrorSignal,
  NotFoundError,
  RateLimitError,
  ScrapeError,
  TransientError,
} from "./errors.ts";
export {
  type Fetch,
  type FetchResponse,
  LinkedInClient,
  type LinkedInClientOptions,
  MAX_GAP_MS,
  MAX_REQUESTS_PER_CYCLE,
  MIN_GAP_MS,
  REQUEST_TIMEOUT_MS,
  TRANSIENT_RETRY_DELAY_MS,
  USER_AGENT,
} from "./http.ts";
export {
  buildSearchUrl,
  PAGE_SIZE,
  parseCards,
  type ScrapeOpts,
  SEARCH_URL,
  scrapeSearch,
} from "./search.ts";
export type { Card, Job, ScrapeResult } from "./types.ts";
