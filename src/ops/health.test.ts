import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopStatus } from "../core/loop.ts";
import { type HealthServer, startHealthServer } from "./health.ts";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const log = { info: vi.fn() };

let server: HealthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function listen(status: LoopStatus): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
  server = await startHealthServer(0, () => status, log as any);
  return `http://127.0.0.1:${server.port}`;
}

describe("startHealthServer", () => {
  it("answers /health with 200 and the status as JSON", async () => {
    const base = await listen({
      status: "ok",
      lastCycleAt: NOW,
      lastSuccessfulCycleAt: NOW - 1000,
      pausedUntil: null,
      notifierReady: true,
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      lastCycleAt: "2026-09-05T12:00:00.000Z",
      lastSuccessfulCycleAt: "2026-09-05T11:59:59.000Z",
      pausedUntil: null,
      notifierReady: true,
      uptimeSec: expect.any(Number),
    });
  });

  it("stays 200 when the loop is paused or stale, with the detail in the body", async () => {
    const base = await listen({
      status: "paused",
      lastCycleAt: null,
      lastSuccessfulCycleAt: null,
      pausedUntil: NOW + 60_000,
      notifierReady: true,
    });
    const res = await fetch(`${base}/health?probe=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "paused",
      lastCycleAt: null,
      pausedUntil: "2026-09-05T12:01:00.000Z",
    });
  });

  it("answers any other path or method with 404", async () => {
    const base = await listen({
      status: "ok",
      lastCycleAt: null,
      lastSuccessfulCycleAt: null,
      pausedUntil: null,
      notifierReady: true,
    });
    expect((await fetch(`${base}/x`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(404);
  });

  it("rejects when the port is taken", async () => {
    const base = await listen({
      status: "ok",
      lastCycleAt: null,
      lastSuccessfulCycleAt: null,
      pausedUntil: null,
      notifierReady: true,
    });
    const port = Number(new URL(base).port);
    // biome-ignore lint/suspicious/noExplicitAny: partial pino logger
    await expect(startHealthServer(port, () => ({}) as LoopStatus, log as any)).rejects.toThrow(
      /EADDRINUSE/,
    );
  });
});
