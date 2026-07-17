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
