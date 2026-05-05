function formatIsoDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftToJakarta(date = new Date()) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000);
}

function getJakartaDateIso(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getJakartaWeekBounds(date = new Date()) {
  const jakartaDate = shiftToJakarta(date);
  const dayIndex = jakartaDate.getUTCDay();
  const daysSinceMonday = (dayIndex + 6) % 7;
  const monday = new Date(jakartaDate.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);

  return {
    startDate: formatIsoDate(monday),
    endDate: formatIsoDate(sunday)
  };
}

function getPreviousJakartaWeekBounds(date = new Date()) {
  const previousWeekAnchor = new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000);
  return getJakartaWeekBounds(previousWeekAnchor);
}

module.exports = {
  getJakartaDateIso,
  getJakartaWeekBounds,
  getPreviousJakartaWeekBounds,
  shiftToJakarta
};
