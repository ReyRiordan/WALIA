import { describe, expect, it, vi } from "vitest";

vi.mock("./log.ts", () => ({ log: { warn: vi.fn() } }));

import { ConfigError, parseConfig, parseEnv } from "./config.ts";
import { log } from "./log.ts";

const BASE = "https://www.linkedin.com/jobs/search/";
const CLASSIFIER = {
  model: "test/model",
  program: "test program",
  graduation: "May 2028",
  term: "summer 2027",
  fields: "software engineering",
};

function config(url: string, extra: Record<string, unknown> = {}) {
  return parseConfig({
    searches: [{ url }],
    classifier: CLASSIFIER,
    ...extra,
  });
}

/** Parse a single-search config and return that search. */
function search(url: string, label?: string) {
  const c = parseConfig({ searches: [{ url, label }], classifier: CLASSIFIER });
  const s = c.searches[0];
  if (!s) throw new Error("no search parsed");
  return s;
}

describe("search url parsing", () => {
  it("strips junk params and keeps keywords", () => {
    const s = search(
      `${BASE}?keywords=swe%20intern&origin=JOB_SEARCH_PAGE&trk=x&currentJobId=1&referralSearchId=2&position=3&pageNum=0`,
    );
    expect(s.keywords).toBe("swe intern");
    expect(s.params).toEqual({ sortBy: "DD" });
  });

  it("removes f_TPR and start", () => {
    expect(search(`${BASE}?keywords=x&f_TPR=r3600&start=25`).params).toEqual({ sortBy: "DD" });
  });

  it("forces sortBy to DD", () => {
    expect(search(`${BASE}?keywords=x&sortBy=R`).params.sortBy).toBe("DD");
  });

  it("passes geoId and f_E through", () => {
    expect(search(`${BASE}?keywords=x&geoId=103644278&f_E=1`).params).toEqual({
      geoId: "103644278",
      f_E: "1",
      sortBy: "DD",
    });
  });

  it("accepts /jobs/search-results/", () => {
    expect(
      search("https://www.linkedin.com/jobs/search-results/?keywords=x&geoId=1").params.geoId,
    ).toBe("1");
  });

  it("rejects other paths and hosts", () => {
    expect(() => config("https://www.linkedin.com/jobs/view/123?keywords=x")).toThrow(ConfigError);
    expect(() => config("https://linkedin.com/jobs/search/?keywords=x")).toThrow(ConfigError);
    expect(() => config("not a url")).toThrow(ConfigError);
  });

  it("rejects a url without keywords", () => {
    expect(() => config(`${BASE}?geoId=1`)).toThrow(/keywords/);
    expect(() => config(`${BASE}?keywords=`)).toThrow(/keywords/);
  });

  it("defaults label to the keywords", () => {
    expect(search(`${BASE}?keywords=%22summer%202027%22%20intern`).label).toBe(
      '"summer 2027" intern',
    );
    expect(search(`${BASE}?keywords=x`, "mine").label).toBe("mine");
  });

  it("warns when the url f_TPR differs from recencySec", () => {
    vi.mocked(log.warn).mockClear();
    config(`${BASE}?keywords=x&f_TPR=r86400`);
    expect(log.warn).toHaveBeenCalledOnce();
    vi.mocked(log.warn).mockClear();
    config(`${BASE}?keywords=x&f_TPR=r3600`);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("config defaults and bounds", () => {
  it("applies defaults", () => {
    const c = config(`${BASE}?keywords=x`);
    expect(c).toMatchObject({
      pollIntervalSec: 300,
      recencySec: 3600,
      firstCycleRecencySec: 600,
      maxPages: 5,
      dedupe: { windowDays: 14 },
      notifier: "telegram",
    });
  });

  it.each(["model", "program", "graduation", "term", "fields"] as const)(
    "requires classifier.%s",
    (field) => {
      const { [field]: removed, ...rest } = CLASSIFIER;
      expect(removed).toBeDefined();
      expect(() => config(`${BASE}?keywords=x`, { classifier: rest })).toThrow(
        new RegExp(`classifier\\.${field}`),
      );
      expect(() => config(`${BASE}?keywords=x`, { classifier: { ...rest, [field]: "" } })).toThrow(
        new RegExp(`classifier\\.${field}`),
      );
    },
  );

  it("requires the classifier block", () => {
    expect(() => parseConfig({ searches: [{ url: `${BASE}?keywords=x` }] })).toThrow(/classifier/);
  });

  it("defaults classifier.reasoningEffort to low and rejects unknown values", () => {
    expect(config(`${BASE}?keywords=x`).classifier.reasoningEffort).toBe("low");
    expect(
      config(`${BASE}?keywords=x`, { classifier: { ...CLASSIFIER, reasoningEffort: "none" } })
        .classifier.reasoningEffort,
    ).toBe("none");
    expect(() =>
      config(`${BASE}?keywords=x`, { classifier: { ...CLASSIFIER, reasoningEffort: "max" } }),
    ).toThrow(/classifier\.reasoningEffort/);
  });

  it("enforces the pollIntervalSec floor", () => {
    expect(() => config(`${BASE}?keywords=x`, { pollIntervalSec: 59 })).toThrow(/pollIntervalSec/);
    expect(config(`${BASE}?keywords=x`, { pollIntervalSec: 60 }).pollIntervalSec).toBe(60);
  });

  it("rejects non-positive integers and unknown notifiers", () => {
    expect(() => config(`${BASE}?keywords=x`, { maxPages: 0 })).toThrow(/maxPages/);
    expect(() => config(`${BASE}?keywords=x`, { recencySec: 1.5 })).toThrow(/recencySec/);
    expect(() => config(`${BASE}?keywords=x`, { notifier: "whatsapp" })).toThrow(/notifier/);
  });

  it("collects every issue in one error", () => {
    try {
      parseConfig({ searches: [{ url: `${BASE}?geoId=1` }], pollIntervalSec: 1 });
      expect.unreachable();
    } catch (err) {
      const issues = (err as ConfigError).issues.map((i) => i.path);
      expect(issues).toContain("searches.0.url");
      expect(issues).toContain("pollIntervalSec");
      expect(issues).toContain("classifier");
    }
  });
});

describe("env", () => {
  const required = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_GROUP_CHAT_ID: "-100",
    TELEGRAM_ADMIN_CHAT_ID: "42",
    OPENROUTER_API_KEY: "k",
  };

  it("applies defaults and keeps chat ids as strings", () => {
    const env = parseEnv(required);
    expect(env).toMatchObject({
      DATA_DIR: "./data",
      CONFIG_PATH: "./config.json",
      LOG_LEVEL: "info",
      PORT: 3000,
      TELEGRAM_GROUP_CHAT_ID: "-100",
    });
    expect(env.PROXY_URL).toBeUndefined();
  });

  it("lists every missing secret", () => {
    try {
      parseEnv({ TELEGRAM_BOT_TOKEN: "t" });
      expect.unreachable();
    } catch (err) {
      const paths = (err as ConfigError).issues.map((i) => i.path);
      expect(paths).toEqual([
        "TELEGRAM_GROUP_CHAT_ID",
        "TELEGRAM_ADMIN_CHAT_ID",
        "OPENROUTER_API_KEY",
      ]);
    }
  });

  it("coerces PORT and validates PROXY_URL", () => {
    expect(parseEnv({ ...required, PORT: "8080" }).PORT).toBe(8080);
    expect(() => parseEnv({ ...required, PROXY_URL: "nope" })).toThrow(/PROXY_URL/);
  });
});
