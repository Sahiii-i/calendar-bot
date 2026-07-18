import { Bot, InlineKeyboard } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { interpretMessage, extractEventFromEmail } from "./ai.js";
import { listEvents, createEvent, patchEvent, deleteEvent, listUnprocessedEmails, getEmail, markEmailProcessed } from "./google.js";
import { dayRange, dayStart, fmtDate, fmtTime, fmtDateTime } from "./time.js";

const bot = new Bot(config.telegramToken);

// Pending confirmations (proposed actions waiting for a button tap).
// Entries: { kind: "create", event } | { kind: "update", eventId, changes, body } | { kind: "delete", eventId, body }
// In-memory: if the bot restarts, tapping an old button asks you to resend.
const pending = new Map();
let pendingSeq = 0;

function stash(entry) {
  const id = String(++pendingSeq);
  pending.set(id, entry);
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

// When/where line for an existing Google Calendar event.
function eventWhen(e) {
  if (e.start?.date) return `${fmtDate(new Date(`${e.start.date}T00:00:00+08:00`))} (all day)`;
  return `${fmtDateTime(new Date(e.start.dateTime))}–${fmtTime(new Date(e.end.dateTime))}`;
}

// How many words of the user's target phrase appear in the event title.
function matchScore(target, summary) {
  const words = target.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const s = (summary ?? "").toLowerCase();
  return words.filter((w) => s.includes(w)).length;
}

// Fields to change on an existing event, from the parsed message.
// If only a new start is given, the event keeps its current duration.
function buildChanges(parsed, ev) {
  const changes = {};
  if (parsed.new_title) changes.title = parsed.new_title;
  if (parsed.new_location) changes.location = parsed.new_location;
  if (parsed.new_start) {
    changes.start = parsed.new_start;
    if (parsed.new_end) {
      changes.end = parsed.new_end;
    } else if (ev.start?.dateTime && ev.end?.dateTime && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.new_start)) {
      const duration = new Date(ev.end.dateTime) - new Date(ev.start.dateTime);
      changes.end = new Date(new Date(parsed.new_start).getTime() + duration).toISOString();
    }
  } else if (parsed.new_end) {
    changes.end = parsed.new_end;
  }
  return changes;
}

function describeChanges(ev, changes) {
  const after = [];
  if (changes.title) after.push(`📌 ${changes.title}`);
  if (changes.start) {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(changes.start);
    after.push(`🕐 ${allDay
      ? `${fmtDate(new Date(`${changes.start}T00:00:00+08:00`))} (all day)`
      : `${fmtDateTime(new Date(changes.start))}${changes.end ? `–${fmtTime(new Date(changes.end))}` : ""}`}`);
  } else if (changes.end) {
    after.push(`🕐 ends ${fmtTime(new Date(changes.end))}`);
  }
  if (changes.location) after.push(`📍 ${changes.location}`);
  return `📌 ${ev.summary ?? "(no title)"}\n🕐 ${eventWhen(ev)}\n\n⬇️ becomes\n\n${after.join("\n")}`;
}

function actionPrompt(entry) {
  if (entry.kind === "create") return `Add this?\n\n${describeProposal(entry.event)}`;
  if (entry.kind === "delete") return `Delete this? 🗑\n\n${entry.body}`;
  return `Update this?\n\n${entry.body}`;
}

