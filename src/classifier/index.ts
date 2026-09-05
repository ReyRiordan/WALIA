import type { Config, Env } from "../config.ts";
import { OpenRouterClassifier, type OpenRouterClassifierOptions } from "./openrouter.ts";
import type { Classifier } from "./types.ts";

/** Builds the classifier from config and env. `opts` lets scripts and tests inject fetch or a clock. */
export function createClassifier(
  config: Config,
  env: Env,
  opts: Partial<OpenRouterClassifierOptions> = {},
): Classifier {
  return new OpenRouterClassifier({
    apiKey: env.OPENROUTER_API_KEY,
    model: config.classifier.model,
    program: config.classifier.program,
    graduation: config.classifier.graduation,
    ...opts,
  });
}

export {
  type FailureCause,
  type Fetch,
  type FetchResponse,
  MAX_TOKENS,
  OPENROUTER_URL,
  OpenRouterClassifier,
  type OpenRouterClassifierOptions,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
} from "./openrouter.ts";
export {
  buildMessages,
  type ChatMessage,
  MAX_DESCRIPTION_CHARS,
  MAX_REASON_CHARS,
  type ProgramFacts,
  parseVerdict,
  truncateDescription,
  VERDICT_JSON_SCHEMA,
  VerdictSchema,
} from "./prompt.ts";
export type {
  Classifier,
  ClassifyInput,
  ClassifyResult,
  DegreeOk,
  Verdict,
  WorkAuth,
} from "./types.ts";
