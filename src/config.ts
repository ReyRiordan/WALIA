import { readFileSync } from "node:fs";
import { z } from "zod";
import { log } from "./log.ts";

const LINKEDIN_HOST = "www.linkedin.com";
const SEARCH_PATHS = new Set(["/jobs/search/", "/jobs/search-results/"]);

/** Query params the browser adds that carry no search semantics. Dropped on parse. */
const STRIPPED_PARAMS = new Set([
  "origin",
  "trk",
  "currentJobId",
  "referralSearchId",
  "position",
  "pageNum",
  "start",
  "f_TPR",
]);

const positiveInt = z.int().positive();

const SearchInput = z.object({
  url: z.string(),
  label: z.string().min(1).optional(),
});

const SearchSchema = SearchInput.transform((input, ctx) => {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    ctx.addIssue({ code: "custom", message: "not a valid URL", path: ["url"] });
    return z.NEVER;
  }
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (url.host !== LINKEDIN_HOST || !SEARCH_PATHS.has(path)) {
    ctx.addIssue({
      code: "custom",
      message: `expected https://${LINKEDIN_HOST}/jobs/search/ or /jobs/search-results/`,
      path: ["url"],
    });
    return z.NEVER;
  }
  const keywords = url.searchParams.get("keywords")?.trim();
  if (!keywords) {
    ctx.addIssue({ code: "custom", message: "url has no keywords param", path: ["url"] });
    return z.NEVER;
  }
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key === "keywords" || STRIPPED_PARAMS.has(key)) continue;
    params[key] = value;
  }
  params.sortBy = "DD";
  return {
    label: input.label ?? keywords,
    keywords,
    params,
    /** Raw f_TPR from the URL, if any. Compared against recencySec at the config level. */
    urlTpr: url.searchParams.get("f_TPR"),
  };
});

export const ConfigSchema = z
  .object({
    searches: z.array(SearchSchema).min(1),
    pollIntervalSec: positiveInt.min(60).default(300),
    recencySec: positiveInt.default(3600),
    firstCycleRecencySec: positiveInt.default(600),
    maxPages: positiveInt.default(5),
    classifier: z.object({
      model: z.string().min(1),
      /** Who the students are, in prose. Goes into the prompt verbatim. */
      program: z.string().min(1),
      /** Expected graduation, e.g. "May 2028". Goes into the prompt verbatim. */
      graduation: z.string().min(1),
    }),
    dedupe: z.object({ windowDays: positiveInt.default(14) }).default({ windowDays: 14 }),
    notifier: z.enum(["telegram"]).default("telegram"),
  })
  .transform((config) => ({
    ...config,
    searches: config.searches.map(({ urlTpr, ...search }) => {
      if (urlTpr !== null && urlTpr !== `r${config.recencySec}`) {
        log.warn(
          { label: search.label, urlTpr, recencySec: config.recencySec },
          "search url f_TPR ignored; recencySec in config wins",
        );
      }
      return search;
    }),
  }));

export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_GROUP_CHAT_ID: z.string().min(1),
  TELEGRAM_ADMIN_CHAT_ID: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  DATA_DIR: z.string().min(1).default("./data"),
  CONFIG_PATH: z.string().min(1).default("./config.json"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  PORT: z.coerce.number().int().positive().default(3000),
  PROXY_URL: z.url().optional(),
});

export type Config = z.output<typeof ConfigSchema>;
export type Env = z.output<typeof EnvSchema>;
export type Search = Config["searches"][number];

export class ConfigError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(source: string, error: z.ZodError) {
    const issues = error.issues.map((i) => ({
      path: i.path.map(String).join(".") || "(root)",
      message: i.message,
    }));
    super(`invalid ${source}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) throw new ConfigError("env", result.error);
  return result.data;
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigError("config", result.error);
  return result.data;
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read config at ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
