import type { Config, Env } from "../config.ts";
import { TelegramNotifier } from "./telegram.ts";
import type { Notifier } from "./types.ts";

/** Picks the adapter from `config.notifier`. `src/index.ts` never imports grammY. */
export function createNotifier(config: Config, env: Env): Notifier {
  switch (config.notifier) {
    case "telegram":
      return new TelegramNotifier({
        token: env.TELEGRAM_BOT_TOKEN,
        groupChatId: env.TELEGRAM_GROUP_CHAT_ID,
        adminChatId: env.TELEGRAM_ADMIN_CHAT_ID,
      });
  }
}

export { ALERT_INTERVAL_MS, type AlertCondition, Alerter, type AlerterOptions } from "./alerts.ts";
export { escapeHtml, formatNotification, toNotification } from "./format.ts";
export {
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_SEC,
  READY_RETRY_MS,
  TelegramNotifier,
  type TelegramNotifierOptions,
} from "./telegram.ts";
export type { Notification, Notifier, Tag } from "./types.ts";
