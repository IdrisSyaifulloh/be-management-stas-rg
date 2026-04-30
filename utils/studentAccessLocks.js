const { query } = require("../db/pool");
const { resolveStudentRecord } = require("./studentResolver");

const ACCESS_LOCK_REASON_ATTENDANCE_ABSENT = "ATTENDANCE_ABSENT";
const ACCESS_LOCK_REASON_WORK_HOURS_UNDER_8 = "WORK_HOURS_UNDER_8";
const ACCESS_LOCK_REASON_CHECKOUT_MISSING_22 = "CHECKOUT_MISSING_22";

const ACCESS_LOCK_REASON_DETAILS = {
  [ACCESS_LOCK_REASON_ATTENDANCE_ABSENT]: {
    label: "Belum Ada Informasi Absensi",
    message: "Akses dikunci karena belum ada informasi absensi setelah pukul 10.00 WIB."
  },
  [ACCESS_LOCK_REASON_WORK_HOURS_UNDER_8]: {
    label: "Jam Kerja Magang Kurang dari 8 Jam",
    message: "Akses dikunci karena durasi kerja Magang hari ini kurang dari 8 jam."
  },
  [ACCESS_LOCK_REASON_CHECKOUT_MISSING_22]: {
    label: "Belum Checkout Sampai 22.00 WIB",
    message: "Akses dikunci karena belum checkout sampai pukul 22.00 WIB."
  }
};

let ensureTablePromise = null;

