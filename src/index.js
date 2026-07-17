import { Bot, InlineKeyboard } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { interpretMessage, extractEventFromEmail } from "./ai.js";
import { listEvents, createEvent, listUnprocessedEmails, getEmail, markEmailProcessed } from "./google.js";
import { dayRange, fmtDate, fmtTime, fmtDateTime } from "./time.js";

const bot = new Bot(config.telegramToken);

// Pending confirmations (proposed events waiting for a button tap).
// In-memory: if the bot restarts, tapping an old button asks you to resend.
const pending = new Map();
let pendingSeq = 0;

function stashEvent(event) {
  const id = String(++pendingSeq);
  pending.set(id, event);
  // Don't let the map grow forever.
  if (pending.size > 200) pending.delete(pending.keys().next().value);
  return id;
}

// ---------- Helpers ----------

function eventLine(e) {
  if (e.start?.date) return `• All day — ${e.summary ?? "(no title)"}`;
  const start = new Date(e.start.dateTime);
  const end = new Date(e.end.dateTime);
  const loc = e.location ? `\n   📍 ${e.location}` : "";
  return `• ${fmtTime(start)}–${fmtTime(end)} — ${e.summary ?? "(no title)"}${loc}`;
}

async function scheduleText(start, end, heading) {
  const events = await listEvents(start, end);
  if (events.length === 0) return `${heading}\n\nNothing on the calendar. 🎉`;
  // Group by day when the range spans multiple days.
  const spansDays = end - start > 26 * 3600 * 1000;
  if (!spansDays) return `${heading}\n\n${events.map(eventLine).join("\n")}`;
  const byDay = new Map();
  for (const e of events) {
    const d = fmtDate(new Date(e.start.dateTime ?? `${e.start.date}T00:00:00+08:00`));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(eventLine(e));
  }
  const blocks = [...byDay.entries()].map(([day, lines]) => `${day}\n${lines.join("\n")}`);
  return `${heading}\n\n${blocks.join("\n\n")}`;
}

function describeProposal(event) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  const when = allDay
    ? `${fmtDate(new Date(`${event.start}T00:00:00+08:00`))} (all day)`
    : `${fmtDateTime(new Date(event.start))}${event.end ? ` → ${fmtTime(new Date(event.end))}` : ""}`;
  const loc = event.location ? `\n📍 ${event.location}` : "";
  return `📌 ${event.title}\n🕐 ${when}${loc}`;
}

function isAuthorized(ctx) {
  if (!config.telegramChatId) return true; // first-run mode, so /start can reveal the id
  return String(ctx.chat?.id) === String(config.telegramChatId);
}

// ---------- Commands ----------

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Hey! I'm your calendar assistant. 🗓",
      "",
      "• Type things like \"Zoom with Benson tomorrow 3pm to 4pm\" and I'll add them to Google Calendar (I'll confirm first).",
      "• Ask \"what's on this Friday?\" to check your schedule.",
      "• /today and /tomorrow for quick views, /week for the next 7 days.",
      `• Every night at ${String(config.digestHour).padStart(2, "0")}:${String(config.digestMinute).padStart(2, "0")} I send tomorrow's schedule.`,
      "• I also watch your Gmail for interview/meeting emails and propose adding them.",
      "",
      `Your chat id: ${ctx.chat.id}${config.telegramChatId ? "" : "  ← put this in TELEGRAM_CHAT_ID"}`,
    ].join("\n"),
  );
});

bot.command("today", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const { start, end } = dayRange(0);
  await ctx.reply(await scheduleText(start, end, `📅 Today, ${fmtDate(start)}`));
});

bot.command("tomorrow", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const { start, end } = dayRange(1);
  await ctx.reply(await scheduleText(start, end, `📅 Tomorrow, ${fmtDate(start)}`));
});

bot.command("week", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const { start, end } = dayRange(0, 7);
  await ctx.reply(await scheduleText(start, end, "📅 Next 7 days"));
});

// ---------- Free-text messages ----------

