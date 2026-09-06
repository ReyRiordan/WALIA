import type { Transformer } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { TelegramNotifier } from "./telegram.ts";
import type { Notification } from "./types.ts";

type Reply =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

const ok = (result: unknown): Reply => ({ ok: true, result });
const fail = (error_code: number, description: string, retry_after?: number): Reply => ({
  ok: false,
  error_code,
  description,
  ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
});

const SAMPLE: Notification = {
  key: "spectrum|software engineer intern",
  title: "Software Engineer Intern",
  company: "Spectrum",
  postings: [{ location: "Austin, TX", url: "https://www.linkedin.com/jobs/view/1" }],
  tags: [],
};

/** A notifier whose API calls are answered from a script instead of Telegram. */
function harness(replies: Reply[], readyRetryMs = 1) {
  const queue = [...replies];
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const canned: Transformer = async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const reply = queue.shift();
    if (!reply) throw new Error(`no scripted reply for ${method}`);
    // biome-ignore lint/suspicious/noExplicitAny: canned Telegram response
    return reply as any;
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const notifier = new TelegramNotifier({
    token: "t",
    groupChatId: "-100123",
    adminChatId: "42",
    readyRetryMs,
    transformers: [canned],
    // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
    log: log as any,
  });
  return { notifier, calls, log };
}

describe("TelegramNotifier", () => {
  it("start() rejects when getMe fails and stays not ready", async () => {
    const { notifier } = harness([fail(401, "Unauthorized")]);
    await expect(notifier.start()).rejects.toThrow(/Unauthorized/);
    expect(notifier.isReady()).toBe(false);
  });

  it("start() calls getMe once and becomes ready", async () => {
    const { notifier, calls } = harness([ok({ id: 1, username: "malja_bot" })]);
    await notifier.start();
    expect(calls.map((c) => c.method)).toEqual(["getMe"]);
    expect(notifier.isReady()).toBe(true);
  });

  it("send() posts HTML to the group with previews off and returns the message id", async () => {
    const { notifier, calls } = harness([ok({ message_id: 77 })]);
    await expect(notifier.send(SAMPLE)).resolves.toEqual({ messageId: "77" });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: "-100123",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(calls[0]?.payload.text).toContain("<b>Software Engineer Intern</b>");
  });

  it("retries a 429 after retry_after", async () => {
    const { notifier, calls } = harness([
      fail(429, "Too Many Requests: retry after 0", 0),
      ok({ message_id: 5 }),
    ]);
    await expect(notifier.send(SAMPLE)).resolves.toEqual({ messageId: "5" });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the retry cap and throws", async () => {
    const { notifier, calls } = harness(
      Array.from({ length: 5 }, () => fail(429, "Too Many Requests: retry after 0", 0)),
    );
    await expect(notifier.send(SAMPLE)).rejects.toThrow(/Too Many Requests/);
    expect(calls).toHaveLength(4);
  });

  it("a 403 kicked flips isReady false, throws, and a probe brings it back", async () => {
    const { notifier, calls } = harness([
      ok({ id: 1, username: "malja_bot" }),
      fail(403, "Forbidden: bot was kicked from the group chat"),
      ok({ id: 1, username: "malja_bot" }),
      ok({ id: -100123, type: "supergroup" }),
    ]);
    await notifier.start();
    await expect(notifier.send(SAMPLE)).rejects.toThrow(/kicked/);
    expect(notifier.isReady()).toBe(false);
    await vi.waitFor(() => expect(notifier.isReady()).toBe(true));
    expect(calls.slice(2).map((c) => c.method)).toEqual(["getMe", "getChat"]);
    await notifier.stop();
  });

  it("a 400 chat not found flips isReady false and keeps probing until the chat is back", async () => {
    const { notifier, log } = harness([
      ok({ id: 1 }),
      fail(400, "Bad Request: chat not found"),
      ok({ id: 1 }),
      fail(400, "Bad Request: chat not found"),
      ok({ id: 1 }),
      ok({ id: -100123 }),
    ]);
    await notifier.start();
    await expect(notifier.send(SAMPLE)).rejects.toThrow(/chat not found/);
    expect(notifier.isReady()).toBe(false);
    await vi.waitFor(() => expect(notifier.isReady()).toBe(true));
    expect(log.warn).toHaveBeenCalledTimes(1);
    await notifier.stop();
  });

  it("other send errors throw without touching readiness", async () => {
    const { notifier } = harness([ok({ id: 1 }), fail(400, "Bad Request: message is too long")]);
    await notifier.start();
    await expect(notifier.send(SAMPLE)).rejects.toThrow(/too long/);
    expect(notifier.isReady()).toBe(true);
  });

  it("sendAdmin uses no parse mode and swallows errors", async () => {
    const { notifier, calls, log } = harness([ok({ message_id: 1 }), fail(403, "Forbidden")]);
    await notifier.sendAdmin("hello");
    expect(calls[0]?.payload).toEqual({ chat_id: "42", text: "hello" });
    await expect(notifier.sendAdmin("again")).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
