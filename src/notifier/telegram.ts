import { autoRetry } from "@grammyjs/auto-retry";
import { Api, GrammyError, type Transformer } from "grammy";
import type { Logger } from "pino";
import { log as rootLog } from "../log.ts";
import { formatNotification } from "./format.ts";
import type { Notification, Notifier } from "./types.ts";

/** Telegram 429 handling: sleep for `retry_after`, at most this many times, each wait at most this long. */
export const MAX_RETRY_ATTEMPTS = 3;
export const MAX_RETRY_DELAY_SEC = 60;
/** How long to wait between readiness probes after the bot lost the group. */
export const READY_RETRY_MS = 5 * 60 * 1000;

export interface TelegramNotifierOptions {
  token: string;
  groupChatId: string;
  adminChatId: string;
  readyRetryMs?: number;
  /** Installed before auto-retry, so a canned transformer in tests sits under it. */
  transformers?: Transformer[];
  log?: Logger;
}

/** The bot can no longer post to the group. Nothing short of a human re-adding it will fix this. */
function lostGroup(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code === 403 && /kicked/i.test(err.description)) return true;
  return err.error_code === 400 && /chat not found/i.test(err.description);
}

export class TelegramNotifier implements Notifier {
  /** Exposed so tests can install a transformer. */
  readonly api: Api;
  private readonly groupChatId: string;
  private readonly adminChatId: string;
  private readonly readyRetryMs: number;
  private readonly log: Logger;
  private ready = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(opts: TelegramNotifierOptions) {
    this.api = new Api(opts.token);
    this.api.config.use(
      ...(opts.transformers ?? []),
      autoRetry({
        maxRetryAttempts: MAX_RETRY_ATTEMPTS,
        maxDelaySeconds: MAX_RETRY_DELAY_SEC,
        // Network errors would otherwise retry with unbounded backoff. Let them surface.
        rethrowHttpErrors: true,
      }),
    );
    this.groupChatId = opts.groupChatId;
    this.adminChatId = opts.adminChatId;
    this.readyRetryMs = opts.readyRetryMs ?? READY_RETRY_MS;
    this.log = opts.log ?? rootLog.child({ component: "notifier" });
  }

  /** One `getMe` so a bad token fails boot. No long polling: nothing in v1 receives updates. */
  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.ready = true;
    this.log.info({ username: me.username }, "telegram bot ready");
  }

  isReady(): boolean {
    return this.ready;
  }

  async send(n: Notification): Promise<{ messageId: string }> {
    try {
      const result = await this.api.sendMessage(this.groupChatId, formatNotification(n), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return { messageId: String(result.message_id) };
    } catch (err) {
      if (lostGroup(err)) this.markLost(err);
      throw err;
    }
  }

  /** Plain text, no parse mode. Logs and swallows, since an alert about a failure must not fail. */
  async sendAdmin(text: string): Promise<void> {
    try {
      await this.api.sendMessage(this.adminChatId, text);
    } catch (err) {
      this.log.error({ err }, "admin message failed");
    }
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private markLost(err: unknown): void {
    if (!this.ready) return;
    this.ready = false;
    this.log.error({ err, readyRetryMs: this.readyRetryMs }, "bot lost the group; sends paused");
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.retryTimer = setTimeout(() => void this.probe(), this.readyRetryMs);
    this.retryTimer.unref();
  }

  /** `getMe` plus `getChat(group)`. Success flips `isReady` back; failure reschedules. */
  private async probe(): Promise<void> {
    this.retryTimer = null;
    try {
      await this.api.getMe();
      await this.api.getChat(this.groupChatId);
      this.ready = true;
      this.log.info("bot can see the group again; sends resumed");
    } catch (err) {
      this.log.warn({ err, readyRetryMs: this.readyRetryMs }, "readiness probe failed");
      this.scheduleProbe();
    }
  }
}
