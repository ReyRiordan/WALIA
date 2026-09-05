import pino from "pino";

/** Root logger. JSON to stdout; level from LOG_LEVEL. Secrets are redacted by path. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "TELEGRAM_BOT_TOKEN",
      "OPENROUTER_API_KEY",
      "env.TELEGRAM_BOT_TOKEN",
      "env.OPENROUTER_API_KEY",
      "*.TELEGRAM_BOT_TOKEN",
      "*.OPENROUTER_API_KEY",
    ],
    censor: "[redacted]",
  },
});