bot.on("message:text", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    const parsed = await interpretMessage(text);

    if (parsed.intent === "create_event" && parsed.title && parsed.start) {
      const event = {
        title: parsed.title,
        start: parsed.start,
        end: parsed.end || "",
        location: parsed.location || "",
      };
      const id = stashEvent(event);
      const keyboard = new InlineKeyboard()
        .text("✅ Add", `confirm:${id}`)
        .text("❌ Cancel", `cancel:${id}`);
      await ctx.reply(`Add this?\n\n${describeProposal(event)}`, { reply_markup: keyboard });
      return;
    }

    if (parsed.intent === "query_schedule" && parsed.query_start) {
      const start = new Date(parsed.query_start);
      const end = parsed.query_end ? new Date(parsed.query_end) : new Date(start.getTime() + 24 * 3600 * 1000);
      await ctx.reply(await scheduleText(start, end, `📅 ${fmtDate(start)}`));
      return;
    }

    await ctx.reply(
      parsed.reply ||
        "I can add events (\"meeting with Kevin Friday 2pm\") or check your schedule (\"what's on tomorrow?\").",
    );
  } catch (err) {
    console.error("message handling failed:", err);
    await ctx.reply("Something went wrong reading that. Try rephrasing with a clear date and time.");
  }
});

// ---------- Confirmation buttons ----------

bot.callbackQuery(/^(confirm|cancel):(.+)$/, async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const [, action, id] = ctx.match;
  const event = pending.get(id);
  if (!event) {
    await ctx.answerCallbackQuery({ text: "This one expired. Send it again." });
    await ctx.editMessageReplyMarkup();
    return;
  }
  pending.delete(id);

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Cancelled, nothing added.");
    return;
  }

  try {
    const created = await createEvent(event);
    await ctx.answerCallbackQuery({ text: "Added!" });
    await ctx.editMessageText(`✅ Added to calendar\n\n${describeProposal(event)}\n\n${created.htmlLink ?? ""}`);
  } catch (err) {
    console.error("createEvent failed:", err);
    await ctx.answerCallbackQuery({ text: "Failed" });
    await ctx.editMessageText("⚠️ Couldn't add that to Google Calendar. Check the server logs.");
  }
});

// ---------- Nightly digest ----------

async function sendDigest() {
  if (!config.telegramChatId) return;
  try {
    const { start, end } = dayRange(1);
    const text = await scheduleText(start, end, `🌙 Tomorrow, ${fmtDate(start)}`);
    await bot.api.sendMessage(config.telegramChatId, text);
  } catch (err) {
    console.error("digest failed:", err);
  }
}

cron.schedule(`${config.digestMinute} ${config.digestHour} * * *`, sendDigest, {
  timezone: config.timezone,
});

// ---------- Gmail watcher ----------

let scanning = false;

async function scanEmails() {
  if (scanning || !config.telegramChatId) return;
  scanning = true;
  try {
    const messages = await listUnprocessedEmails();
    for (const { id } of messages) {
      const email = await getEmail(id);
      try {
        const result = await extractEventFromEmail(email);
        if (result.has_event && result.title && result.start) {
          const event = {
            title: result.title,
            start: result.start,
            end: result.end || "",
            location: result.location || "",
            description: `From email: ${email.subject} (${email.from})`,
          };
          const pid = stashEvent(event);
          const keyboard = new InlineKeyboard()
            .text("✅ Add", `confirm:${pid}`)
            .text("❌ Ignore", `cancel:${pid}`);
          await bot.api.sendMessage(
            config.telegramChatId,
            `📧 Found an appointment in your email\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${describeProposal(event)}\n\nAdd it to your calendar?`,
            { reply_markup: keyboard },
          );
        }
      } finally {
        // Mark processed either way so the same email isn't re-scanned.
        await markEmailProcessed(id);
      }
    }
  } catch (err) {
    console.error("email scan failed:", err);
  } finally {
    scanning = false;
  }
}

setInterval(scanEmails, config.emailPollMinutes * 60 * 1000);

// ---------- Boot ----------

bot.catch((err) => console.error("bot error:", err));

bot.start({
  onStart: (me) => {
    console.log(`@${me.username} is running. Digest ${config.digestHour}:${String(config.digestMinute).padStart(2, "0")} ${config.timezone}, email scan every ${config.emailPollMinutes} min.`);
    // First scan shortly after boot so you see it working.
    setTimeout(scanEmails, 10_000);
  },
});
