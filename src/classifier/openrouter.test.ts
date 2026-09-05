import { describe, expect, it, vi } from "vitest";
import {
  type Fetch,
  type FetchResponse,
  MAX_TOKENS,
  OPENROUTER_URL,
  OpenRouterClassifier,
  RETRY_DELAY_MS,
} from "./openrouter.ts";
import { MAX_REASON_CHARS } from "./prompt.ts";

const INPUT = { title: "SWE Intern", company: "Acme", description: "Pursuing a BS/MS." };
const GOOD = { degree_ok: "yes", work_auth: "none", reason: "Says BS/MS." };

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 500, completion_tokens: 40 },
    ...extra,
  });
}

function response(status: number, body = completion(JSON.stringify(GOOD))): FetchResponse {
  return { status, text: async () => body };
}

/** A fake clock plus a sleep that advances it, and a fetch whose replies are scripted. */
function harness(replies: (FetchResponse | Error)[]) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  });
  const queue = [...replies];
  const fetch = vi.fn<Fetch>(async () => {
    t += 250;
    const reply = queue.shift();
    if (reply === undefined) throw new Error("fetch called with no scripted reply");
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const classifier = new OpenRouterClassifier({
    apiKey: "sk-test",
    model: "test/model",
    program: "test program",
    graduation: "May 2028",
    fetch,
    sleep,
    now: () => t,
    // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
    log: log as any,
  });
  return { classifier, fetch, sleeps, log };
}

const UNCLEAR = (cause: string) => ({
  verdict: { degreeOk: "unclear", workAuth: "unclear", reason: `classifier error: ${cause}` },
  error: cause,
});

describe("OpenRouterClassifier happy path", () => {
  it("returns the model's verdict with error null", async () => {
    const h = harness([response(200)]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual({
      verdict: { degreeOk: "yes", workAuth: "none", reason: "Says BS/MS." },
      error: null,
    });
    expect(h.sleeps).toEqual([]);
  });

  it("posts the model, messages, temperature 0, max_tokens, and strict json_schema", async () => {
    const h = harness([response(200)]);
    await h.classifier.classify(INPUT);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      "X-Title": "WALIA",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test/model");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: expect.any(String), strict: true },
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("test program");
    expect(body.messages[1].content).toContain("Pursuing a BS/MS.");
  });

  it("logs model, status, elapsed, tokens, verdict, and attempt", async () => {
    const h = harness([response(200)]);
    await h.classifier.classify(INPUT);
    expect(h.log.info).toHaveBeenCalledOnce();
    expect(h.log.info.mock.calls[0]?.[0]).toMatchObject({
      model: "test/model",
      status: 200,
      elapsedMs: 250,
      promptTokens: 500,
      completionTokens: 40,
      degreeOk: "yes",
      workAuth: "none",
      attempt: 1,
    });
  });

  it("caps a long reason", async () => {
    const reason = "r".repeat(MAX_REASON_CHARS + 50);
    const h = harness([response(200, completion(JSON.stringify({ ...GOOD, reason })))]);
    const { verdict } = await h.classifier.classify(INPUT);
    expect(verdict.reason).toHaveLength(MAX_REASON_CHARS);
  });

  it("accepts fenced JSON from a model that ignores json_schema", async () => {
    const fenced = `\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``;
    const h = harness([response(200, completion(fenced))]);
    const { verdict, error } = await h.classifier.classify(INPUT);
    expect(error).toBeNull();
    expect(verdict.degreeOk).toBe("yes");
  });
});

describe("OpenRouterClassifier retry", () => {
  it("abort twice gives timeout after one retry at RETRY_DELAY_MS", async () => {
    const abort = () => new DOMException("The operation was aborted", "TimeoutError");
    const h = harness([abort(), abort()]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("timeout"));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it("a network error gives network", async () => {
    const h = harness([new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("network"));
  });

  it("503 then 200 succeeds", async () => {
    const h = harness([response(503, "upstream down"), response(200)]);
    const { verdict, error } = await h.classifier.classify(INPUT);
    expect(error).toBeNull();
    expect(verdict.degreeOk).toBe("yes");
    expect(h.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(h.log.info.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, status: 200 });
  });

  it("429 twice gives http 429", async () => {
    const h = harness([response(429, "{}"), response(429, "{}")]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("http 429"));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("400 makes one fetch call and no sleep", async () => {
    const h = harness([response(400, '{"error":"bad request"}')]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("http 400"));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it("carries the second attempt's cause when the two differ", async () => {
    const h = harness([response(502, ""), new TypeError("fetch failed")]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("network"));
  });
});

describe("OpenRouterClassifier bad replies", () => {
  it("empty choices gives empty response without retry", async () => {
    const h = harness([response(200, JSON.stringify({ choices: [], usage: {} }))]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("empty response"));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("null content gives empty response", async () => {
    const h = harness([response(200, completion(null))]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("empty response"));
  });

  it("an invalid enum gives unparsable output", async () => {
    const h = harness([
      response(200, completion(JSON.stringify({ ...GOOD, degree_ok: "probably" }))),
    ]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("unparsable output"));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a non-JSON body gives unparsable output", async () => {
    const h = harness([response(200, "<html>gateway</html>")]);
    await expect(h.classifier.classify(INPUT)).resolves.toEqual(UNCLEAR("unparsable output"));
  });
});
