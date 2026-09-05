/**
 * Real-Telegram check. Sends one sample notification with two linked cities and both tags to
 * the group, then one plain-text line to the admin chat. Usage: pnpm notify:test
 */
import { loadConfig, parseEnv } from "../src/config.ts";
import { log } from "../src/log.ts";
import { createNotifier, type Notification } from "../src/notifier/index.ts";

const env = parseEnv();
const config = loadConfig(env.CONFIG_PATH);

const sample: Notification = {
  key: "spectrum|software engineer intern",
  title: "Software Engineer Intern <test>",
  company: "Spectrum & Co",
  postings: [
    { location: "Greenwood Village, CO", url: "https://www.linkedin.com/jobs/view/4000000001" },
    { location: "Englewood, CO", url: "https://www.linkedin.com/jobs/view/4000000002" },
  ],
  tags: [
    { text: "eligibility unclear", level: "info" },
    { text: "no sponsorship", level: "info" },
  ],
};

const notifier = createNotifier(config, env);
await notifier.start();
const { messageId } = await notifier.send(sample);
log.info({ messageId, chatId: env.TELEGRAM_GROUP_CHAT_ID }, "group message sent");
await notifier.sendAdmin("WALIA notify:test: admin alerts work");
log.info({ chatId: env.TELEGRAM_ADMIN_CHAT_ID }, "admin message sent");
await notifier.stop();
