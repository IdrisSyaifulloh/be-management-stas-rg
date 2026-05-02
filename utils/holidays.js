function normalizeHolidayDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value || "").trim();
  if (!text) return "";

  const direct = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (direct) return direct[0];

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function normalizeHolidayItem(item) {
  if (typeof item === "string") {
    const date = normalizeHolidayDate(item);
    return date
      ? { date, name: "Tanggal Merah", type: "custom", active: true }
      : null;
  }

  if (!item || typeof item !== "object") return null;

  const date = normalizeHolidayDate(
    item.date || item.tanggal || item.holidayDate || item.holiday_date
  );

  if (!date) return null;

  return {
    date,
    name: String(item.name || item.nama || item.title || item.keterangan || "Tanggal Merah"),
    type: String(item.type || item.jenis || "custom"),
    active: item.active === undefined ? true : Boolean(item.active)
  };
}

function normalizeHolidays(value) {
  if (!Array.isArray(value)) return [];

  const byDate = new Map();
  for (const item of value) {
    const holiday = normalizeHolidayItem(item);
    if (!holiday) continue;
    byDate.set(holiday.date, holiday);
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function getHolidayRules(settings) {
  const attendanceRules = settings?.attendanceRules || {};

  return {
    excludeHolidaysFromWorkdays: attendanceRules.excludeHolidaysFromWorkdays !== false,
    holidays: normalizeHolidays(attendanceRules.holidays || settings?.holidays)
  };
}

function findHolidayForDate(holidays, isoDate) {
  const date = normalizeHolidayDate(isoDate);
  if (!date) return null;

  return normalizeHolidays(holidays).find((holiday) => holiday.active !== false && holiday.date === date) || null;
}

function isWeekendIsoDate(isoDate) {
  const date = normalizeHolidayDate(isoDate);
  if (!date) return false;

  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();

  return day === 0 || day === 6;
}

function findNonWorkingDayForDate(settings, isoDate) {
  const rules = getHolidayRules(settings);
  const date = normalizeHolidayDate(isoDate);

  if (!date) return null;

  const holiday = rules.excludeHolidaysFromWorkdays
    ? findHolidayForDate(rules.holidays, date)
    : null;
  if (holiday) return holiday;

  if (isWeekendIsoDate(date)) {
    return {
      date,
      name: "Akhir Pekan",
      type: "weekend",
      active: true
    };
  }

  return null;
}

module.exports = {
  findHolidayForDate,
  findNonWorkingDayForDate,
  getHolidayRules,
  isWeekendIsoDate,
  normalizeHolidayDate,
  normalizeHolidays
};
