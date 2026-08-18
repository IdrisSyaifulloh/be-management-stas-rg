const { query } = require("../db/pool");
const { getSettingsAsync } = require("../config/systemSettingsStore");
const { getHolidayRules, normalizeHolidayDate } = require("./holidays");

function runQuery(executor, text, params) {
  if (typeof executor === "function") return executor(text, params);
  return executor.query(text, params);
}

function mapSystemPicketHoliday(item) {
  const date = normalizeHolidayDate(item?.date);
  if (!date || item?.active === false) return null;
  return {
    id: `system:${date}`,
    date,
    holiday_date: date,
    holidayDate: date,
    name: String(item?.name || "Libur Kampus"),
    notes: null,
    type: item?.type || "custom",
    source: "system",
    holiday_source: "system",
    holidaySource: "system",
    editable: false,
    is_editable: false,
    isEditable: false
  };
}

function mapSpecificPicketHoliday(row) {
  if (!row) return null;
  const date = normalizeHolidayDate(row.date || row.holiday_date_text || row.holiday_date);
  if (!date) return null;
  return {
    id: row.id,
    date,
    holiday_date: date,
    holidayDate: date,
    name: String(row.name || "Libur Piket"),
    notes: row.notes || null,
    source: "picket",
    holiday_source: "picket",
    holidaySource: "picket",
    editable: true,
    is_editable: true,
    isEditable: true,
    created_by: row.created_by || null,
    createdBy: row.created_by || null,
    updated_by: row.updated_by || null,
    updatedBy: row.updated_by || null,
    created_at: row.created_at || null,
    createdAt: row.created_at || null,
    updated_at: row.updated_at || null,
    updatedAt: row.updated_at || null
  };
}

function mergeEffectivePicketHolidays({ settings = {}, picketHolidays = [] } = {}) {
  const rules = getHolidayRules(settings);
  const byDate = new Map();

  for (const item of picketHolidays) {
    const holiday = mapSpecificPicketHoliday(item);
    if (holiday) byDate.set(holiday.date, holiday);
  }

  if (rules.excludeHolidaysFromWorkdays !== false) {
    for (const item of rules.holidays) {
      const holiday = mapSystemPicketHoliday(item);
      if (holiday) byDate.set(holiday.date, holiday);
    }
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function findEffectivePicketHoliday(holidays, date) {
  const normalizedDate = normalizeHolidayDate(date);
  if (!normalizedDate) return null;
  return (holidays || []).find((holiday) => holiday.date === normalizedDate) || null;
}

function getEffectivePicketHolidayDateSet(holidays) {
  return new Set((holidays || []).map((holiday) => holiday.date).filter(Boolean));
}

function isPicketLockCoveredByEffectiveHoliday(lock, holidays) {
  const reason = String(lock?.reason || "");
  if (!["PICKET_SUBMISSION_MISSING", "PICKET_SUBMISSION_INVALID"].includes(reason)) return false;
  return getEffectivePicketHolidayDateSet(holidays).has(
    normalizeHolidayDate(lock?.lock_date || lock?.lockDate || lock?.date)
  );
}

async function fetchSpecificPicketHolidays({ startDate = null, endDate = null, executor = query } = {}) {
  const tableCheck = await runQuery(
    executor,
    "SELECT to_regclass('public.picket_holidays') AS picket_holidays"
  );
  if (!tableCheck.rows[0]?.picket_holidays) return [];
  const params = [];
  const clauses = [];
  if (startDate) {
    params.push(normalizeHolidayDate(startDate));
    clauses.push(`holiday_date >= $${params.length}::date`);
  }
  if (endDate) {
    params.push(normalizeHolidayDate(endDate));
    clauses.push(`holiday_date <= $${params.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await runQuery(
    executor,
    `
    SELECT *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
    FROM picket_holidays
    ${where}
    ORDER BY holiday_date ASC
    `,
    params
  );
  return result.rows.map(mapSpecificPicketHoliday);
}

async function listEffectivePicketHolidays({
  startDate = null,
  endDate = null,
  settings = null,
  executor = query
} = {}) {
  const activeSettings = settings || await getSettingsAsync();
  const picketHolidays = await fetchSpecificPicketHolidays({ startDate, endDate, executor });
  const effective = mergeEffectivePicketHolidays({ settings: activeSettings, picketHolidays });
  const normalizedStart = normalizeHolidayDate(startDate);
  const normalizedEnd = normalizeHolidayDate(endDate);
  return effective.filter((holiday) =>
    (!normalizedStart || holiday.date >= normalizedStart) &&
    (!normalizedEnd || holiday.date <= normalizedEnd)
  );
}

async function getEffectivePicketHolidayByDate(date, options = {}) {
  const normalizedDate = normalizeHolidayDate(date);
  if (!normalizedDate) return null;
  const holidays = await listEffectivePicketHolidays({
    ...options,
    startDate: normalizedDate,
    endDate: normalizedDate
  });
  return findEffectivePicketHoliday(holidays, normalizedDate);
}

module.exports = {
  fetchSpecificPicketHolidays,
  findEffectivePicketHoliday,
  getEffectivePicketHolidayByDate,
  getEffectivePicketHolidayDateSet,
  isPicketLockCoveredByEffectiveHoliday,
  listEffectivePicketHolidays,
  mapSpecificPicketHoliday,
  mapSystemPicketHoliday,
  mergeEffectivePicketHolidays
};
