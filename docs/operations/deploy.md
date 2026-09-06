# Deploying to Railway

`railway.json` in the repo, everything else in the dashboard. This page lists every dashboard setting so the service can be rebuilt from it.

## railway.json

| Field | Value | Why |
| --- | --- | --- |
| `build.builder` | `DOCKERFILE` | The repo's Dockerfile, same image as `docker build -t malja .`. |
| `deploy.healthcheckPath` | `/health` | Always 200 once listening; see health.md. |
| `deploy.healthcheckTimeout` | 120 | Seconds Railway waits for the first 200 before failing the deploy. Boot is a config parse, a store open, and one `getMe`; 120 leaves room for a slow pull. |
| `deploy.restartPolicyType` | `ON_FAILURE` | Restart on a non-zero exit. A clean SIGTERM exit is 0 and is not restarted. |
| `deploy.restartPolicyMaxRetries` | 10 | Stops a crash loop from hammering LinkedIn, since every boot fires a first cycle. |

## Service

One service from the GitHub repo, `main` branch, auto-deploy on push. The Dockerfile runs as the `node` user.

## Volume

One volume mounted at `/data`, with `DATA_DIR=/data` so `malja.db` lands on it. The store is the only state; without the volume every redeploy re-sends every posting in the window.

Railway mounts the volume owned by root while the Dockerfile switches to the `node` user, so without further setup the first boot crash-loops on `ERR_SQLITE_ERROR` errcode 14, `unable to open database file`, right after the `config loaded` line. `RAILWAY_RUN_UID=0` in the service variables runs the container as root and is the fix in use.

## Variables

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret. |
| `TELEGRAM_GROUP_CHAT_ID` | The real group. Changes to a `-100` id if the group becomes a supergroup. |
| `TELEGRAM_ADMIN_CHAT_ID` | The admin's chat with the bot. |
| `OPENROUTER_API_KEY` | Secret. Put a monthly limit on the key; that is the spend cap. |
| `DATA_DIR` | `/data`. |
| `RAILWAY_RUN_UID` | `0`. Runs the container as root so the volume is writable; see Volume above. |
| `PORT` | Set by Railway. Do not override. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | 30. Must exceed the 10 s shutdown deadline in `src/index.ts`, or Railway SIGKILLs before the cycle reaches a step boundary. |
| `LOG_LEVEL`, `CONFIG_PATH`, `PROXY_URL` | Optional. `PROXY_URL` only if the instance keeps landing in backoff; see README.md. |

`config.json` is baked into the image, so a search change is a commit and a redeploy.

## Redeploys and restarts

Every boot runs a first cycle with `firstCycleRecencySec` (10 min by default), so a deploy during a quiet period costs one search page per search and nothing else. A boot after a longer outage misses anything older than that window; there is no cold-start catch-up. Backoff state is in memory, so a redeploy during a pause forgets it and makes one request that re-enters backoff if LinkedIn is still refusing.

On SIGTERM the process finishes its current step, closes the store, and exits 0 within 10 s. A notification row created but not marked sent before the kill is sent on the next boot.

## Pausing

Stop the service in the dashboard. Nothing else is needed: the store keeps the seen ids, and the next start scrapes only the first-cycle window. There is no pause command and the bot receives no messages.

## First-deploy checklist

1. Healthcheck green and `/health` returns `status: "ok"` after the first cycle.
2. Deploy log shows the store opening under `/data` with no `EACCES`.
3. The group receives one message per new key on the first cycle, nothing on a redeploy.
4. A few days with no `[rate_limited]` or `[blocked]` admin alert. If they keep coming, set `PROXY_URL`.
