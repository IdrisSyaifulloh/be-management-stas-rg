const { getJakartaDateIso } = require("../utils/attendanceHistory");
const {
  backfillApprovedPicketLeaveReplacements,
  materializePicketSchedulesForDate
} = require("../utils/picketService");

const ONE_HOUR = 60 * 60 * 1000;

async function runPicketScheduleCycle(date = getJakartaDateIso()) {
  const [schedule, leaveReplacements] = await Promise.all([
    materializePicketSchedulesForDate(date),
    backfillApprovedPicketLeaveReplacements()
  ]);
  return { ...schedule, leaveReplacements };
}

async function runSchedulerTick() {
  try {
    const result = await runPicketScheduleCycle();
    console.log("[PicketScheduleScheduler] Jadwal hari ini disinkronkan:", JSON.stringify({
      date: result.date,
      created: result.created?.length || 0,
      leaveReplacementsCreated: result.leaveReplacements?.created || 0,
      leaveReplacementFailures: result.leaveReplacements?.failed?.length || 0,
      skipped: result.skipped === true
    }));
    return result;
  } catch (error) {
    console.error("[PicketScheduleScheduler] Sinkronisasi gagal:", error.message);
    return { ran: false, reason: "error", error: error.message };
  }
}

function startMonitoring() {
  console.log("[PicketScheduleScheduler] Starting fixed weekday scheduler (checks every hour)...");
  runSchedulerTick().catch(() => {});
  setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, ONE_HOUR);
}

module.exports = {
  runPicketScheduleCycle,
  runSchedulerTick,
  startMonitoring
};

if (require.main === module) {
  runSchedulerTick()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
