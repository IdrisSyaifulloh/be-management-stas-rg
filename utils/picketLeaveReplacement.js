function addIsoDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function findNextPicketReplacementDate({
  afterDate,
  activeDayIds = [],
  excludedDayIds = [],
  holidayDates = new Set(),
  occupiedDates = new Set(),
  maxDays = 14
} = {}) {
  const activeDays = new Set(activeDayIds.map(Number));
  const excludedDays = new Set(excludedDayIds.map(Number));
  for (let offset = 1; offset <= maxDays; offset += 1) {
    const date = addIsoDays(afterDate, offset);
    const dayId = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!activeDays.has(dayId)) continue;
    if (excludedDays.has(dayId)) continue;
    if (holidayDates.has(date) || occupiedDates.has(date)) continue;
    return date;
  }
  return null;
}

module.exports = {
  addIsoDays,
  findNextPicketReplacementDate
};
