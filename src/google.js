import { google } from "googleapis";
import { config } from "./config.js";

const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
oauth2.setCredentials({ refresh_token: config.google.refreshToken });

export const calendar = google.calendar({ version: "v3", auth: oauth2 });
export const gmail = google.gmail({ version: "v1", auth: oauth2 });

// ---------- Calendars ----------

// The bot keeps one Google calendar per kind of event, so the colour shows
// everywhere the calendar is synced (Apple Calendar ignores per-event colours).
// Colours are Google's calendar palette ids; any id from colors.get works.
export const CATEGORIES = {
  school: { name: "School", colorId: "9", emoji: "🔵" }, // blue
  work: { name: "Work", colorId: "2", emoji: "🟢" }, // green
  personal: { name: "Personal", colorId: "5", emoji: "🟡" }, // yellow
  deadline: { name: "Deadlines", colorId: "11", emoji: "🔴" }, // red
};

const calendarIds = {}; // category key -> calendar id

// Find the bot's calendars by name, creating any that are missing. Safe to run
// on every boot: an existing calendar is reused, never duplicated.
export async function ensureCalendars() {
  const res = await calendar.calendarList.list({ maxResults: 250 });
  const existing = res.data.items ?? [];
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const found = existing.find((c) => c.summary === cat.name && c.accessRole === "owner");
    if (found) {
      calendarIds[key] = found.id;
      continue;
    }
    const created = await calendar.calendars.insert({
      requestBody: { summary: cat.name, timeZone: config.timezone, description: "Managed by Aunty bot" },
    });
    calendarIds[key] = created.data.id;
    await calendar.calendarList.patch({
      calendarId: created.data.id,
      colorRgbFormat: false,
      requestBody: { colorId: cat.colorId, selected: true },
    });
    console.log(`created calendar "${cat.name}"`);
  }
  return calendarIds;
}

export function calendarIdFor(category) {
  return calendarIds[category] ?? "primary";
}

// Category key for a calendar id, or null for primary / anything else.
export function categoryOf(calendarId) {
  return Object.keys(calendarIds).find((k) => calendarIds[k] === calendarId) ?? null;
}

function allCalendarIds() {
  return ["primary", ...Object.values(calendarIds)];
}

// ---------- Events ----------

