# operations

Running locally, deploying to Railway, and the health endpoint. Admin alerting is in docs/notifier/alerts.md; the counters behind it are in docs/core/loop.md.

## Docs

- [run.md](run.md) - `.env` for a dev run, `pnpm dev` and the `--watch` caveat, the shutdown path, what each log line means.
- [deploy.md](deploy.md) - `railway.json` fields, the volume, every dashboard variable, redeploy and restart behaviour, pausing.
- [health.md](health.md) - `/health` fields, the status rules, why it is always 200.

## Network placement

LinkedIn throttles the guest endpoints by IP, and a datacenter address (Railway, AWS, Hetzner, ...) trips that sooner than a residential one. If the deployed instance keeps landing in backoff, set `PROXY_URL` to a single residential or mobile proxy. A rotating pool buys nothing at fifteen requests per cycle and looks less like one browser.
