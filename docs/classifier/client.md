# OpenRouter client

Code: `src/classifier/openrouter.ts`, `src/classifier/index.ts` (factory).

```ts
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
REQUEST_TIMEOUT_MS = 30_000
RETRY_DELAY_MS = 2_000
MAX_TOKENS = 1_000

interface OpenRouterClassifierOptions {
  apiKey: string; model: string; program: string; graduation: string; term: string; fields: string;
  reasoningEffort?: ReasoningEffort;
  fetch?: Fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: Logger;
}
class OpenRouterClassifier implements Classifier { classify(input): Promise<ClassifyResult> }

createClassifier(config: Config, env: Env, opts?: Partial<OpenRouterClassifierOptions>): Classifier
```

## Transport

Plain `fetch`, no SDK. One POST per `classify`. Headers: `Authorization: Bearer`, `Content-Type: application/json`, `X-Title: WALIA`. Body: `model`, `messages` from `buildMessages`, `temperature: 0`, `max_tokens`, `response_format` with the strict schema, and `reasoning: { effort }` when `classifier.reasoningEffort` is set.

`fetch`, `sleep`, `now`, and the logger are injected, the same construction as `LinkedInClient`, so tests script replies and never touch the network.

## Reasoning effort and MAX_TOKENS

`classifier.reasoningEffort` in config.json is OpenRouter's unified `reasoning.effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`), default `low`. Reasoning tokens count against `max_tokens`. Observed on `openai/gpt-5.6-luna` with the eval set:

| Effort | Reasoning tokens | Total completion tokens | Result |
| --- | --- | --- | --- |
| default (unset) | 100 to 300+ | up to the cap | one posting hit `finish_reason: length` at a 300 cap with no content |
| `low` | 0 to 101 | 47 to 171 | every answered call parsed |

`MAX_TOKENS` is 1000, several times the largest observed spend at `low`. Raise it before raising the effort.

## Timeout and retry

| Outcome of the first attempt | Then |
| --- | --- |
| Network error, or abort after 30 s | sleep 2 s, one retry |
| HTTP 429 or 5xx | sleep 2 s, one retry |
| HTTP 200 whose body is `{ error: { code } }` with code 429 or 5xx | sleep 2 s, one retry |
| Any other 4xx, or such an error body with another code | no retry |
| 200 with a body that does not parse to a verdict | no retry |

OpenRouter wraps upstream provider errors in a 200 body with an `error` object. The client reads `error.code` as the status for the cause string and the retry rule. The second attempt's cause wins when the two differ.

## Failure yields unclear, never throws

Any failure returns `{ relevant: "unclear", degreeOk: "unclear", workAuth: "unclear", reason: "classifier error: <cause>" }`. `relevant: unclear` sends the group, so an OpenRouter outage never suppresses a job. The cause is one of these fixed strings:

| Cause | Meaning |
| --- | --- |
| `timeout` | the fetch aborted at `REQUEST_TIMEOUT_MS` |
| `network` | the fetch threw for any other reason |
| `http <status>` | a non-200 status, or the code from a 200 error body |
| `unparsable output` | the body was not JSON, or the content failed `parseVerdict` |
| `empty response` | no `choices`, or `content` null or blank (includes a reasoning model that ran out of tokens before answering) |

## ClassifyResult

```ts
interface ClassifyResult { verdict: Verdict; error: string | null }
```

`error` is null on a real model answer and the cause string on the fallback. The loop stores `verdict` either way, so the audit row shows the cause, and counts consecutive non-null errors for the `classifier_down` alert. Detection stays in the loop, as with the scraper; the classifier keeps no counters.

There is no code-level spend cap. The scraper's request budget bounds new jobs per cycle to about a dozen, so calls are bounded too. `max_tokens` caps output and a monthly limit on the OpenRouter key is the backstop.

## Logging

One `info` line per attempt with `model`, `reasoningEffort`, `attempt`, `title`, `company`, `status`, `elapsedMs`, `promptTokens`, `completionTokens`, `reasoningTokens`, and on success `relevant`, `degreeOk`, and `workAuth`. An empty reply logs `finishReason`; an error body logs `upstream` and `message`. A retry and the final fallback log at `warn` with the cause. The API key is never logged; `src/log.ts` also redacts it by path.

## Factory

`createClassifier(config, env, opts?)` builds an `OpenRouterClassifier` from `env.OPENROUTER_API_KEY` and `config.classifier`. `opts` overrides any option, which is how scripts and tests inject a fetch or a clock.
