const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ACCESS_LOCK_REASON_CHECKOUT_MISSING_22,
  mapAccessLockRow
} = require("../utils/studentAccessLocks");
const {
  normalizeTimeValue,
  getJakartaNowParts
} = require("../jobs/autoCheckoutScheduler");

test("CHECKOUT_MISSING_22 reason maps to correct label and message", () => {
  const row = {
    id: "SAL-2026-09-10-CHECKOUT_MISSING_22-STD-1",
    student_id: "STD-1",
    lock_date: "2026-09-10",
    reason: ACCESS_LOCK_REASON_CHECKOUT_MISSING_22,
    status: "LOCKED",
    locked: true,
    active: true,
    locked_at: new Date().toISOString()
  };

  const mapped = mapAccessLockRow(row);
  assert.equal(mapped.locked, true);
  assert.equal(mapped.active, true);
  assert.equal(mapped.reason, "CHECKOUT_MISSING_22");
  assert.equal(mapped.reasonLabel, "Belum Checkout Sampai 22.00 WIB");
  assert.match(mapped.reasonDetail, /22\.00 WIB/);
});

test("normalizeTimeValue parses valid HH:mm and falls back to 22:00", () => {
  assert.equal(normalizeTimeValue("21:30"), "21:30");
  assert.equal(normalizeTimeValue("22:00"), "22:00");
  assert.equal(normalizeTimeValue("invalid"), "22:00");
  assert.equal(normalizeTimeValue(null), "22:00");
});

test("getJakartaNowParts returns date and time strings in Jakarta timezone", () => {
  const fixedDate = new Date("2026-09-10T15:00:00.000Z"); // 22:00 Jakarta
  const parts = getJakartaNowParts(fixedDate);
  assert.equal(parts.date, "2026-09-10");
  assert.equal(parts.time, "22:00");
});
