import { join } from "node:path";
import { createClassifier } from "./classifier/index.ts";
import { type Config, ConfigError, type Env, loadConfig, parseEnv } from "./config.ts";
import { Loop, openStore, renameLegacyStore } from "./core/index.ts";
import { log } from "./log.ts";
import { Alerter, createNotifier } from "./notifier/index.ts";
import { startHealthServer } from "./ops/health.ts";
import { LinkedInClient } from "./scraper/index.ts";

const SHUTDOWN_DEADLINE_MS = 10_000;

function boot(): { env: Env; config: Config } {
  try {
    const env = parseEnv();
    const config = loadConfig(env.CONFIG_PATH);
    return { env, config };
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error({ issues: err.issues }, err.message);
    } else {
      log.error({ err }, (err as Error).message);
    }
    process.exit(1);
  }
}

const { env, config } = boot();

log.info(
  {
    searches: config.searches.map((s) => s.label),
    pollIntervalSec: config.pollIntervalSec,
    recencySec: config.recencySec,
    model: config.classifier.model,
    graduation: config.classifier.graduation,
    term: config.classifier.term,
    fields: config.classifier.fields,
    reasoningEffort: config.classifier.reasoningEffort,
    notifier: config.notifier,
    dataDir: env.DATA_DIR,
    port: env.PORT,
    proxy: env.PROXY_URL !== undefined,
  },
  "config loaded",
);

renameLegacyStore(env.DATA_DIR);
const store = openStore(join(env.DATA_DIR, "malja.db"));
const client = new LinkedInClient({ proxyUrl: env.PROXY_URL });
const classifier = createClassifier(config, env);
const notifier = createNotifier(config, env);
try {
  await notifier.start();
} catch (err) {
  log.error({ err }, "notifier failed to start");
  process.exit(1);
}
const alerter = new Alerter(notifier);
const loop = new Loop({ config, store, client, notifier, classifier, alerter });
const health = await startHealthServer(env.PORT, () => loop.status());

let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    log.warn({ signal }, "second signal, exiting now");
    process.exit(1);
  }
  stopping = true;
  log.info({ signal, deadlineMs: SHUTDOWN_DEADLINE_MS }, "shutting down");
  setTimeout(() => {
    log.error("shutdown deadline passed, forcing exit");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  await loop.stop();
  await health.close();
  await notifier.stop();
  store.close();
  log.info("stopped");
  process.exit(0);
}
process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

loop.start();
