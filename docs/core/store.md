# Store

Code: `src/core/store.ts`.

```ts
openStore(path): Store

class Store {
  hasJob(id): boolean                               // the scraper's isSeen
  insertJobs(jobs, now): number                     // INSERT OR IGNORE, one txn, returns inserted count
  getJobs(ids): StoredJob[]                         // input order, unknown ids skipped
  setVerdict(id, verdict, now): void
  keyNotifiedSince(key, sinceMs): boolean           // any row with created_at >= sinceMs
  createNotifications(groups, now): number[]        // one txn, row ids in input order
  markSent(ids, messageId, now): void               // one txn
  unsentNotifications(): PendingNotification[]      // sent_at IS NULL, oldest first, jobs rehydrated
  close(): void
}

interface StoredJob extends Job { firstSeenAt: number; verdict: Verdict | null }
interface PendingNotification { id: number; key: string; createdAt: number; jobs: StoredJob[] }
```

One SQLite file, `walia.db` under `DATA_DIR`. The caller passes the full path. The driver is Node 24's built-in `node:sqlite` (`DatabaseSync`): synchronous prepared statements, no native addon, nothing extra in the Docker image. Every statement is prepared once in the constructor. Transactions are explicit `BEGIN` / `COMMIT` / `ROLLBACK` behind one private helper, since the driver has no `transaction()`.

## Open sequence

1. `mkdirSync(dirname(path), { recursive: true })`, skipped for `:memory:`.
2. `new DatabaseSync(path)`.
3. `PRAGMA journal_mode = WAL`, then `PRAGMA busy_timeout = 5000`.
4. Migrations.

## Migrations

`MIGRATIONS` is an ordered array of SQL strings in `store.ts`. `PRAGMA user_version` is the cursor. On open, each entry past the current version runs in its own transaction: `BEGIN`, the SQL, `PRAGMA user_version = n`, `COMMIT`. A failure rolls that one back and throws, so the process does not boot on a half-migrated file. No library, no migration files, no down migrations. Adding a column means appending one string; migration 2 is `ALTER TABLE jobs ADD COLUMN relevant TEXT`.

## Schema

`jobs`, one row per LinkedIn id. Primary key `linkedin_id`, index on `dedupe_key`.

| Column | Meaning |
| --- | --- |
| `linkedin_id` | The posting id. Exact-id dedupe is `hasJob`. |
| `dedupe_key` | `dedupeKey(job)` at insert time. See dedupe.md. |
| `title`, `company`, `location`, `url`, `search_label` | Straight from `Job`. |
| `description` | Plain text, or NULL when the detail page had none. Kept as the classifier audit trail. |
| `posted_at` | `Job.postedAt` as unix ms, or NULL. |
| `first_seen_at` | The `now` passed to `insertJobs`. |
| `skip` | `stale`, `gone`, or NULL. Skipped jobs are stored so the id never resurfaces. |
| `relevant`, `degree_ok`, `work_auth`, `classifier_reason`, `classified_at` | The `Verdict`, all NULL until `setVerdict`. A row with `relevant` NULL next to a non-null `degree_ok` was classified before migration 2; it reads back as `relevant: "unclear"`. |

`notifications`, one row per dedupe key per cycle, which is one message. Index on `(dedupe_key, created_at)` for the window query.

| Column | Meaning |
| --- | --- |
| `id` | Rowid. Returned by `createNotifications`. |
| `dedupe_key` | The group's key. |
| `linkedin_ids` | JSON array of the ids in that message. A row whose JSON is not a string array throws on read, since that means corruption. There is no join table; nothing asks "which notification contained job X". |
| `created_at` | The `now` passed to `createNotifications`. The window is measured from this. |
| `sent_at`, `message_id` | NULL until `markSent`. `message_id` is that row's own Telegram message id. |

Every `*_at` column is an integer of unix milliseconds. `Job.postedAt` maps through `getTime()` on write and `new Date()` on read.

## Notification lifecycle

1. The loop calls `createNotifications` with the groups that passed the window and the verdicts. All rows land in one transaction before anything is sent.
2. For each row, oldest first, it sends one message.
3. As each send resolves it calls `markSent` with that one row id and its message id.

If the process dies mid-cycle, the next boot finds every row with no `sent_at` through `unsentNotifications` and retries those sends. A row whose send threw stays unsent and is retried the same way next cycle. A retry is a duplicate message at worst, never a lost one. `keyNotifiedSince` counts unsent rows too, so a crash cannot make the same key send twice as two separate rows.

## No pruning

Rows and descriptions are kept forever. `jobs` is the exact-id dedupe, so deleting rows would let old ids resurface, and descriptions are the audit trail for classifier verdicts. A few hundred jobs a week at roughly 5 KB each stays well under 100 MB a year. Revisit if the volume fills the volume.
