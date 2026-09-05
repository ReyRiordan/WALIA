import { type Config, ConfigError, type Env, loadConfig, parseEnv } from "./config.ts";
import { log } from "./log.ts";

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
    notifier: config.notifier,
    dataDir: env.DATA_DIR,
    port: env.PORT,
  },
  "config loaded",
);
process.exit(0);
