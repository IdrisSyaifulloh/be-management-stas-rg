function getJakartaDateIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function parseIsoDate(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function normalizeToIsoDate(value) {
  if (value instanceof Date) {
    return formatIsoDate(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())));
  }

  return String(value || "").slice(0, 10);
}

function formatIsoDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function maxIsoDate(...values) {
  return values
    .map(normalizeToIsoDate)
    .filter(Boolean)
    .sort()
    .pop() || null;
}

function minIsoDate(...values) {
  return values
    .map(normalizeToIsoDate)
    .filter(Boolean)
    .sort()
    .shift() || null;
}

function getMonthBounds(isoDate) {
  const date = parseIsoDate(isoDate);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month + 1, 0));

  return {
    startDate: formatIsoDate(monthStart),
    endDate: formatIsoDate(monthEnd)
  };
}

function resolveAttendanceRange(startDate, endDate) {
  if (startDate && endDate) {
    return { startDate, endDate };
  }

  if (startDate) {
    return { startDate, endDate: startDate };
  }

  if (endDate) {
    return { startDate: endDate, endDate };
  }

  return getMonthBounds(getJakartaDateIso());
}

function formatAttendanceTime(timestamp) {
  if (!timestamp) return "-";

  return new Date(timestamp).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta"
  });
}

function formatAttendanceDateLabel(isoDate) {
  const date = parseIsoDate(isoDate);
  const dayName = date.toLocaleDateString("id-ID", {
    weekday: "short",
    timeZone: "UTC"
  });
  const day = String(date.getUTCDate()).padStart(2, "0");
  const monthYear = date.toLocaleDateString("id-ID", {
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });

  return `${dayName}, ${day} ${monthYear}`;
}

function formatAttendanceDuration(checkInAt, checkOutAt) {
  if (!checkInAt || !checkOutAt) return "-";

  const diffMs = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}j ${remainingMinutes}m`;
}

function normalizeLeaveStatus(type) {
  switch (String(type || "").toLowerCase()) {
    case "izin":
      return "Izin";
    case "sakit":
      return "Sakit";
    case "wfh":
      return "WFH";
    case "cuti":
    default:
      return "Cuti";
  }
}

function getStatusColor(status) {
  switch (status) {
    case "Hadir":
    case "Selesai":
    case "Berlangsung":
      return "green";
    case "Cuti":
      return "amber";
    case "Izin":
      return "blue";
    case "Sakit":
      return "rose";
    case "WFH":
      return "sky";
    case "Libur":
      return "gray";
    default:
      return "red";
  }
}

function buildLeaveDateMap(leaveRows, rangeStart, rangeEnd) {
  const leaveMap = new Map();
  const rangeStartDate = parseIsoDate(rangeStart);
  const rangeEndDate = parseIsoDate(rangeEnd);

  for (const row of leaveRows || []) {
    const leaveStart = parseIsoDate(normalizeToIsoDate(row.periode_start));
    const leaveEnd = parseIsoDate(normalizeToIsoDate(row.periode_end));

    const currentStart = leaveStart > rangeStartDate ? leaveStart : rangeStartDate;
    const currentEnd = leaveEnd < rangeEndDate ? leaveEnd : rangeEndDate;
    const status = normalizeLeaveStatus(row.jenis_pengajuan);

    for (
      let current = new Date(currentStart);
      current <= currentEnd;
      current.setUTCDate(current.getUTCDate() + 1)
    ) {
      leaveMap.set(formatIsoDate(current), status);
    }
  }

  return leaveMap;
}

function buildAttendanceHistory({ startDate, endDate, attendanceRows, leaveRows, activeStartDate }) {
  const effectiveStartDate = activeStartDate ? maxIsoDate(startDate, activeStartDate) : startDate;

  const attendanceMap = new Map(
    (attendanceRows || []).map((row) => [
      row.attendance_date_text || row.attendance_date,
      row
    ])
  );

  const leaveMap = buildLeaveDateMap(leaveRows || [], effectiveStartDate, endDate);
  const leaveSet = new Set(leaveMap.keys());

  const history = [];
  const summary = {
    hadir: 0,
    cuti: 0,
    izin: 0,
    sakit: 0,
    wfh: 0,
    tidakHadir: 0,
    libur: 0
  };

  const start = parseIsoDate(effectiveStartDate);
  const end = parseIsoDate(endDate);

  if (start > end) {
    return {
      attendanceMap,
      leaveSet,
      leaveMap,
      history,
      summary
    };
  }

  for (
    let current = new Date(start);
    current <= end;
    current.setUTCDate(current.getUTCDate() + 1)
  ) {
    const isoDate = formatIsoDate(current);
    const attendanceItem = attendanceMap.get(isoDate);
    const isWeekend = current.getUTCDay() === 0 || current.getUTCDay() === 6;

    let status = "Tidak Hadir";
    let statusColor = "red";

    if (attendanceItem) {
      status = attendanceItem.status || "Hadir";
      statusColor = getStatusColor(status);

      if (status === "Hadir") {
        summary.hadir += 1;
      } else if (status === "Cuti") {
        summary.cuti += 1;
      } else if (status === "Izin") {
        summary.izin += 1;
      } else if (status === "Sakit") {
        summary.sakit += 1;
      } else if (status === "WFH") {
        summary.wfh += 1;
      } else {
        summary.tidakHadir += 1;
      }
    } else if (isWeekend) {
      status = "Libur";
      statusColor = "gray";
      summary.libur += 1;
    } else if (leaveSet.has(isoDate)) {
      status = leaveMap.get(isoDate) || "Cuti";
      statusColor = getStatusColor(status);

      if (status === "Izin") {
        summary.izin += 1;
      } else if (status === "Sakit") {
        summary.sakit += 1;
      } else if (status === "WFH") {
        summary.wfh += 1;
      } else {
        summary.cuti += 1;
      }
    } else {
      summary.tidakHadir += 1;
    }

    history.push({
      id: attendanceItem?.id || null,
      isoDate,
      dateLabel: formatAttendanceDateLabel(isoDate),
      in: formatAttendanceTime(attendanceItem?.check_in_at),
      out: formatAttendanceTime(attendanceItem?.check_out_at),
      duration: formatAttendanceDuration(attendanceItem?.check_in_at, attendanceItem?.check_out_at),
      status,
      statusColor,
      autoCheckout: Boolean(attendanceItem?.auto_checkout),
      checkoutSource: attendanceItem?.checkout_source || null,
      autoCheckoutReason: attendanceItem?.auto_checkout_reason || null,
      note: attendanceItem?.note || null,
      attendanceItem
    });
  }

  return {
    attendanceMap,
    leaveSet,
    leaveMap,
    history,
    summary
  };
}

module.exports = {
  buildAttendanceHistory,
  formatAttendanceDateLabel,
  formatAttendanceDuration,
  formatAttendanceTime,
  getJakartaDateIso,
  getMonthBounds,
  maxIsoDate,
  minIsoDate,
  resolveAttendanceRange
};