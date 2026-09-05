import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_PAUSE_MS } from "./backoff.ts";
import {
  BlockedError,
  BudgetExhaustedError,
  NotFoundError,
  RateLimitError,
  TransientError,
} from "./errors.ts";
import {
  type Fetch,
  type FetchResponse,
  LinkedInClient,
  MAX_GAP_MS,
  MAX_REQUESTS_PER_CYCLE,
  MIN_GAP_MS,
  TRANSIENT_RETRY_DELAY_MS,
} from "./http.ts";

const URL_A = "https://www.linkedin.com/jobs/view/1";

function response(status: number, body = "ok", url = URL_A): FetchResponse {
  return { status, url, text: async () => body };
}

/** A fake clock plus a sleep that advances it, and a fetch whose replies are scripted. */
function harness(replies: (FetchResponse | Error)[] = []) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  });
  const queue = [...replies];
  const fetch = vi.fn<Fetch>(async () => {
    const reply = queue.shift();
    if (reply === undefined) throw new Error("fetch called with no scripted reply");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const log = { info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  const client = new LinkedInClient({
    fetch,
    sleep,
    now: () => t,
    // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
    log: log as any,
  });
  return {
    client,
    fetch,
    sleep,
    sleeps,
    log,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

describe("LinkedInClient spacing", () => {
  it("sleeps a random gap in [MIN, MAX] between requests", async () => {
    const h = harness([response(200), response(200)]);
    await h.client.get(URL_A);
    expect(h.sleeps).toEqual([]);
    await h.client.get(URL_A);
    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(h.sleeps[0]).toBeLessThanOrEqual(MAX_GAP_MS);
  });

  it("does not sleep when the gap has already elapsed", async () => {
    const h = harness([response(200), response(200)]);
    await h.client.get(URL_A);
    h.advance(MAX_GAP_MS + 1);
    await h.client.get(URL_A);
    expect(h.sleeps).toEqual([]);
  });

  it("serialises concurrent calls", async () => {
    const h = harness([response(200, "a"), response(200, "b")]);
    const order: string[] = [];
    h.fetch.mockImplementation(async () => {
      order.push("start");
      await Promise.resolve();
      order.push("end");
      return response(200);
    });
    await Promise.all([h.client.get(URL_A), h.client.get(URL_A)]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });
});

describe("LinkedInClient budget", () => {
  it("throws BudgetExhaustedError on the 16th request without fetching", async () => {
    const h = harness(Array.from({ length: MAX_REQUESTS_PER_CYCLE }, () => response(200)));
    h.client.beginCycle();
    for (let i = 0; i < MAX_REQUESTS_PER_CYCLE; i++) await h.client.get(URL_A);
    expect(h.client.remaining()).toBe(0);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(h.fetch).toHaveBeenCalledTimes(MAX_REQUESTS_PER_CYCLE);
  });

  it("beginCycle resets the count", async () => {
    const h = harness(Array.from({ length: MAX_REQUESTS_PER_CYCLE + 1 }, () => response(200)));
    for (let i = 0; i < MAX_REQUESTS_PER_CYCLE; i++) await h.client.get(URL_A);
    h.client.beginCycle();
    expect(h.client.remaining()).toBe(MAX_REQUESTS_PER_CYCLE);
    await expect(h.client.get(URL_A)).resolves.toBe("ok");
  });
});

describe("LinkedInClient rate limit", () => {
  it("429 pauses two minutes, blocks the next call, and a 200 after the pause resets", async () => {
    const h = harness([response(429), response(200)]);
    const start = h.now();
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(RateLimitError);
    expect(h.client.pausedUntil()?.getTime()).toBe(start + 2 * 60_000);

    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(RateLimitError);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledOnce();

    h.advance(2 * 60_000);
    await expect(h.client.get(URL_A)).resolves.toBe("ok");
    expect(h.client.pausedUntil()).toBeNull();
  });

  it("carries the last status on the error", async () => {
    const h = harness([response(429)]);
    await expect(h.client.get(URL_A)).rejects.toMatchObject({
      signal: "rate_limited",
      status: 429,
    });
  });
});

describe("LinkedInClient block", () => {
  it("999 throws BlockedError and pauses one hour", async () => {
    const h = harness([response(999)]);
    const start = h.now();
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BlockedError);
    expect(h.client.pausedUntil()?.getTime()).toBe(start + BLOCK_PAUSE_MS);
  });

  it("a 200 whose final URL is /authwall throws BlockedError", async () => {
    const h = harness([
      response(200, "<html>", "https://www.linkedin.com/authwall?trk=x"),
      response(200),
    ]);
    const start = h.now();
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BlockedError);
    expect(h.client.pausedUntil()?.getTime()).toBe(start + BLOCK_PAUSE_MS);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BlockedError);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a 200 that landed on /login throws BlockedError", async () => {
    const h = harness([response(200, "<html>", "https://www.linkedin.com/login")]);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BlockedError);
  });

  it("a slugged /jobs/view redirect is not a block", async () => {
    const h = harness([
      response(200, "body", "https://www.linkedin.com/jobs/view/swe-intern-at-acme-1"),
    ]);
    await expect(h.client.get(URL_A)).resolves.toBe("body");
  });
});

describe("LinkedInClient transient", () => {
  it("503 then 200 returns the body after one retry sleep and counts two requests", async () => {
    const h = harness([response(503), response(200, "second")]);
    await expect(h.client.get(URL_A)).resolves.toBe("second");
    expect(h.sleeps).toEqual([TRANSIENT_RETRY_DELAY_MS]);
    expect(h.client.remaining()).toBe(MAX_REQUESTS_PER_CYCLE - 2);
  });

  it("503 then 503 throws TransientError", async () => {
    const h = harness([response(503), response(503)]);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(TransientError);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("an aborted fetch is transient", async () => {
    const abort = new DOMException("The operation was aborted", "TimeoutError");
    const h = harness([abort, response(200, "recovered")]);
    await expect(h.client.get(URL_A)).resolves.toBe("recovered");
  });

  it("a retry with no budget left throws BudgetExhaustedError", async () => {
    const h = harness(Array.from({ length: MAX_REQUESTS_PER_CYCLE }, () => response(200)));
    for (let i = 0; i < MAX_REQUESTS_PER_CYCLE - 1; i++) await h.client.get(URL_A);
    h.fetch.mockResolvedValueOnce(response(502));
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("an unexpected status throws TransientError without retry", async () => {
    const h = harness([response(302)]);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(TransientError);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it("does not touch backoff state", async () => {
    const h = harness([response(503), response(503)]);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(TransientError);
    expect(h.client.pausedUntil()).toBeNull();
  });
});

describe("LinkedInClient not found", () => {
  it("404 throws NotFoundError and leaves backoff alone", async () => {
    const h = harness([response(404)]);
    await expect(h.client.get(URL_A)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.client.pausedUntil()).toBeNull();
  });

  it("410 throws NotFoundError", async () => {
    const h = harness([response(410)]);
    await expect(h.client.get(URL_A)).rejects.toMatchObject({ signal: "not_found", status: 410 });
  });
});

describe("LinkedInClient request init", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness([response(200)]);
  });

  it("sends the browser headers, follows redirects, and sets a timeout", async () => {
    await h.client.get(URL_A);
    const init = h.fetch.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.headers).toMatchObject({
      "User-Agent": expect.stringContaining("Chrome"),
      "Accept-Language": "en-US,en;q=0.9",
    });
    expect(init.redirect).toBe("follow");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.dispatcher).toBeUndefined();
  });

  it("carries a dispatcher when proxyUrl is set", async () => {
    const fetch = vi.fn<Fetch>(async () => response(200));
    const client = new LinkedInClient({
      fetch,
      sleep: async () => {},
      proxyUrl: "http://user:pass@proxy.example:8080",
      // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
      log: { info: vi.fn(), warn: vi.fn() } as any,
    });
    await client.get(URL_A);
    const init = fetch.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeDefined();
  });

  it("logs status, elapsed, and count for every request", async () => {
    h.fetch.mockResolvedValueOnce(response(200));
    await h.client.get(URL_A);
    await h.client.get(URL_A);
    expect(h.log.info).toHaveBeenCalledTimes(2);
    expect(h.log.info.mock.calls[0]?.[0]).toMatchObject({
      url: URL_A,
      status: 200,
      elapsedMs: expect.any(Number),
      count: 1,
    });
    expect(h.log.info.mock.calls[1]?.[0]).toMatchObject({ status: 200, count: 2 });
  });
});
