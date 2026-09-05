# core

The poll loop, the SQLite store of seen postings and sent notifications, the dedupe key and grouping logic, and configuration. Everything is under `src/core/`, re-exported from `src/core/index.ts`. The classifier's `Verdict` type lives in `src/classifier/types.ts` so the store does not own classifier vocabulary.

## Docs

- [loop.md](loop.md) - the cycle step by step, scheduling, failure handling, alert counters, shutdown, `LoopStatus` and `CycleSummary`.
- [config.md](config.md) - config.json fields and defaults, env variables, search URL parsing, boot failure behaviour, logging.
- [store.md](store.md) - the SQLite file, open sequence and pragmas, migrations, schema, API, notification lifecycle and crash retry, why nothing is pruned.
- [dedupe.md](dedupe.md) - the `normalise` rule, key format, grouping contract, the notification window and its edge cases.
