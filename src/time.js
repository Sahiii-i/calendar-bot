import { config } from "./config.js";

const TZ = config.timezone;
// Fixed +08:00 works for Singapore (no DST). If TIMEZONE changes to a DST zone,
// swap this for a proper tz library.
const TZ_OFFSET = "+08:00";

function localParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return parts;
}

export function nowLocalISO() {
  const p = localParts();
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:00${TZ_OFFSET}`;
}

// Start of a local day, offset by N days from today. Returns a Date.
export function dayStart(offsetDays = 0) {
  const p = localParts();
  const base = new Date(`${p.year}-${p.month}-${p.day}T00:00:00${TZ_OFFSET}`);
  base.setDate(base.getDate() + offsetDays);
  return base;
}

export function dayRange(offsetDays = 0, spanDays = 1) {
  const start = dayStart(offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + spanDays);
  return { start, end };
}

export function fmtDate(date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

export function fmtTime(date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).toLowerCase().replace(" ", "");
}

export function fmtDateTime(date) {
  return `${fmtDate(date)}, ${fmtTime(date)}`;
}

// True if `value` is a well-formed date or datetime that is today or later.
// Model output is checked here before it ever reaches the calendar.
export function isUsableFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z))?$/.test(value ?? "")) return false;
  const d = new Date(value.length === 10 ? `${value}T23:59:59${TZ_OFFSET}` : value);
  return !Number.isNaN(d.getTime()) && d >= dayStart(0);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// Clock times written in a piece of text, as "HH:MM" (24h).
// Handles "11:59am", "11.59 am", "3pm", "15:00", "noon", "midnight".
export function timesInText(text) {
  const out = [];
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/gi;
  for (const m of (text ?? "").matchAll(re)) {
    let h;
    let min;
    if (m[6]) {
      [h, min] = m[6].toLowerCase() === "noon" ? [12, 0] : [0, 0];
    } else if (m[3]) {
      h = Number(m[1]) % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
      min = Number(m[2] ?? 0);
    } else {
      h = Number(m[4]);
      min = Number(m[5]);
    }
    if (h < 24 && min < 60) out.push(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return out;
}

// Does the quoted text mention this calendar date (e.g. "22 October", "Oct 22", "22/10")?
function mentionsDate(text, ymd) {
  const t = (text ?? "").toLowerCase();
  const [, mo, d] = ymd.split("-").map(Number);
  const month = MONTHS[mo - 1];
  const monthRe = `(${month}|${month.slice(0, 3)})`;
  const patterns = [
    new RegExp(`\\b0?${d}(st|nd|rd|th)?\\s+(of\\s+)?${monthRe}`),
    new RegExp(`${monthRe}\\.?\\s+0?${d}(st|nd|rd|th)?\\b`),
    new RegExp(`\\b0?${d}[/.-]0?${mo}\\b`),
  ];
  return patterns.some((p) => p.test(t));
}

// The model reads the date; the quoted sentence is the source of truth.
// Returns the start to use plus a note for the card when something was off.
// - A time the quote doesn't contain is corrected when the quote has exactly
//   one time, otherwise flagged.
// - A date the quote doesn't mention is flagged, never guessed.
// - A deadline whose quote has no time becomes an all-day deadline.
export function reconcileWithEvidence(start, evidence, { deadline }) {
  const notes = [];
  let fixed = start;
  if (!evidence) return { start: fixed, notes: ["⚠️ No date quote found, check the email."] };
  if (!mentionsDate(evidence, start.slice(0, 10))) {
    notes.push("⚠️ The date doesn't match the quote, check it.");
  }
  if (start.length > 10) {
    const times = timesInText(evidence);
    const hm = start.slice(11, 16);
    if (times.length === 0) {
      if (deadline) fixed = start.slice(0, 10);
    } else if (!times.includes(hm)) {
      if (times.length === 1) {
        fixed = `${start.slice(0, 10)}T${times[0]}:00${TZ_OFFSET}`;
        notes.push(`🛠 Time corrected to ${times[0]} to match the email.`);
      } else {
        notes.push("⚠️ The time doesn't match the quote, check it.");
      }
    }
  }
  return { start: fixed, notes };
}

// ---------- Relative day words in the user's own message ----------
// The model is bad at weekday arithmetic ("next Thursday" on a Saturday came
// back as Friday). So the day the user named is worked out here, in code, and
// the model's date is corrected to it.

const WEEKDAYS = [
  ["sun", "sunday"],
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "weds", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
];
const WD_ALT = WEEKDAYS.flat().sort((a, b) => b.length - a.length).join("|");

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(ymd) {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

function weekdayIndex(word) {
  return WEEKDAYS.findIndex((names) => names.includes(word.toLowerCase()));
}

export function todayLocalYMD() {
  return nowLocalISO().slice(0, 10);
}

// Does the text give an explicit calendar date ("6 Nov", "Nov 6", "6/11")?
// Then the model has the date in front of it and the weekday word is not needed.
function hasExplicitDate(text) {
  const t = text.toLowerCase();
  const mon = MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|");
  return (
    new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?(${mon})\\b`).test(t) ||
    new RegExp(`\\b(${mon})\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b`).test(t) ||
    /\b\d{1,2}\/\d{1,2}\b/.test(t)
  );
}

// The single calendar day the message names in relative words, or null when
// it names none, names several, or gives an explicit date.
// Rules (Sahi's usage):
//   today / tonight -> today; tomorrow / tmr / tmrw -> +1; day after tomorrow -> +2
//   "Thursday", "this Thursday", "next Thursday", "coming Thursday" -> the first
//     Thursday after today ("this Thursday" on a Thursday is today)
//   "next week Thursday", "Thursday next week" -> Thursday of next Mon-Sun week
export function resolveDayWord(text, today = todayLocalYMD()) {
  if (!text || hasExplicitDate(text)) return null;
  const t = text.toLowerCase();
  const found = new Set();

  if (/\bday after (tomorrow|tmr|tmrw)\b/.test(t)) found.add(addDays(today, 2));
  else if (/\b(tomorrow|tmr|tmrw|tml)\b/.test(t)) found.add(addDays(today, 1));
  if (/\b(today|tonight)\b/.test(t)) found.add(today);

  const re = new RegExp(`\\b(?:(next week)\\s+|(this|next|coming|the coming)\\s+)?(${WD_ALT})\\b(\\s+next week)?`, "g");
  for (const m of t.matchAll(re)) {
    const target = weekdayIndex(m[3]);
    const now = weekdayOf(today);
    if (m[1] || m[4]) {
      // Monday of next week, then that weekday.
      const toMonday = ((8 - now) % 7) || 7;
      const monday = addDays(today, toMonday);
      found.add(addDays(monday, (target + 6) % 7));
    } else {
      let ahead = (target - now + 7) % 7;
      if (ahead === 0 && m[2] !== "this") ahead = 7;
      found.add(addDays(today, ahead));
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// Move an ISO date or datetime onto another calendar day, keeping its time.
export function onDay(iso, ymd) {
  if (!iso) return iso;
  return ymd + iso.slice(10);
}

// A two-week lookup the model can read instead of counting weekdays.
export function upcomingDaysTable(today = todayLocalYMD()) {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    rows.push(`${names[weekdayOf(d)]} ${d}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  }
  return rows.join("; ");
}
