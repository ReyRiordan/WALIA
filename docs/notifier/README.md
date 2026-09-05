# notifier

Delivering one message per new dedupe key to the student group, and throttled alerts to the admin. A `Notifier` interface with Telegram as the first adapter. Everything is under `src/notifier/`, re-exported from `src/notifier/index.ts`, which also holds the `createNotifier` factory. `src/index.ts` never imports grammY.

## Docs

- [interface.md](interface.md) - the `Notification` and `Notifier` types, method contracts, the `isReady` rules, the factory.
- [telegram.md](telegram.md) - message layout and escaping, auto-retry caps, lost-group handling, chat ids, `pnpm notify:test`.
- [alerts.md](alerts.md) - alert conditions, the one-hour throttle, who detects what.
