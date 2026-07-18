import { google } from "googleapis";
import { config } from "./config.js";

const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
oauth2.setCredentials({ refresh_token: config.google.refreshToken });

export const calendar = google.calendar({ version: "v3", auth: oauth2 });
export const gmail = google.gmail({ version: "v1", auth: oauth2 });

// ---------- Calendar ----------

export async function listEvents(start, end) {
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return res.data.items ?? [];
}

// event: { title, start, end, location, description }
// start/end are ISO datetimes, or YYYY-MM-DD for all-day.
export async function createEvent(event) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(event.start);
  const requestBody = {
    summary: event.title,
    location: event.location || undefined,
    description: event.description || undefined,
    start: allDay
      ? { date: event.start }
      : { dateTime: event.start, timeZone: config.timezone },
    end: allDay
      ? { date: nextDay(event.start) }
      : { dateTime: event.end || plusOneHour(event.start), timeZone: config.timezone },
  };
  const res = await calendar.events.insert({ calendarId: "primary", requestBody });
  return res.data;
}

// changes: { title?, start?, end?, location? } — only the fields being changed.
export async function patchEvent(eventId, changes) {
  const requestBody = {};
  if (changes.title) requestBody.summary = changes.title;
  if (changes.location) requestBody.location = changes.location;
  if (changes.start) {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(changes.start);
    requestBody.start = allDay
      ? { date: changes.start, dateTime: null }
      : { dateTime: changes.start, timeZone: config.timezone, date: null };
    requestBody.end = allDay
      ? { date: nextDay(changes.start), dateTime: null }
      : { dateTime: changes.end || plusOneHour(changes.start), timeZone: config.timezone, date: null };
  } else if (changes.end) {
    requestBody.end = { dateTime: changes.end, timeZone: config.timezone, date: null };
  }
  const res = await calendar.events.patch({ calendarId: "primary", eventId, requestBody });
  return res.data;
}

export async function deleteEvent(eventId) {
  await calendar.events.delete({ calendarId: "primary", eventId });
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function plusOneHour(iso) {
  const d = new Date(iso);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

// ---------- Gmail ----------

const PROCESSED_LABEL = "CalBot";
let processedLabelId = null;

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

// Recent primary-inbox emails the bot hasn't looked at yet.
export async function listUnprocessedEmails() {
  await ensureLabel();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `in:inbox category:primary -label:${PROCESSED_LABEL} newer_than:2d`,
    maxResults: 15,
  });
  return res.data.messages ?? [];
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
