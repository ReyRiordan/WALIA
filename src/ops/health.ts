import { createServer } from "node:http";
import type { Logger } from "pino";
import type { LoopStatus } from "../core/loop.ts";
import { log as rootLog } from "../log.ts";

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/** The JSON body of `GET /health`. Timestamps are ISO strings. */
export interface HealthBody {
  status: LoopStatus["status"];
  lastCycleAt: string | null;
  lastSuccessfulCycleAt: string | null;
  pausedUntil: string | null;
  notifierReady: boolean;
  uptimeSec: number;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * `GET /health` is always 200 once listening; the body carries the detail. Any other path is
 * 404. Plain `node:http`, no framework. Port 0 picks a free port, which tests use.
 */
export function startHealthServer(
  port: number,
  status: () => LoopStatus,
  log: Logger = rootLog.child({ component: "health" }),
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" || path !== "/health") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    const s = status();
    const body: HealthBody = {
      status: s.status,
      lastCycleAt: iso(s.lastCycleAt),
      lastSuccessfulCycleAt: iso(s.lastSuccessfulCycleAt),
      pausedUntil: iso(s.pausedUntil),
      notifierReady: s.notifierReady,
      uptimeSec: Math.round(process.uptime()),
    };
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      log.info({ port: bound }, "health server listening");
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
