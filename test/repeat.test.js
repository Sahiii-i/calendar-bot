import assert from "node:assert/strict";
const { buildRRule, describeRepeat, alignToWeekdays } = await import("../src/time.js");
const R = (o) => ({ freq: "none", interval: 1, weekdays: [], monthly_by: "", until: "", count: 0, ...o });

assert.equal(buildRRule(R({}), "2026-11-09T07:00:00+08:00"), null);
// Claude invoice: monthly on the 3rd, all day
assert.equal(buildRRule(R({ freq: "monthly", monthly_by: "day_of_month" }), "2026-12-03"), "RRULE:FREQ=MONTHLY;BYMONTHDAY=3");
assert.equal(describeRepeat(R({ freq: "monthly", monthly_by: "day_of_month" }), "2026-12-03"), "Every month on the 3rd");
// gym Mon and Wed, start given on a Sunday moves to Monday
const gym = R({ freq: "weekly", weekdays: ["WE", "MO"] });
assert.equal(alignToWeekdays("2026-11-08T07:00:00+08:00", gym), "2026-11-09T07:00:00+08:00");
assert.equal(buildRRule(gym, "2026-11-09T07:00:00+08:00"), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
assert.equal(describeRepeat(gym, "2026-11-09T07:00:00+08:00"), "Every week on Mon, Wed");
// every other Thursday until 17 Dec, timed: UNTIL in UTC
assert.equal(buildRRule(R({ freq: "weekly", interval: 2, until: "2026-12-17" }), "2026-11-12T15:00:00+08:00"), "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261217T155959Z");
assert.match(describeRepeat(R({ freq: "weekly", interval: 2, until: "2026-12-17" }), "2026-11-12T15:00:00+08:00"), /^Every 2 weeks on Thu until Thu, 17 Dec$/);
// first Monday of each month; last Friday
assert.equal(buildRRule(R({ freq: "monthly", monthly_by: "nth_weekday" }), "2026-12-07T10:00:00+08:00"), "RRULE:FREQ=MONTHLY;BYDAY=1MO");
assert.equal(buildRRule(R({ freq: "monthly", monthly_by: "nth_weekday" }), "2026-11-27T10:00:00+08:00"), "RRULE:FREQ=MONTHLY;BYDAY=4FR");
assert.equal(buildRRule(R({ freq: "monthly", monthly_by: "last_weekday" }), "2026-11-27T10:00:00+08:00"), "RRULE:FREQ=MONTHLY;BYDAY=-1FR");
assert.equal(describeRepeat(R({ freq: "monthly", monthly_by: "last_weekday" }), "2026-11-27T10:00:00+08:00"), "Every month on the last Fri");
assert.equal(describeRepeat(R({ freq: "monthly", monthly_by: "nth_weekday" }), "2026-12-07T10:00:00+08:00"), "Every month on the 1st Mon");
// daily for 6 times, count wins over until
assert.equal(buildRRule(R({ freq: "daily", count: 6, until: "2026-12-01" }), "2026-11-09"), "RRULE:FREQ=DAILY;COUNT=6");
assert.equal(describeRepeat(R({ freq: "daily", count: 6 }), "2026-11-09"), "Every day, 6 times");
assert.equal(describeRepeat(R({ freq: "monthly", monthly_by: "day_of_month" }), "2026-12-11"), "Every month on the 11th");
console.log("all repeat checks pass");
