import assert from "node:assert/strict";
process.env.TELEGRAM_BOT_TOKEN ??= "x";
const { resolveDayWord, onDay, upcomingDaysTable } = await import("../src/time.js");

// The two real failures. 31 Oct 2026 is a Saturday.
assert.equal(resolveDayWord("next Thursday 12pm L&L second meeting", "2026-10-31"), "2026-11-05");
// Kevin / Coffee Hive: sent Mon 2 Nov, meant Wed 4 Nov
assert.equal(resolveDayWord("next wednesday 3pm meeting with Kevin Coffee Hive", "2026-11-02"), "2026-11-04");

assert.equal(resolveDayWord("zoom tomorrow 3pm", "2026-11-08"), "2026-11-09");
assert.equal(resolveDayWord("dinner tmr 7pm", "2026-11-08"), "2026-11-09");
assert.equal(resolveDayWord("day after tomorrow 9am gym", "2026-11-08"), "2026-11-10");
assert.equal(resolveDayWord("call tonight 9pm", "2026-11-08"), "2026-11-08");
assert.equal(resolveDayWord("Fri 2pm dentist", "2026-11-08"), "2026-11-13");
assert.equal(resolveDayWord("this thurs 4pm", "2026-11-12"), "2026-11-12"); // today is Thu
assert.equal(resolveDayWord("next thurs 4pm", "2026-11-12"), "2026-11-19");
assert.equal(resolveDayWord("thursday 4pm", "2026-11-12"), "2026-11-19");
assert.equal(resolveDayWord("next week Tuesday 10am", "2026-11-08"), "2026-11-10"); // Sun -> next Mon-Sun week
assert.equal(resolveDayWord("Tuesday next week 10am", "2026-11-04"), "2026-11-10");
// Nothing to correct: explicit date, two days, or none
assert.equal(resolveDayWord("Thursday 5 Nov 3pm", "2026-10-31"), null);
assert.equal(resolveDayWord("move Friday's meeting to Monday", "2026-11-08"), null);
assert.equal(resolveDayWord("i said Wed not thursday", "2026-11-02"), null);
assert.equal(resolveDayWord("lunch with Josh 1pm", "2026-11-08"), null);
// Words that contain day names do not count
assert.equal(resolveDayWord("monthly review with satisfied client", "2026-11-08"), null);

assert.equal(onDay("2026-11-06T12:00:00+08:00", "2026-11-05"), "2026-11-05T12:00:00+08:00");
assert.equal(onDay("2026-11-06", "2026-11-05"), "2026-11-05");
assert.match(upcomingDaysTable("2026-10-31"), /^Saturday 2026-10-31 \(today\); Sunday 2026-11-01 \(tomorrow\);.*Thursday 2026-11-05/);
console.log("all day checks pass");
