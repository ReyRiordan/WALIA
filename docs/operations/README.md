# operations

Running locally, deploying to Railway, the health endpoint, and admin alerting.

## Docs

No docs yet. As they are added, list each one here with a one-line purpose.

## Network placement

LinkedIn throttles the guest endpoints by IP, and a datacenter address (Railway, AWS, Hetzner, ...) trips that sooner than a residential one. If the deployed instance keeps landing in backoff, set `PROXY_URL` to a single residential or mobile proxy. A rotating pool buys nothing at fifteen requests per cycle and looks less like one browser.
