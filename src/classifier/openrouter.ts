import type { Logger } from "pino";
import { log as rootLog } from "../log.ts";
import { buildMessages, parseVerdict, VERDICT_JSON_SCHEMA } from "./prompt.ts";
import type { Classifier, ClassifyInput, ClassifyResult, Verdict } from "./types.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const REQUEST_TIMEOUT_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;
export const MAX_TOKENS = 300;

/** The parts of a fetch Response the client reads. Tests build these directly. */
export type FetchResponse = Pick<Response, "status" | "text">;
export type Fetch = (url: string, init: RequestInit) => Promise<FetchResponse>;

export interface OpenRouterClassifierOptions {
  apiKey: string;
  model: string;
  program: string;
  graduation: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms. */
  now?: () => number;
  log?: Logger;
}

/** Short fixed strings stored in `classifier_reason` after "classifier error: ". */
export type FailureCause =
  | "timeout"
  | "network"
  | `http ${number}`
  | "unparsable output"
  | "empty response";

type Attempt =
  | { ok: true; verdict: Verdict }
  | { ok: false; cause: FailureCause; retry: boolean; err?: unknown };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plain-fetch client for OpenRouter chat completions. One POST per `classify`, one retry after
 * RETRY_DELAY_MS on network error, timeout, 429, or 5xx. Any failure yields an `unclear` verdict
 * with the cause in `reason`; it never throws.
 */
export class OpenRouterClassifier implements Classifier {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly facts: { program: string; graduation: string };
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(opts: OpenRouterClassifierOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.facts = { program: opts.program, graduation: opts.graduation };
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? rootLog.child({ component: "classifier" });
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const first = await this.attempt(input, 1);
    if (first.ok) return { verdict: first.verdict, error: null };
    if (first.retry) {
      this.log.warn(
        { title: input.title, company: input.company, cause: first.cause, err: first.err },
        "classifier call failed, retrying once",
      );
      await this.sleep(RETRY_DELAY_MS);
      const second = await this.attempt(input, 2);
      if (second.ok) return { verdict: second.verdict, error: null };
      return this.fallback(input, second);
    }
    return this.fallback(input, first);
  }

  private fallback(input: ClassifyInput, failed: Extract<Attempt, { ok: false }>): ClassifyResult {
    this.log.warn(
      { title: input.title, company: input.company, cause: failed.cause, err: failed.err },
      "classifier gave up, storing unclear",
    );
    return {
      verdict: {
        degreeOk: "unclear",
        workAuth: "unclear",
        reason: `classifier error: ${failed.cause}`,
      },
      error: failed.cause,
    };
  }

  private async attempt(input: ClassifyInput, attempt: number): Promise<Attempt> {
    const started = this.now();
    const base = { model: this.model, attempt, title: input.title, company: input.company };
    let res: FetchResponse;
    try {
      res = await this.fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "WALIA",
        },
        body: JSON.stringify({
          model: this.model,
          messages: buildMessages(this.facts, input),
          temperature: 0,
          max_tokens: MAX_TOKENS,
          response_format: { type: "json_schema", json_schema: VERDICT_JSON_SCHEMA },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const cause: FailureCause = isAbort(err) ? "timeout" : "network";
      this.log.info(
        { ...base, status: null, elapsedMs: this.now() - started, cause },
        "openrouter request failed",
      );
      return { ok: false, cause, retry: true, err };
    }

    const elapsedMs = this.now() - started;
    const status = res.status;
    if (status !== 200) {
      this.log.info({ ...base, status, elapsedMs }, "openrouter request");
      return { ok: false, cause: `http ${status}`, retry: status === 429 || status >= 500 };
    }

    const body = parseBody(await res.text());
    const usage = body?.usage;
    const tokens = {
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
    };
    const content = body?.choices?.[0]?.message?.content;
    if (body === null) {
      this.log.info({ ...base, status, elapsedMs }, "openrouter request");
      return { ok: false, cause: "unparsable output", retry: false };
    }
    if (typeof content !== "string" || content.trim() === "") {
      this.log.info({ ...base, status, elapsedMs, ...tokens }, "openrouter request");
      return { ok: false, cause: "empty response", retry: false };
    }
    const verdict = parseVerdict(content);
    if (verdict === null) {
      this.log.info(
        { ...base, status, elapsedMs, ...tokens, content: content.slice(0, 200) },
        "openrouter request",
      );
      return { ok: false, cause: "unparsable output", retry: false };
    }
    this.log.info(
      {
        ...base,
        status,
        elapsedMs,
        ...tokens,
        degreeOk: verdict.degreeOk,
        workAuth: verdict.workAuth,
      },
      "openrouter request",
    );
    return { ok: true, verdict };
  }
}

interface CompletionBody {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseBody(text: string): CompletionBody | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as CompletionBody) : null;
  } catch {
    return null;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
