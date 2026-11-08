import { Bot, InlineKeyboard } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { interpretMessage, extractFromEmail, summariseInbox, readScreenshot } from "./ai.js";
import {
  CATEGORIES,
  ensureCalendars,
  categoryOf,
  isAllDay,
  listEvents,
  createEvent,
  patchEvent,
  deleteEvent,
  listUnprocessedEmails,
  listRecentEmailSummaries,
  getEmail,
  markEmailProcessed,
} from "./google.js";
import { dismissedList, addDismissed } from "./store.js";
import { dayRange, dayStart, fmtDate, fmtTime, fmtDateTime, isUsableFutureDate, reconcileWithEvidence, nowLocalISO, resolveDayWord, onDay, isRepeating, alignToWeekdays, buildRRule, describeRepeat } from "./time.js";

const bot = new Bot(config.telegramToken);

// Pending confirmations (proposed actions waiting for a button tap).
// Entries: { kind: "create", event, source? } | { kind: "update", calendarId, eventId, changes, body } | { kind: "delete", calendarId, eventId, body }
// event.category is school | work | personal | deadline.
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

// ---------- Duplicate detection (email proposals) ----------

function titleWords(s) {
  return new Set((s ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

// True when the shorter title's significant words mostly appear in the other,
// e.g. "TWW 2026 starts soon!" matches "Tembusu Welcome Week (TWW) 2026".
function similarTitles(a, b) {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

// Same event = similar title and starts within a few days. The date window
// keeps weekly recurring things ("CS1010 lecture") on different weeks distinct.
function sameEvent(titleA, startA, titleB, startB) {
  if (!similarTitles(titleA, titleB)) return false;
  const a = new Date(`${startA.slice(0, 10)}T00:00:00+08:00`);
  const b = new Date(`${startB.slice(0, 10)}T00:00:00+08:00`);
  return Math.abs(a - b) <= 3 * 24 * 3600 * 1000;
}

// A similar event already on any of the calendars around that date, or null.
async function findOnCalendar(event) {
  const dayMs = 24 * 3600 * 1000;
  const day = new Date(`${event.start.slice(0, 10)}T00:00:00+08:00`);
  const existing = await listEvents(new Date(day.getTime() - 3 * dayMs), new Date(day.getTime() + 4 * dayMs));
  return existing.find((e) => similarTitles(event.title, e.summary)) ?? null;
}

// Already waiting on a tap for this, or previously turned down?
// Turned-down items are stored on disk, so a redeploy doesn't bring them back.
function alreadyAsked(event) {
  for (const entry of pending.values()) {
    if (entry.kind === "create" && entry.source === "email" && sameEvent(event.title, event.start, entry.event.title, entry.event.start)) return true;
  }
  return dismissedList().some((d) => sameEvent(event.title, event.start, d.title, d.start));
}

// The model must quote the email for the date it found. If the quote isn't
// actually in the email, say so on the card rather than hiding it.
function evidenceInEmail(evidence, body) {
  const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return evidence && norm(body).includes(norm(evidence));
}

// ---------- Helpers ----------

function eventLine(e) {
  const cat = categoryOf(e.calendarId);
  const dot = cat ? `${CATEGORIES[cat].emoji} ` : "";
  if (e.start?.date) return `• ${dot}All day — ${e.summary ?? "(no title)"}`;
  const start = new Date(e.start.dateTime);
  const end = new Date(e.end.dateTime);
  const loc = e.location ? `\n   📍 ${e.location}` : "";
  return `• ${dot}${fmtTime(start)}–${fmtTime(end)} — ${e.summary ?? "(no title)"}${loc}`;
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

function categoryLabel(category) {
  const cat = CATEGORIES[category] ?? CATEGORIES.personal;
  return `${cat.emoji} ${cat.name}`;
}

function describeProposal(event) {
  const allDay = isAllDay(event.start);
  const deadline = event.category === "deadline";
  let when;
  if (deadline) {
    when = allDay
      ? `Due ${fmtDate(new Date(`${event.start}T00:00:00+08:00`))}`
      : `Due ${fmtDateTime(new Date(event.start))}`;
  } else {
    when = allDay
      ? `${fmtDate(new Date(`${event.start}T00:00:00+08:00`))} (all day)`
      : `${fmtDateTime(new Date(event.start))}${event.end ? ` → ${fmtTime(new Date(event.end))}` : ""}`;
  }
  const loc = event.location ? `\n📍 ${event.location}` : "";
  const rep = event.repeatText ? `\n🔁 ${event.repeatText}` : "";
  return `📌 ${event.title}\n🕐 ${when}${rep}${loc}\n${categoryLabel(event.category)}`;
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
    } else if (ev.start?.dateTime && ev.end?.dateTime && !isAllDay(parsed.new_start)) {
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
    after.push(`🕐 ${isAllDay(changes.start)
      ? `${fmtDate(new Date(`${changes.start}T00:00:00+08:00`))} (all day)`
      : `${fmtDateTime(new Date(changes.start))}${changes.end ? `–${fmtTime(new Date(changes.end))}` : ""}`}`);
  } else if (changes.end) {
    after.push(`🕐 ends ${fmtTime(new Date(changes.end))}`);
  }
  if (changes.location) after.push(`📍 ${changes.location}`);
  return `📌 ${ev.summary ?? "(no title)"}\n🕐 ${eventWhen(ev)}\n\n⬇️ becomes\n\n${after.join("\n")}`;
}

// The text of a proposal card. Email proposals keep their email context.
function actionPrompt(entry) {
  if (entry.kind === "create") {
    const head = entry.header ?? "Add this?";
    const tail = entry.footer ? `\n\n${entry.footer}` : "";
    return `${head}\n\n${describeProposal(entry.event)}${tail}`;
  }
  if (entry.kind === "delete") return `Delete this? 🗑\n\n${entry.body}`;
  return `Update this?\n\n${entry.body}`;
}

// Confirm/cancel buttons. Non-deadline proposals also get a row to switch
// the category before adding, so a wrong guess is one tap to fix.
function confirmKeyboard(id, entry) {
  const yes = { create: "✅ Add", update: "✅ Update", delete: "🗑 Delete" }[entry.kind];
  const no = entry.kind === "create" && entry.source === "email" ? "❌ Not needed" : "❌ Cancel";
  const kb = new InlineKeyboard().text(yes, `confirm:${id}`).text(no, `cancel:${id}`);
  if (entry.kind === "create" && entry.event.category !== "deadline") {
    kb.row();
    for (const key of ["school", "work", "personal"]) {
      if (key === entry.event.category) continue;
      kb.text(`→ ${CATEGORIES[key].emoji} ${CATEGORIES[key].name}`, `cat:${id}:${key}`);
    }
  }
  return kb;
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
      "• Deadlines too: \"pay hostel fee by 22 Oct noon\".",
      "• Move or cancel things: \"push tomorrow's Zoom to 12.30pm\", \"cancel Friday's dentist\".",
      "• Ask \"what's on this Friday?\" to check your schedule.",
      "• Repeats: \"gym every Mon and Wed 7am\", \"send invoice to Mingyue every month on the 3rd\".",
      "• Send a screenshot (a WhatsApp invite, a confirmation) and I'll pull the meeting out of it.",
      "• /today and /tomorrow for quick views, /week for the next 7 days, /briefing for today's inbox recap.",
      `• Every night at ${String(config.digestHour).padStart(2, "0")}:${String(config.digestMinute).padStart(2, "0")} I send what happened in your inbox today and tomorrow's schedule.`,
      "• I watch your Gmail for appointments and deadlines and ask before adding them.",
      "",
      `Colours: ${Object.values(CATEGORIES).map((c) => `${c.emoji} ${c.name}`).join("  ")}`,
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

bot.command("briefing", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  await ctx.reply(await inboxBriefingText());
});

// ---------- Free-text messages ----------

// The event last added or changed from chat, so "I said Wed not Thursday"
// right after has something to fix. Forgotten after a couple of hours.
let recentEvent = null; // { calendarId, eventId, title, start, at }
const RECENT_MS = 2 * 3600 * 1000;

function rememberEvent(calendarId, eventId, title, start) {
  recentEvent = { calendarId, eventId, title, start, at: Date.now() };
}

function currentRecent() {
  return recentEvent && Date.now() - recentEvent.at < RECENT_MS ? recentEvent : null;
}

// The model is unreliable at weekday arithmetic, so when the message names a
// single relative day ("next Thursday", "tmr"), code decides the date.
// Returns a note for the card when the model's date had to be corrected.
function pinToNamedDay(parsed, text) {
  const day = resolveDayWord(text);
  if (!day) return "";
  let fixed = false;
  const pin = (field) => {
    if (parsed[field] && parsed[field].slice(0, 10) !== day) {
      parsed[field] = onDay(parsed[field], day);
      fixed = true;
    }
  };
  if (parsed.intent === "create_event") {
    // Shift the end by the same days, so overnight events keep their length.
    if (parsed.start && parsed.end && parsed.start.slice(0, 10) !== day) {
      const shift = new Date(`${day}T00:00:00Z`) - new Date(`${parsed.start.slice(0, 10)}T00:00:00Z`);
      const endDay = new Date(new Date(`${parsed.end.slice(0, 10)}T00:00:00Z`).getTime() + shift).toISOString().slice(0, 10);
      parsed.end = onDay(parsed.end, endDay);
    }
    pin("start");
  } else if (parsed.intent === "update_event" && !parsed.query_start) {
    pin("new_start");
    if (parsed.new_end) pin("new_end");
  } else if (parsed.intent === "query_schedule" && parsed.query_start) {
    const oneDay = !parsed.query_end || new Date(parsed.query_end) - new Date(parsed.query_start) <= 24 * 3600 * 1000;
    if (oneDay && parsed.query_start.slice(0, 10) !== day) {
      parsed.query_start = `${day}T00:00:00+08:00`;
      parsed.query_end = "";
      fixed = true;
    }
  }
  return fixed ? `date pinned to ${day}` : "";
}

bot.on("message:text", async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    const recent = currentRecent();
    const parsed = await interpretMessage(text, recent ? { title: recent.title, start: recent.start } : null);
    const dayNote = pinToNamedDay(parsed, text);
    if (dayNote) console.log(`day corrected for "${text}": ${dayNote}`);

    if (parsed.intent === "create_event" && parsed.title && parsed.start) {
      const event = {
        title: parsed.title,
        start: parsed.start,
        end: parsed.is_deadline ? "" : parsed.end || "",
        location: parsed.location || "",
        category: parsed.is_deadline ? "deadline" : parsed.category || "personal",
      };
      if (isRepeating(parsed.repeat)) {
        const aligned = alignToWeekdays(event.start, parsed.repeat);
        if (aligned !== event.start && event.end) {
          event.end = onDay(event.end, aligned.slice(0, 10));
        }
        event.start = aligned;
        event.recurrence = [buildRRule(parsed.repeat, event.start)];
        event.repeatText = describeRepeat(parsed.repeat, event.start);
      }
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

      const toEntry = (ev) => {
        if (!isUpdate) return { kind: "delete", calendarId: ev.calendarId, eventId: ev.id, body: `📌 ${ev.summary ?? "(no title)"}\n🕐 ${eventWhen(ev)}` };
        const changes = buildChanges(parsed, ev);
        return { kind: "update", calendarId: ev.calendarId, eventId: ev.id, changes, body: describeChanges(ev, changes) };
      };

      // A fix to the event just added ("I said Wed not Thursday"): use it directly.
      const recentNow = currentRecent();
      if (recentNow && (!parsed.target || matchScore(parsed.target, recentNow.title) > 0) && !parsed.query_start) {
        const at = new Date(isAllDay(recentNow.start) ? `${recentNow.start}T00:00:00+08:00` : recentNow.start).getTime();
        const nearby = await listEvents(new Date(at - 3600 * 1000), new Date(at + 25 * 3600 * 1000));
        const ev = nearby.find((e) => e.id === recentNow.eventId);
        if (ev) {
          const entry = toEntry(ev);
          const id = stash(entry);
          await ctx.reply(actionPrompt(entry), { reply_markup: confirmKeyboard(id, entry) });
          return;
        }
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

// ---------- Screenshots ----------

// A photo, or an image sent as a file, is read for appointments and
// deadlines. Each one found becomes its own card; nothing is added untapped.
async function handleImage(ctx, mediaType) {
  if (!isAuthorized(ctx)) return;
  await ctx.replyWithChatAction("typing");
  try {
    const file = await ctx.getFile();
    if ((file.file_size ?? 0) > 5 * 1024 * 1024) {
      await ctx.reply("That image is over 5 MB. Send it as a photo instead of a file.");
      return;
    }
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    const { events } = await readScreenshot(data, mediaType, ctx.message.caption ?? "");

    const usable = events.filter((e) => e.title && isUsableFutureDate(e.start));
    if (usable.length === 0) {
      const past = events.length > 0 ? " Anything in it looks like it is already past." : "";
      await ctx.reply(`I couldn't find a date to add in that screenshot.${past} Add a caption like "Wed 3pm" if it's there.`);
      return;
    }
    for (const e of usable.slice(0, 5)) {
      const deadline = e.is_deadline;
      const event = {
        title: e.title,
        start: e.start,
        end: deadline ? "" : e.end || "",
        location: e.location || "",
        category: deadline ? "deadline" : e.category || "personal",
        description: e.evidence ? `From a screenshot: "${e.evidence}"` : "From a screenshot",
      };
      const notes = [];
      if (e.evidence) notes.push(`🔎 "${e.evidence}"`);
      if (e.date_basis === "relative_to_today") notes.push("⚠️ The screenshot shows no date, so I counted from today. Check the day.");
      const entry = { kind: "create", event, header: "🖼 From your screenshot. Add this?", footer: notes.join("\n") };
      const id = stash(entry);
      await ctx.reply(actionPrompt(entry), { reply_markup: confirmKeyboard(id, entry) });
    }
  } catch (err) {
    console.error("screenshot failed:", err);
    await ctx.reply("I couldn't read that image. Try a clearer screenshot, or type the details.");
  }
}

bot.on("message:photo", (ctx) => handleImage(ctx, "image/jpeg"));

bot.on("message:document", async (ctx) => {
  const type = ctx.message.document.mime_type ?? "";
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) return;
  await handleImage(ctx, type);
});

// ---------- Buttons ----------

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

// Category switch on a proposal: re-draw the same card with the new colour.
bot.callbackQuery(/^cat:([^:]+):(school|work|personal)$/, async (ctx) => {
  if (!isAuthorized(ctx)) return;
  const [, id, category] = ctx.match;
  const entry = pending.get(id);
  if (!entry || entry.kind !== "create") {
    await ctx.answerCallbackQuery({ text: "This one expired. Send it again." });
    await ctx.editMessageReplyMarkup();
    return;
  }
  entry.event.category = category;
  await ctx.answerCallbackQuery({ text: `Now ${CATEGORIES[category].name}` });
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
    if (entry.kind === "create" && entry.source === "email") {
      addDismissed({ title: entry.event.title, start: entry.event.start, kind: entry.event.category, undated: Boolean(entry.undated) });
      await ctx.answerCallbackQuery({ text: "Got it" });
      await ctx.editMessageText(`❌ Not needed. I won't ask about this again.\n\n📌 ${entry.event.title}`);
      return;
    }
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Cancelled, nothing changed.");
    return;
  }

  try {
    if (entry.kind === "create") {
      // Email proposals: a twin prompt may have been approved before this one.
      if (entry.source === "email") {
        const existing = await findOnCalendar(entry.event);
        if (existing) {
          await ctx.answerCallbackQuery({ text: "Already there" });
          await ctx.editMessageText(`✅ Already on your calendar\n\n📌 ${existing.summary ?? "(no title)"}\n🕐 ${eventWhen(existing)}`);
          return;
        }
      }
      const created = await createEvent(entry.event);
      if (entry.source !== "email") rememberEvent(created.calendarId, created.id, entry.event.title, entry.event.start);
      const reminder = entry.event.category === "deadline" ? "\n🔔 I'll remind you 3 days and 1 day before." : "";
      await ctx.answerCallbackQuery({ text: "Added!" });
      await ctx.editMessageText(`✅ Added to calendar\n\n${describeProposal(entry.event)}${reminder}\n\n${created.htmlLink ?? ""}`);
    } else if (entry.kind === "update") {
      const patched = await patchEvent(entry.calendarId, entry.eventId, entry.changes);
      rememberEvent(entry.calendarId, entry.eventId, entry.changes.title ?? patched?.summary ?? recentEvent?.title ?? "", entry.changes.start ?? patched?.start?.dateTime ?? patched?.start?.date ?? "");
      await ctx.answerCallbackQuery({ text: "Updated!" });
      await ctx.editMessageText(`✅ Updated\n\n${entry.body}`);
    } else {
      await deleteEvent(entry.calendarId, entry.eventId);
      await ctx.answerCallbackQuery({ text: "Deleted" });
      await ctx.editMessageText(`🗑 Deleted\n\n${entry.body}`);
    }
  } catch (err) {
    console.error(`${entry.kind} failed:`, err);
    await ctx.answerCallbackQuery({ text: "Failed" });
    await ctx.editMessageText("⚠️ Google Calendar said no. Check the server logs.");
  }
});

// ---------- Nightly briefing ----------

// "What happened in your inbox today", grouped by area of life.
async function inboxBriefingText() {
  const emails = await listRecentEmailSummaries();
  if (emails.length === 0) return "📬 Today in your inbox\n\nNo new email today.";
  const { sections } = await summariseInbox(emails);
  const icons = { School: "🎓", Work: "💼", Personal: "🏠", Money: "💳" };
  const blocks = sections
    .filter((s) => s.items.length > 0)
    .map((s) => `${icons[s.heading] ?? "•"} ${s.heading}\n${s.items.map((i) => `• ${i}`).join("\n")}`);
  if (blocks.length === 0) return `📬 Today in your inbox\n\n${emails.length} emails, nothing worth your time.`;
  return `📬 Today in your inbox\n\n${blocks.join("\n\n")}`;
}

async function sendDigest() {
  if (!config.telegramChatId) return;
  // Each half is sent even if the other fails, so a Gmail hiccup never
  // costs you tomorrow's schedule.
  try {
    await bot.api.sendMessage(config.telegramChatId, await inboxBriefingText());
  } catch (err) {
    console.error("inbox briefing failed:", err);
  }
  try {
    const { start, end } = dayRange(1);
    await bot.api.sendMessage(config.telegramChatId, await scheduleText(start, end, `🌙 Tomorrow, ${fmtDate(start)}`));
  } catch (err) {
    console.error("digest failed:", err);
  }
}

cron.schedule(`${config.digestMinute} ${config.digestHour} * * *`, sendDigest, {
  timezone: config.timezone,
});

// ---------- Gmail watcher ----------

let scanning = false;

// A deadline the email gives no date for. Nothing to add to the calendar, so
// the card asks for a date instead; "Not needed" stops it coming back.
async function proposeUndatedDeadline(result, email) {
  const today = nowLocalISO().slice(0, 10);
  const marker = { title: result.title, start: today };
  if (alreadyAskedUndated(result.title)) return;
  const entry = { kind: "create", source: "email", undated: true, event: { ...marker, category: "deadline" } };
  const pid = stash(entry);
  const kb = new InlineKeyboard().text("❌ Not needed", `cancel:${pid}`);
  await bot.api.sendMessage(
    config.telegramChatId,
    `⏰ Deadline in your email, no date given\nFrom: ${email.from}\nSubject: ${email.subject}\n\n📌 ${result.title}\n\nReply with a date to add it, e.g. "${result.title} by Friday".`,
    { reply_markup: kb },
  );
}

// Undated deadlines have no date to compare, so match on title alone.
function alreadyAskedUndated(title) {
  for (const entry of pending.values()) {
    if (entry.undated && similarTitles(title, entry.event.title)) return true;
  }
  return dismissedList().some((d) => d.undated && similarTitles(title, d.title));
}

async function scanEmails() {
  if (scanning || !config.telegramChatId) return;
  scanning = true;
  try {
    const messages = await listUnprocessedEmails();
    for (const { id } of messages) {
      const email = await getEmail(id);
      try {
        const result = await extractFromEmail(email);
        if (result.kind === "none" || !result.title) continue;
        const deadline = result.kind === "deadline";
        // A deadline with no date still matters (e.g. "you have yet to complete
        // your medical exam"): flag it so it isn't silently dropped.
        if (deadline && !result.start) {
          await proposeUndatedDeadline(result, email);
          continue;
        }
        // Dates come from the model, so check them before anything else, then
        // hold them against the sentence the model quoted from the email.
        if (isUsableFutureDate(result.start)) {
          const checked = reconcileWithEvidence(result.start, result.evidence, { deadline });
          result.start = checked.start;
          result.checkNotes = checked.notes;
        }
        if (!isUsableFutureDate(result.start)) {
          console.log(`skipping "${result.title}": unusable or past date "${result.start}" (${email.subject})`);
          continue;
        }
        const event = {
          title: result.title,
          start: result.start,
          end: deadline ? "" : result.end || "",
          location: result.location || "",
          category: deadline ? "deadline" : result.category,
          description: `From email: ${email.subject} (${email.from})${result.evidence ? `\n\n"${result.evidence}"` : ""}`,
        };
        // Reminder emails repeat things already handled: skip anything already
        // on the calendar, already awaiting a tap, or already turned down.
        if ((await findOnCalendar(event)) || alreadyAsked(event)) {
          console.log(`skipping duplicate: "${event.title}" (${email.subject})`);
          continue;
        }
        const quoteLines = [];
        if (result.evidence) {
          quoteLines.push(`🔎 "${result.evidence}"`);
          if (!evidenceInEmail(result.evidence, email.body)) quoteLines.push("⚠️ I couldn't find that exact wording in the email, check the date.");
        }
        quoteLines.push(...(result.checkNotes ?? []));
        const quote = quoteLines.join("\n");
        const entry = {
          kind: "create",
          source: "email",
          event,
          header: `${deadline ? "⏰ Deadline in your email" : "📧 Appointment in your email"}\nFrom: ${email.from}\nSubject: ${email.subject}`,
          footer: quote,
        };
        const pid = stash(entry);
        await bot.api.sendMessage(config.telegramChatId, actionPrompt(entry), { reply_markup: confirmKeyboard(pid, entry) });
      } catch (err) {
        console.error(`email ${id} failed:`, err);
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

try {
  const ids = await ensureCalendars();
  console.log(`calendars ready: ${Object.keys(ids).join(", ")}`);
} catch (err) {
  // Most likely the Google token predates the calendar permission. Events
  // still work, they just land on the primary calendar without colours.
  console.error("could not set up category calendars, using primary:", err.message);
}

bot.start({
  onStart: (me) => {
    console.log(`@${me.username} is running. Digest ${config.digestHour}:${String(config.digestMinute).padStart(2, "0")} ${config.timezone}, email scan every ${config.emailPollMinutes} min.`);
    // First scan shortly after boot so you see it working.
    setTimeout(scanEmails, 10_000);
  },
});
