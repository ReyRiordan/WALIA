# Interface

Code: `src/notifier/types.ts` (types), `src/notifier/format.ts` (`toNotification`), `src/notifier/index.ts` (factory).

```ts
interface Notification {
  key: string;                                   // dedupe key, logging only
  title: string;
  company: string;
  postings: { location: string; url: string }[]; // first-appearance order, deduped by location
  tags: string[];                                // pre-worded, may be empty
}

interface Notifier {
  start(): Promise<void>;
  isReady(): boolean;
  send(n: Notification): Promise<{ messageId: string }>;
  sendAdmin(text: string): Promise<void>;
  stop(): Promise<void>;
}

toNotification(group: Group, verdict: Verdict | null): Notification
createNotifier(config: Config, env: Env): Notifier
```

There is no digest. Each dedupe key is one `Notification`, one message, and one `notifications` row. Send order is the loop's business; see docs/core/loop.md.

## Notification

The loop hands over plain data and each adapter owns its rendering. A WhatsApp adapter has no HTML links, so pre-rendered text would be re-rendered anyway, and passing `Group` plus a verdict would tie the notifier to core and classifier vocabulary.

`toNotification` builds it from a `Group` and the group's single verdict. One posting per location, first appearance wins, so each city links to one listing. Tags are worded here, once, and adapters print them:

| Verdict field | Value | Tag |
| --- | --- | --- |
| `relevant` | `unclear` | none. The tags describe eligibility, not relevance. |
| `relevant` | `no` | none. The loop suppresses the job; it never reaches the notifier. |
| `degreeOk` | `unclear` | `eligibility unclear` |
| `degreeOk` | `no` | none. The loop suppresses the job; it never reaches the notifier. |
| `workAuth` | `no_sponsorship` | `no sponsorship` |
| `workAuth` | `citizen_only` | `US citizens only` |
| `workAuth` | `none` or `unclear` | none |
| verdict | `null` | none |

Work-auth `unclear` is the default whenever the description does not say, so tagging it would make everyone ignore the tag line. `no sponsorship` and `US citizens only` stay separate because they exclude different people. A `null` verdict means the group was never classified, which is a group with no description anywhere. There is one verdict per group, so there is no merge rule.

## Methods

- `start()` verifies credentials once and throws on failure, so a bad token is a boot error. It does not start receiving updates.
- `isReady()` is a stored boolean, not a live probe. True after `start()`. False when a group send fails because the bot lost the group. True again when a timed probe succeeds. While it is false the loop keeps scraping and storing, and skips sending.
- `send(n)` delivers one notification to the group and returns the adapter's message id as a string. It throws when it cannot. The loop leaves that row unsent and retries it next cycle through `unsentNotifications`.
- `sendAdmin(text)` sends plain text to the admin. It never throws: an alert about a failure must not become a failure. It logs and swallows.
- `stop()` releases any held connection. A no-op for Telegram.

## Factory

`createNotifier(config, env)` switches on `config.notifier`, which is an enum with the one value `telegram`. The Telegram adapter takes its token and both chat ids from env.