async function ensureStudentAccessLockTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS student_access_locks (
          id TEXT PRIMARY KEY,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          lock_date DATE NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('LOCKED', 'UNLOCKED')),
          locked BOOLEAN NOT NULL DEFAULT TRUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          unlocked_at TIMESTAMPTZ,
          unlocked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(student_id, lock_date, reason)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_student_access_locks_active
        ON student_access_locks(student_id, active, lock_date DESC)
      `);
    })();
  }
  await ensureTablePromise;
}

function buildLockId(studentId, date, reason) {
  return `SAL-${date}-${reason}-${studentId}`.replace(/[^a-zA-Z0-9-_]/g, "-");
}

function getLockReasonDetail(reason) {
  return ACCESS_LOCK_REASON_DETAILS[reason] || {
    label: reason || "Access Lock",
    message: "Akses website dikunci. Hubungi operator."
  };
}

function mapAccessLockRow(row) {
  if (!row) {
    return {
      id: null,
      student_id: null,
      locked: false,
      active: false,
      status: "UNLOCKED",
      studentId: null,
      student_name: null,
      studentName: null,
      student_nim: null,
      nim: null,
      reference_date: null,
      date: null,
      lock_reason: null,
      reason: null,
      reason_label: null,
      reasonLabel: null,
      reason_detail: null,
      reasonDetail: null,
      message: null,
      locked_at: null,
      lockedAt: null,
      unlocked_at: null,
      unlockedAt: null,
      unlocked_by: null,
      unlockedBy: null
    };
  }

  const locked = row.locked === true && row.active === true && row.status === "LOCKED";
  const reasonDetail = getLockReasonDetail(row.reason);
  return {
    id: row.id,
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name || null,
    studentName: row.student_name || null,
    studentInitials: row.student_initials || null,
    student_initials: row.student_initials || null,
    student_nim: row.nim || null,
    nim: row.nim || null,
    reference_date: row.lock_date_text || row.lock_date,
    date: row.lock_date_text || row.lock_date,
    lock_reason: row.reason,
    reason: row.reason,
    reason_label: reasonDetail.label,
    reasonLabel: reasonDetail.label,
    reason_detail: reasonDetail.message,
    reasonDetail: reasonDetail.message,
    status: row.status,
    locked,
    active: row.active === true,
    locked_at: row.locked_at,
    lockedAt: row.locked_at,
    unlocked_at: row.unlocked_at || null,
    unlockedAt: row.unlocked_at || null,
    unlocked_by: row.unlocked_by || null,
    unlockedBy: row.unlocked_by || null,
    message: locked ? reasonDetail.message : null
  };
}

async function createStudentAccessLocks({ studentIds, date, reason }) {
  await ensureStudentAccessLockTable();
  const uniqueStudentIds = [...new Set((studentIds || []).filter(Boolean))];
  const created = [];

  for (const studentId of uniqueStudentIds) {
    const id = buildLockId(studentId, date, reason);
    const result = await query(
      `
      INSERT INTO student_access_locks (
        id, student_id, lock_date, reason, status, locked, active, locked_at
      )
      SELECT $1, $2, $3::date, $4, 'LOCKED', TRUE, TRUE, NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM student_access_locks existing
        WHERE existing.student_id = $2
          AND existing.lock_date = $3::date
          AND existing.active = TRUE
          AND existing.locked = TRUE
          AND existing.status = 'LOCKED'
      )
      ON CONFLICT (student_id, lock_date, reason) DO NOTHING
      RETURNING id
      `,
      [id, studentId, date, reason]
    );
    if (result.rowCount > 0) created.push(result.rows[0].id);
  }

  return created;
}

async function createAttendanceAbsentLocks({ studentIds, date }) {
  return createStudentAccessLocks({
    studentIds,
    date,
    reason: ACCESS_LOCK_REASON_ATTENDANCE_ABSENT
  });
}

async function createWorkHoursUnder8Locks({ studentIds, date }) {
  return createStudentAccessLocks({
    studentIds,
    date,
    reason: ACCESS_LOCK_REASON_WORK_HOURS_UNDER_8
  });
}

async function createCheckoutMissing22Locks({ studentIds, date }) {
  return createStudentAccessLocks({
    studentIds,
    date,
    reason: ACCESS_LOCK_REASON_CHECKOUT_MISSING_22
  });
}

async function getActiveLockForStudent(studentIdOrUserId) {
  await ensureStudentAccessLockTable();
  const student = await resolveStudentRecord(studentIdOrUserId);
  if (!student) return null;

  const result = await query(
    `
    SELECT sal.id, sal.student_id, TO_CHAR(sal.lock_date, 'YYYY-MM-DD') AS lock_date_text,
           sal.reason, sal.status, sal.locked, sal.active, sal.locked_at,
           sal.unlocked_at, sal.unlocked_by,
           u.name AS student_name, u.initials AS student_initials, s.nim
    FROM student_access_locks sal
    JOIN students s ON s.id = sal.student_id
    JOIN users u ON u.id = s.user_id
    WHERE sal.student_id = $1
      AND sal.active = TRUE
      AND sal.locked = TRUE
      AND sal.status = 'LOCKED'
    ORDER BY sal.lock_date DESC, sal.locked_at DESC
    LIMIT 1
    `,
    [student.id]
  );

  return result.rows[0] || null;
}

async function listAccessLocks({ status = null } = {}) {
  await ensureStudentAccessLockTable();
  const activeOnly = String(status || "").toLowerCase() === "active";
  const result = await query(
    `
    SELECT sal.id, sal.student_id, TO_CHAR(sal.lock_date, 'YYYY-MM-DD') AS lock_date_text,
           sal.reason, sal.status, sal.locked, sal.active, sal.locked_at,
           sal.unlocked_at, sal.unlocked_by,
           u.name AS student_name, u.initials AS student_initials, s.nim
    FROM student_access_locks sal
    JOIN students s ON s.id = sal.student_id
    JOIN users u ON u.id = s.user_id
    WHERE ($1::boolean = FALSE OR (sal.active = TRUE AND sal.locked = TRUE AND sal.status = 'LOCKED'))
    ORDER BY sal.lock_date DESC, sal.locked_at DESC
    `,
    [activeOnly]
  );

  return result.rows.map(mapAccessLockRow);
}

async function unlockAccessLock({ id, unlockedBy }) {
  await ensureStudentAccessLockTable();
  const result = await query(
    `
    UPDATE student_access_locks
    SET status = 'UNLOCKED',
        locked = FALSE,
        active = FALSE,
        unlocked_at = COALESCE(unlocked_at, NOW()),
        unlocked_by = COALESCE($2, unlocked_by),
        updated_at = NOW()
    WHERE id = $1
    RETURNING id
    `,
    [id, unlockedBy || null]
  );

  if (result.rowCount === 0) return null;

  const rows = await listAccessLocks();
  return rows.find((item) => item.id === id) || null;
}

async function studentAccessLockMiddleware(req, res, next) {
  if (String(req.authUser?.role || "").toLowerCase() !== "mahasiswa") {
    return next();
  }

  const path = req.path || "";
  const method = req.method || "GET";
  const allowed =
    path.startsWith("/api/auth") ||
    path.startsWith("/api/v1/auth") ||
    path.startsWith("/api/health") ||
    path.startsWith("/api/v1/health") ||
    path.startsWith("/api/profile") ||
    path.startsWith("/api/v1/profile") ||
    (method === "GET" && (path === "/api/student-access-locks/me" || path === "/api/v1/student-access-locks/me"));

  if (allowed) return next();

  try {
    const lock = await getActiveLockForStudent(req.authUser.id);
    if (!lock) return next();
    const mappedLock = mapAccessLockRow(lock);

    return res.status(423).json({
      message: mappedLock.message,
      accessLocked: true,
      reason: mappedLock.reason,
      reasonLabel: mappedLock.reasonLabel,
      reasonDetail: mappedLock.reasonDetail,
      date: mappedLock.date,
      lock: mappedLock
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  ACCESS_LOCK_REASON_ATTENDANCE_ABSENT,
  ACCESS_LOCK_REASON_CHECKOUT_MISSING_22,
  ACCESS_LOCK_REASON_DETAILS,
  ACCESS_LOCK_REASON_WORK_HOURS_UNDER_8,
  createCheckoutMissing22Locks,
  createAttendanceAbsentLocks,
  createStudentAccessLocks,
  createWorkHoursUnder8Locks,
  ensureStudentAccessLockTable,
  getActiveLockForStudent,
  getLockReasonDetail,
  listAccessLocks,
  mapAccessLockRow,
  studentAccessLockMiddleware,
  unlockAccessLock
};