function confirmKeyboard(id, entry) {
  const yes = { create: "✅ Add", update: "✅ Update", delete: "🗑 Delete" }[entry.kind];
  return new InlineKeyboard().text(yes, `confirm:${id}`).text("❌ Cancel", `cancel:${id}`);
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
      "• Move or cancel things too: \"push tomorrow's Zoom to 12.30pm\", \"cancel Friday's dentist\".",
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
      const entry = { kind: "create", event };
      const id = stash(entry);
      await ctx.reply(actionPrompt(entry), { reply_markup: confirmKeyboard(id, entry) });
      return;
    }

    if (parsed.intent === "query_schedule" && parsed.query_start) {
      const start = new Date(parsed.query_start);
      const end = parsed.query_end ? new Date(parsed.query_end) : new Date(start.getTime() + 24 * 3600 * 1000);
      await ctx.reply(await scheduleText(start, end, `📅 ${fmtDate(start)}`));
      return;
    }

    if (parsed.intent === "update_event" || parsed.intent === "delete_event") {
      const isUpdate = parsed.intent === "update_event";
      if (isUpdate && !parsed.new_start && !parsed.new_end && !parsed.new_title && !parsed.new_location) {
        await ctx.reply("What should it change to? Give me the new time (or title/location).");
        return;
      }

      // Search window: what the user indicated, else the next 14 days.
      const winStart = parsed.query_start ? new Date(parsed.query_start) : dayStart(0);
      const winEnd = parsed.query_end
        ? new Date(parsed.query_end)
        : new Date(winStart.getTime() + 14 * 24 * 3600 * 1000);
      let candidates = await listEvents(winStart, winEnd);

      // Narrow by title words if the user named the event.
      if (parsed.target && candidates.length > 1) {
        const scored = candidates.map((e) => [matchScore(parsed.target, e.summary), e]);
        const best = Math.max(...scored.map(([s]) => s));
        if (best > 0) candidates = scored.filter(([s]) => s === best).map(([, e]) => e);
      }

      if (candidates.length === 0) {
        await ctx.reply("I couldn't find that event. Tell me its name and which day it's on.");
        return;
      }

      const toEntry = (ev) => {
        if (!isUpdate) return { kind: "delete", eventId: ev.id, body: `📌 ${ev.summary ?? "(no title)"}\n🕐 ${eventWhen(ev)}` };
        const changes = buildChanges(parsed, ev);
        return { kind: "update", eventId: ev.id, changes, body: describeChanges(ev, changes) };
      };

      if (candidates.length === 1) {
        const entry = toEntry(candidates[0]);
        const id = stash(entry);
        await ctx.reply(actionPrompt(entry), { reply_markup: confirmKeyboard(id, entry) });
        return;
      }

      // Ambiguous: let the user pick which event they meant.
      const keyboard = new InlineKeyboard();
      for (const ev of candidates.slice(0, 5)) {
        const id = stash(toEntry(ev));
        keyboard.text(`${fmtDate(new Date(ev.start.dateTime ?? `${ev.start.date}T00:00:00+08:00`))} ${ev.start.dateTime ? fmtTime(new Date(ev.start.dateTime)) : ""} ${ev.summary ?? ""}`.slice(0, 60), `pick:${id}`).row();
      }
      await ctx.reply(`Which one${isUpdate ? " should I change" : " should I delete"}?`, { reply_markup: keyboard });
      return;
    }

    await ctx.reply(
      parsed.reply ||
        "I can add events (\"meeting with Kevin Friday 2pm\"), move or cancel them (\"push my 3pm to 5pm\"), or check your schedule (\"what's on tomorrow?\").",
    );
  } catch (err) {
    console.error("message handling failed:", err);
    await ctx.reply("Something went wrong reading that. Try rephrasing with a clear date and time.");
  }
});

// ---------- Confirmation buttons ----------

// Ambiguity picker: user tapped which event they meant — show its confirm prompt.
bot.callbackQuery(/^pick:(.+)$/, async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const id = ctx.match[1];
  const entry = pending.get(id);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "This one expired. Send it again." });
    await ctx.editMessageReplyMarkup();
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(actionPrompt(entry), { reply_markup: confirmKeyboard(id, entry) });
});

bot.callbackQuery(/^(confirm|cancel):(.+)$/, async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const [, action, id] = ctx.match;
  const entry = pending.get(id);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "This one expired. Send it again." });
    await ctx.editMessageReplyMarkup();
    return;
  }
  pending.delete(id);

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Cancelled, nothing changed.");
    return;
  }

  try {
    if (entry.kind === "create") {
      const created = await createEvent(entry.event);
      await ctx.answerCallbackQuery({ text: "Added!" });
      await ctx.editMessageText(`✅ Added to calendar\n\n${describeProposal(entry.event)}\n\n${created.htmlLink ?? ""}`);
    } else if (entry.kind === "update") {
      await patchEvent(entry.eventId, entry.changes);
      await ctx.answerCallbackQuery({ text: "Updated!" });
      await ctx.editMessageText(`✅ Updated\n\n${entry.body}`);
    } else {
      await deleteEvent(entry.eventId);
      await ctx.answerCallbackQuery({ text: "Deleted" });
      await ctx.editMessageText(`🗑 Deleted\n\n${entry.body}`);
    }
  } catch (err) {
    console.error(`${entry.kind} failed:`, err);
    await ctx.answerCallbackQuery({ text: "Failed" });
    await ctx.editMessageText("⚠️ Google Calendar said no. Check the server logs.");
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
          const pid = stash({ kind: "create", event });
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
