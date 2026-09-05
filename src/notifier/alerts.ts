import type { Logger } from "pino";
import { log as rootLog } from "../log.ts";
import type { Notifier } from "./types.ts";

/**
 * Conditions the loop detects. `rate_limited` and `blocked` match the scraper's error
 * signals so `halted.signal` maps straight through.
 */
export type AlertCondition =
  | "rate_limited"
  | "blocked"
  | "no_cards"
  | "send_failed"
  | "classifier_down";

export const ALERT_INTERVAL_MS = 60 * 60 * 1000;

export interface AlerterOptions {
  intervalMs?: number;
  now?: () => number;
  log?: Logger;
}

/** Throttles admin alerts to one per condition per interval. Detection lives in the loop. */
export class Alerter {
  private readonly notifier: Pick<Notifier, "sendAdmin">;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly lastSent = new Map<AlertCondition, number>();

  constructor(notifier: Pick<Notifier, "sendAdmin">, opts: AlerterOptions = {}) {
    this.notifier = notifier;
    this.intervalMs = opts.intervalMs ?? ALERT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? rootLog.child({ component: "alerts" });
  }

  /** Sends unless the same condition fired within the interval. Never throws. */
  async alert(condition: AlertCondition, text: string): Promise<void> {
    const now = this.now();
    const last = this.lastSent.get(condition);
    if (last !== undefined && now - last < this.intervalMs) {
      const retryInSec = Math.ceil((last + this.intervalMs - now) / 1000);
      this.log.info({ condition, retryInSec }, "alert throttled");
      return;
    }
    this.lastSent.set(condition, now);
    try {
      await this.notifier.sendAdmin(`[${condition}] ${text}`);
    } catch (err) {
      this.log.error({ err, condition }, "alert failed");
    }
  }
}
