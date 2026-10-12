import assert from "node:assert/strict";
const { timesInText, reconcileWithEvidence } = await import("../src/time.js");
assert.deepEqual(timesInText("End Date: Thursday, 22 October 2026, 11:59 am (Singapore time)"), ["11:59"]);
assert.deepEqual(timesInText("Monday, 19 October 2026, 8.00am - 3.00pm"), ["08:00", "15:00"]);
assert.deepEqual(timesInText("by 12 noon"), ["12:00"]);
assert.deepEqual(timesInText("at 3pm"), ["15:00"]);
assert.deepEqual(timesInText("11:59pm"), ["23:59"]);
assert.deepEqual(timesInText("12am"), ["00:00"]);
assert.deepEqual(timesInText("2 October to 31 October 2026"), []);
// hostel fee: model said 23:59, email says 11:59 am
let r = reconcileWithEvidence("2026-10-22T23:59:00+08:00", "End Date: Thursday, 22 October 2026, 11:59 am (Singapore time)", { deadline: true });
assert.equal(r.start, "2026-10-22T11:59:00+08:00"); assert.equal(r.notes.length, 1);
// correct read is left alone
r = reconcileWithEvidence("2026-10-19T08:00:00+08:00", "Monday, 19 October 2026, 8.00am - 3.00pm", { deadline: false });
assert.equal(r.start, "2026-10-19T08:00:00+08:00"); assert.deepEqual(r.notes, []);
// deadline with no time in quote becomes all day
r = reconcileWithEvidence("2026-10-31T23:59:59+08:00", "Application period - 2 October to 31 October 2026", { deadline: true });
assert.equal(r.start, "2026-10-31"); assert.deepEqual(r.notes, []);
// wrong date is flagged, not changed
r = reconcileWithEvidence("2026-10-23T11:59:00+08:00", "22 October 2026, 11:59 am", { deadline: true });
assert.equal(r.start, "2026-10-23T11:59:00+08:00"); assert.match(r.notes[0], /date/);
// two times, neither matches: flag
r = reconcileWithEvidence("2026-10-19T09:00:00+08:00", "19 Oct, 8am to 3pm", { deadline: false });
assert.match(r.notes[0], /time/);
// other date formats
assert.deepEqual(reconcileWithEvidence("2026-10-22", "due Oct 22", { deadline: true }).notes, []);
assert.deepEqual(reconcileWithEvidence("2026-10-22", "due 22/10/2026", { deadline: true }).notes, []);
console.log("all time checks pass");
