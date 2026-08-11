const test = require("node:test");
const assert = require("node:assert/strict");

const { findNextPicketReplacementDate } = require("../utils/picketLeaveReplacement");

test("approved Thursday leave moves to Friday", () => {
  assert.equal(
    findNextPicketReplacementDate({
      afterDate: "2026-08-13",
      activeDayIds: [1, 2, 3, 4, 5]
    }),
    "2026-08-14"
  );
});

test("approved Friday leave moves to next Monday when weekends are inactive", () => {
  assert.equal(
    findNextPicketReplacementDate({
      afterDate: "2026-08-14",
      activeDayIds: [1, 2, 3, 4, 5]
    }),
    "2026-08-17"
  );
});

test("replacement skips holidays and dates already occupied by the student", () => {
  assert.equal(
    findNextPicketReplacementDate({
      afterDate: "2026-08-13",
      activeDayIds: [1, 2, 3, 4, 5],
      holidayDates: new Set(["2026-08-14"]),
      occupiedDates: new Set(["2026-08-17"])
    }),
    "2026-08-18"
  );
});

test("replacement never consumes the student's regular weekly occurrence", () => {
  assert.equal(
    findNextPicketReplacementDate({
      afterDate: "2026-08-13",
      activeDayIds: [1, 2, 3, 4, 5],
      excludedDayIds: [1],
      holidayDates: new Set(["2026-08-14"]),
      occupiedDates: new Set(["2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"])
    }),
    "2026-08-25"
  );
});
