import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}. See .env.example / README.md`);
    process.exit(1);
  }
  return value;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  // Your personal Telegram chat id. The bot only talks to this chat and uses it
  // for the nightly digest + email proposals. Leave empty on first run: message
  // the bot /start and it replies with the id to put here.
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
  google: {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    refreshToken: required("GOOGLE_REFRESH_TOKEN"),
  },
  timezone: process.env.TIMEZONE || "Asia/Singapore",
  // 24h clock, local to `timezone`. Default 21:00 = digest of tomorrow, the night before.
  digestHour: Number(process.env.DIGEST_HOUR ?? 21),
  digestMinute: Number(process.env.DIGEST_MINUTE ?? 0),
  emailPollMinutes: Number(process.env.EMAIL_POLL_MINUTES ?? 10),
};
