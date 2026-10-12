import fs from "fs";
import path from "path";

// Small JSON file for things that must survive a redeploy, e.g. emails Sahi
// said "not needed" to. On Railway, DATA_DIR points at a mounted volume.
const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "state.json");

let state = { dismissed: [] };

try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch {
  // First run, or no volume yet: start empty.
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("could not save state (dismissals will reset on redeploy):", err.message);
  }
}

// Proposals Sahi turned down: { title, start, kind }.
export function dismissedList() {
  return state.dismissed;
}

export function addDismissed(entry) {
  state.dismissed.push(entry);
  if (state.dismissed.length > 500) state.dismissed.shift();
  save();
}
