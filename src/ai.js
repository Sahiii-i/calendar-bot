import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { nowLocalISO } from "./time.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Flat schema: unused fields come back as empty strings.
const MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["create_event", "query_schedule", "other"],
      description: "create_event: user wants something added to the calendar. query_schedule: user asks what is on their calendar. other: anything else.",
    },
    title: { type: "string", description: "Short event title, e.g. 'Zoom with Benson'. Empty unless create_event." },
    start: { type: "string", description: "Event start as ISO 8601 with +08:00 offset, e.g. 2026-07-18T15:00:00+08:00. Date-only YYYY-MM-DD for all-day events. Empty unless create_event." },
    end: { type: "string", description: "Event end, same format as start. If the user gave no duration, use start + 1 hour. Empty unless create_event or all-day." },
    location: { type: "string", description: "Location or meeting link if given, else empty." },
    query_start: { type: "string", description: "For query_schedule: ISO 8601 start of the range asked about. Else empty." },
    query_end: { type: "string", description: "For query_schedule: ISO 8601 end (exclusive) of the range. Else empty." },
    reply: { type: "string", description: "For intent 'other': one short friendly sentence telling the user what this bot can do. Else empty." },
  },
  required: ["intent", "title", "start", "end", "location", "query_start", "query_end", "reply"],
  additionalProperties: false,
};

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    has_event: {
      type: "boolean",
      description: "true only if this email contains a concrete appointment for the recipient: an interview, meeting, class, viewing, or booking with a specific date (and ideally time). Newsletters, promos, generic reminders and past events are false.",
    },
    title: { type: "string", description: "Short calendar title, e.g. 'Interview: Acme Corp'. Empty if has_event is false." },
    start: { type: "string", description: "ISO 8601 start with +08:00 offset, or YYYY-MM-DD if only a date is known. Empty if has_event is false." },
    end: { type: "string", description: "ISO 8601 end. If unknown, start + 1 hour. Empty if all-day or has_event false." },
    location: { type: "string", description: "Address, Zoom link or venue if present, else empty." },
  },
  required: ["has_event", "title", "start", "end", "location"],
  additionalProperties: false,
};

async function structured(system, userText, schema) {
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema } },
  });
  if (response.stop_reason === "refusal") {
    throw new Error("Model refused the request");
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return JSON.parse(text);
}

// Interpret a free-text Telegram message from the user.
export async function interpretMessage(text) {
  const system = [
    "You turn a personal assistant user's chat message into structured calendar data.",
    `Current date and time: ${nowLocalISO()} (${config.timezone}).`,
    "Resolve relative dates ('tomorrow', 'next Tuesday', 'later at 3') against that current time.",
    "Times the user gives are in that timezone. Never invent details the user did not state.",
  ].join(" ");
  return structured(system, text, MESSAGE_SCHEMA);
}

// Decide whether an email contains an appointment worth adding to the calendar.
export async function extractEventFromEmail({ from, subject, body }) {
  const system = [
    "You scan the user's incoming email for concrete appointments (interviews, meetings, classes, bookings).",
    `Current date and time: ${nowLocalISO()} (${config.timezone}). Assume this timezone unless the email states another.`,
    "Be conservative: only flag emails that clearly schedule something for the recipient at a specific future date.",
  ].join(" ");
  const userText = `From: ${from}\nSubject: ${subject}\n\n${body.slice(0, 4000)}`;
  return structured(system, userText, EMAIL_SCHEMA);
}
