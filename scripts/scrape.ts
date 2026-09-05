/**
 * Manual scrape of one configured search against real LinkedIn. Optionally tees raw responses
 * into test/fixtures/, or writes every job with a description as an unlabelled eval file. Usage:
 *   pnpm scrape [--search <label>] [--pages <n>] [--recency <sec>] [--save-fixtures] [--save-eval]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, parseEnv } from "../src/config.ts";
import { log } from "../src/log.ts";
import {
  buildSearchUrl,
  type Fetch,
  JOB_FRAGMENT_URL,
  JOB_VIEW_URL,
  LinkedInClient,
  parseCards,
  SEARCH_URL,
  scrapeSearch,
} from "../src/scraper/index.ts";

const { values: args } = parseArgs({
  options: {
    search: { type: "string" },
    pages: { type: "string", default: "1" },
    recency: { type: "string" },
    "save-fixtures": { type: "boolean", default: false },
    "save-eval": { type: "boolean", default: false },
  },
});

const env = parseEnv();
const config = loadConfig(env.CONFIG_PATH);
const search = args.search
  ? config.searches.find((s) => s.label === args.search)
  : config.searches[0];
if (!search) {
  log.error({ label: args.search }, "no search with that label");
  process.exit(1);
}
const maxPages = Number.parseInt(args.pages, 10);
if (!Number.isInteger(maxPages) || maxPages < 1) {
  log.error({ pages: args.pages }, "--pages must be a positive integer");
  process.exit(1);
}
const recencySec = args.recency ? Number.parseInt(args.recency, 10) : config.recencySec;
if (!Number.isInteger(recencySec) || recencySec < 1) {
  log.error({ recency: args.recency }, "--recency must be a positive integer of seconds");
  process.exit(1);
}

const FIXTURE_DIR = new URL("../test/fixtures/", import.meta.url);
const EVAL_DIR = new URL("../test/eval/eligibility/", import.meta.url);
const saveFixtures = args["save-fixtures"];
const saveEval = args["save-eval"];
let firstCardId: string | null = null;

/** Map a request URL to a fixture name, or null for requests that are not captured. */
function fixtureName(url: string): string | null {
  if (url.startsWith(SEARCH_URL)) {
    const start = new URL(url).searchParams.get("start");
    if (start === "0") return "search-page0.html";
    if (start === "990") return "search-empty.html";
    return null;
  }
  if (url.startsWith(JOB_VIEW_URL) && url.endsWith(`/${firstCardId}`)) return "job-view.html";
  if (url.startsWith(JOB_FRAGMENT_URL) && url.endsWith(`/${firstCardId}`)) {
    return "job-fragment.html";
  }
  return null;
}

const realFetch: Fetch = (url, init) => globalThis.fetch(url, init);
const teeFetch: Fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (res.status !== 200) return res;
  const body = await res.text();
  if (url.startsWith(SEARCH_URL) && new URL(url).searchParams.get("start") === "0") {
    firstCardId = parseCards(body)[0]?.id ?? null;
  }
  const name = fixtureName(url);
  if (name) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(new URL(name, FIXTURE_DIR), body);
    log.info({ fixture: name, bytes: body.length }, "fixture written");
  }
  return { status: res.status, url: res.url, text: async () => body };
};

const client = new LinkedInClient({
  fetch: saveFixtures ? teeFetch : realFetch,
  ...(env.PROXY_URL ? { proxyUrl: env.PROXY_URL } : {}),
});
client.beginCycle();

const result = await scrapeSearch(client, search, {
  recencySec,
  maxPages,
  isSeen: () => false,
});

for (const job of result.jobs) {
  log.info(
    {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      postedAt: job.postedAt?.toISOString() ?? null,
      skip: job.skip ?? null,
      descriptionLength: job.description?.length ?? 0,
    },
    "job",
  );
}
log.info(
  {
    label: search.label,
    recencySec,
    jobs: result.jobs.length,
    cardsOnFirstPage: result.cardsOnFirstPage,
    deferred: result.deferred,
    halted: result.halted ? { name: result.halted.name, url: result.halted.url } : null,
  },
  "scrape finished",
);

if (saveEval) {
  // One unlabelled file per job with a description. Existing files are never overwritten, so
  // hand labels survive a re-run. See docs/classifier/eval.md.
  mkdirSync(EVAL_DIR, { recursive: true });
  let written = 0;
  for (const job of result.jobs) {
    if (!job.description) continue;
    const file = new URL(`${job.id}.json`, EVAL_DIR);
    if (existsSync(file)) continue;
    const entry = {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      description: job.description,
      expected: { relevant: null, degreeOk: null, workAuth: null },
      note: "",
    };
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
    written += 1;
  }
  log.info({ written, dir: EVAL_DIR.pathname }, "eval files written");
}

if (saveFixtures) {
  // The fragment is captured even when JSON-LD succeeded, and the empty page needs a request
  // scrapeSearch would never make. Both are best-effort: a thrown error here is reported, not fatal.
  client.beginCycle();
  try {
    if (firstCardId) await client.get(`${JOB_FRAGMENT_URL}${firstCardId}`);
    await client.get(buildSearchUrl(search, recencySec, 990));
  } catch (err) {
    log.error({ err }, "extra fixture request failed");
  }
}
