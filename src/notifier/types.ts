/** One levelled tag. `warn` is reserved for the tag that rules most of the group out. */
export interface Tag {
  text: string;
  level: "info" | "warn";
}

/** One message: a dedupe key with every city it was posted in, plus pre-worded tags. */
export interface Notification {
  /** Dedupe key, for logging only. */
  key: string;
  title: string;
  company: string;
  /** First-appearance order, deduped by location. */
  postings: { location: string; url: string }[];
  /** Pre-worded and levelled, may be empty. Adapters print them, they do not interpret them. */
  tags: Tag[];
}

/** Delivery interface. Telegram is the first adapter. */
export interface Notifier {
  /** Verifies credentials once. A bad token is a boot error. Does not start receiving updates. */
  start(): Promise<void>;
  /** False after a send failed because the bot lost the group, true again once a retry probe passes. */
  isReady(): boolean;
  /** Sends one notification to the group. Throws when it cannot; the loop retries next cycle. */
  send(n: Notification): Promise<{ messageId: string }>;
  /** Plain-text alert to the admin. Never throws. */
  sendAdmin(text: string): Promise<void>;
  /** Releases any held connection. A no-op for Telegram. */
  stop(): Promise<void>;
}
