import { describe, expect, it, vi } from "vitest";
import { ALERT_INTERVAL_MS, Alerter } from "./alerts.ts";

function harness(sendAdmin = vi.fn(async (_text: string) => {})) {
  let t = 1_000_000;
  const log = { info: vi.fn(), error: vi.fn() };
  const alerter = new Alerter(
    { sendAdmin },
    // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
    { now: () => t, log: log as any },
  );
  return { alerter, sendAdmin, log, advance: (ms: number) => (t += ms) };
}

describe("Alerter", () => {
  it("sends the first alert with the condition prefixed", async () => {
    const { alerter, sendAdmin } = harness();
    await alerter.alert("blocked", "authwall on search");
    expect(sendAdmin).toHaveBeenCalledWith("[blocked] authwall on search");
  });

  it("drops a repeat of the same condition within the hour and logs it", async () => {
    const { alerter, sendAdmin, log, advance } = harness();
    await alerter.alert("blocked", "first");
    advance(ALERT_INTERVAL_MS - 30_000);
    await alerter.alert("blocked", "second");
    expect(sendAdmin).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { condition: "blocked", retryInSec: 30 },
      "alert throttled",
    );
  });

  it("sends again once the hour has passed", async () => {
    const { alerter, sendAdmin, advance } = harness();
    await alerter.alert("no_cards", "first");
    advance(ALERT_INTERVAL_MS);
    await alerter.alert("no_cards", "second");
    expect(sendAdmin).toHaveBeenCalledTimes(2);
  });

  it("throttles conditions independently", async () => {
    const { alerter, sendAdmin } = harness();
    await alerter.alert("blocked", "a");
    await alerter.alert("rate_limited", "b");
    expect(sendAdmin).toHaveBeenCalledTimes(2);
  });

  it("swallows a throwing sendAdmin", async () => {
    const { alerter, log } = harness(vi.fn(async () => Promise.reject(new Error("boom"))));
    await expect(alerter.alert("send_failed", "x")).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