// Events across primary and the bot's calendars, sorted by start. Each event
// carries `calendarId` so updates and deletes go to the right calendar.
export async function listEvents(start, end) {
  const lists = await Promise.all(
    allCalendarIds().map(async (calendarId) => {
      const res = await calendar.events.list({
        calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      return (res.data.items ?? []).map((e) => ({ ...e, calendarId }));
    }),
  );
  return lists.flat().sort((a, b) => startMs(a) - startMs(b));
}

function startMs(e) {
  return new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00+08:00`).getTime();
}

export function isAllDay(start) {
  return /^\d{4}-\d{2}-\d{2}$/.test(start);
}

// Phone reminders for deadlines: 3 days and 1 day before. For an all-day
// deadline, Google counts back from midnight, so these land at 9am.
function deadlineReminders(allDay) {
  const minutes = allDay ? [3 * 1440 - 540, 1440 - 540] : [3 * 1440, 1440];
  return { useDefault: false, overrides: minutes.map((m) => ({ method: "popup", minutes: m })) };
}

// event: { title, start, end, location, description, category, recurrence? }
// recurrence is a list like ["RRULE:FREQ=WEEKLY;BYDAY=MO"], built in time.js.
// start/end are ISO datetimes, or YYYY-MM-DD for all-day.
// A deadline with a time is a 30 minute block ending at the due time.
export async function createEvent(event) {
  const allDay = isAllDay(event.start);
  const deadline = event.category === "deadline";
  let start = event.start;
  let end = event.end || (allDay ? "" : plusMinutes(event.start, 60));
  if (deadline && !allDay) {
    end = event.start;
    start = plusMinutes(event.start, -30);
  }
  const requestBody = {
    summary: event.title,
    location: event.location || undefined,
    description: event.description || undefined,
    start: allDay ? { date: start } : { dateTime: start, timeZone: config.timezone },
    end: allDay ? { date: nextDay(start) } : { dateTime: end, timeZone: config.timezone },
    reminders: deadline ? deadlineReminders(allDay) : undefined,
    recurrence: event.recurrence?.length ? event.recurrence : undefined,
  };
  const calendarId = calendarIdFor(event.category);
  const res = await calendar.events.insert({ calendarId, requestBody });
  return { ...res.data, calendarId };
}

// changes: { title?, start?, end?, location? } — only the fields being changed.
export async function patchEvent(calendarId, eventId, changes) {
  const requestBody = {};
  if (changes.title) requestBody.summary = changes.title;
  if (changes.location) requestBody.location = changes.location;
  if (changes.start) {
    const allDay = isAllDay(changes.start);
    requestBody.start = allDay
      ? { date: changes.start, dateTime: null }
      : { dateTime: changes.start, timeZone: config.timezone, date: null };
    requestBody.end = allDay
      ? { date: nextDay(changes.start), dateTime: null }
      : { dateTime: changes.end || plusMinutes(changes.start, 60), timeZone: config.timezone, date: null };
  } else if (changes.end) {
    requestBody.end = { dateTime: changes.end, timeZone: config.timezone, date: null };
  }
  const res = await calendar.events.patch({ calendarId, eventId, requestBody });
  return res.data;
}

export async function deleteEvent(calendarId, eventId) {
  await calendar.events.delete({ calendarId, eventId });
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function plusMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

// ---------- Gmail ----------

const PROCESSED_LABEL = "CalBot";
let processedLabelId = null;

// Primary and Updates. Updates is where NUS admin mail (hostel fees,
// Coursemology reminders) lands, and the bot used to miss it.
const INBOX_QUERY = "in:inbox -category:promotions -category:social -category:forums";

async function ensureLabel() {
  if (processedLabelId) return processedLabelId;
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = (res.data.labels ?? []).find((l) => l.name === PROCESSED_LABEL);
  if (existing) {
    processedLabelId = existing.id;
  } else {
    const created = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name: PROCESSED_LABEL, labelListVisibility: "labelHide", messageListVisibility: "hide" },
    });
    processedLabelId = created.data.id;
  }
  return processedLabelId;
}

// Recent inbox emails the bot hasn't looked at yet.
export async function listUnprocessedEmails() {
  await ensureLabel();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `${INBOX_QUERY} -label:${PROCESSED_LABEL} newer_than:2d`,
    maxResults: 25,
  });
  return res.data.messages ?? [];
}

// Everything that arrived in the last day, for the nightly briefing.
// Headers and snippet only: enough to summarise, cheap to send to the model.
export async function listRecentEmailSummaries(max = 40) {
  const res = await gmail.users.messages.list({ userId: "me", q: `${INBOX_QUERY} newer_than:1d`, maxResults: max });
  const ids = (res.data.messages ?? []).map((m) => m.id);
  return Promise.all(
    ids.map(async (id) => {
      const m = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });
      const headers = m.data.payload?.headers ?? [];
      const header = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      return { from: header("from"), subject: header("subject"), snippet: m.data.snippet ?? "" };
    }),
  );
}

export async function getEmail(id) {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const headers = res.data.payload?.headers ?? [];
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return {
    id,
    from: header("from"),
    subject: header("subject"),
    body: extractText(res.data.payload) || res.data.snippet || "",
  };
}

export async function markEmailProcessed(id) {
  const labelId = await ensureLabel();
  await gmail.users.messages.modify({
    userId: "me",
    id,
    requestBody: { addLabelIds: [labelId] },
  });
}

function extractText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }
  if (payload.parts) {
    // Prefer plain text parts; fall back to stripped HTML.
    for (const part of payload.parts) {
      const text = extractText(part);
      if (text) return text;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

function decode(b64url) {
  return Buffer.from(b64url, "base64url").toString("utf8");
}
