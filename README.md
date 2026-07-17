# Calendar Bot

Personal Telegram assistant that:

- Adds events to **Google Calendar** from plain text ("Zoom with Benson tomorrow 3pm")
- Answers schedule questions ("what's on this Friday?"), plus `/today`, `/tomorrow`, `/week`
- Sends a **nightly digest at 9pm** with tomorrow's schedule
- Watches **Gmail** every 10 minutes for interview/meeting emails and asks (with tap buttons) whether to add them

Everything the bot proposes needs one tap to confirm before it touches your calendar.

Since your calendar lives in Google, add your Google account to the Calendar app on your Mac and iPhone (Settings → Internet Accounts → Google, tick Calendars). Events show up there like normal.

---

## Setup (~30 min, one time)

### 1. Create the Telegram bot (2 min)

1. In Telegram, message **@BotFather** → send `/newbot`
2. Give it a name (e.g. "Sahi's Assistant") and a username ending in `bot`
3. Copy the token it gives you → this is `TELEGRAM_BOT_TOKEN`

### 2. Google Cloud project (10 min)

1. Go to https://console.cloud.google.com → create a new project (any name, e.g. "calendar-bot")
2. **Enable APIs**: search "Google Calendar API" → Enable. Search "Gmail API" → Enable.
3. **OAuth consent screen**: APIs & Services → OAuth consent screen → External → fill in app name + your email → save. Under **Test users**, add `sahishnu2005@gmail.com`. (Stays in "Testing" mode — that's fine for personal use; refresh tokens for test users expire after 7 days ONLY if publishing status is "Testing" AND scopes are sensitive — to avoid re-auth every week, click **Publish app** on the consent screen. It won't be reviewed since only you use it.)
4. **Credentials**: APIs & Services → Credentials → Create Credentials → OAuth client ID → Application type: **Desktop app** → Create
5. Copy the **Client ID** and **Client Secret** → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### 3. Anthropic API key (2 min)

https://console.anthropic.com → API Keys → Create Key → `ANTHROPIC_API_KEY`

### 4. Run locally once to authorize Google

```bash
cd ~/calendar-bot
npm install
cp .env.example .env    # fill in the tokens from steps 1-3
npm run get-token       # opens a URL — approve with sahishnu2005@gmail.com
```

Paste the printed `GOOGLE_REFRESH_TOKEN=...` line into `.env`.

### 5. First run + get your chat id

```bash
npm start
```

Message your bot `/start` in Telegram. It replies with your **chat id** — put it in `.env` as `TELEGRAM_CHAT_ID`, then restart. Now the bot only talks to you, and digests/email alerts know where to go.

### 6. Deploy to Railway (always on)

1. Push this folder to a **private** GitHub repo (`.env` is gitignored — good)
2. https://railway.app → New Project → Deploy from GitHub repo
3. In the service → **Variables** → add every variable from your `.env`
4. Railway runs `npm start` automatically. Check the deploy logs for "is running".

Done. Stop the local copy once Railway is up (two copies polling Telegram at once causes conflicts).

---

## Usage

| You send | Bot does |
|---|---|
| `Meeting with Kevin Fri 2pm to 3pm at Apex office` | Proposes the event, one tap to add |
| `what do I have tomorrow?` | Lists tomorrow's events |
| `/today` `/tomorrow` `/week` | Quick schedule views |
| (nothing) 9pm daily | Digest of tomorrow's schedule |
| (nothing) every 10 min | Scans new Gmail; proposes any appointment it finds |

Emails the bot has looked at get a hidden `CalBot` label in Gmail so they're never scanned twice.

## Config knobs (env vars)

- `DIGEST_HOUR` / `DIGEST_MINUTE` — digest time (default 21:00)
- `EMAIL_POLL_MINUTES` — Gmail scan interval (default 10)
- `ANTHROPIC_MODEL` — default `claude-haiku-4-5` (cheap, ~fractions of a cent per message). Set `claude-opus-4-8` if parsing ever feels off.
- `TIMEZONE` — default `Asia/Singapore`
