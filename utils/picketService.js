const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pool, query } = require("../db/pool");
const { getJakartaDateIso } = require("./attendanceHistory");
const { resolveStudentId, resolveStudentRecord } = require("./studentResolver");
const {
  ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
  createPicketSubmissionInvalidLocks
} = require("./studentAccessLocks");

const PICKET_UPLOAD_DIR = path.join(__dirname, "../public/uploads/picket");
const DEFAULT_SETTINGS_ID = "default";
const ALLOWED_PHOTO_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};
const SUBMISSION_STATUSES = ["Terkirim", "Valid", "Bermasalah"];
const LEAVE_STATUSES = ["Menunggu", "Disetujui", "Ditolak"];

let ensureTablesPromise = null;

function buildId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeIsoDate(value, fallback = null) {
  const text = String(value || fallback || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error("date wajib format YYYY-MM-DD.");
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function normalizePositiveInteger(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const error = new Error(`${label} wajib berupa integer minimal 1.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    const error = new Error(`${label} wajib berupa integer minimal 0.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function sanitizeFilenameBase(name) {
  return String(name || "picket-photo")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "picket-photo";
}

async function savePicketPhoto(photoDataUrl, originalFileName) {
  const match = String(photoDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format foto tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const extension = ALLOWED_PHOTO_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe foto tidak didukung. Gunakan PNG, JPG, atau WEBP.");
    error.statusCode = 400;
    throw error;
  }

  const base64Payload = match[2].replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload) || base64Payload.length % 4 !== 0) {
    const error = new Error("Payload foto base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(base64Payload, "base64");
  if (!buffer || buffer.length === 0) {
    const error = new Error("Foto kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  const maxBytes = 5 * 1024 * 1024;
  if (buffer.length > maxBytes) {
    const error = new Error("Ukuran foto maksimal 5 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(PICKET_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(PICKET_UPLOAD_DIR, fileName), buffer);
  return `/uploads/picket/${fileName}`;
}

async function ensurePicketTables() {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS picket_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          deleted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS picket_settings (
          id TEXT PRIMARY KEY DEFAULT 'default',
          people_per_day INTEGER NOT NULL DEFAULT 2 CHECK (people_per_day > 0),
          randomize_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          rotation_strategy TEXT NOT NULL DEFAULT 'random',
          exclude_on_leave BOOLEAN NOT NULL DEFAULT TRUE,
          allow_same_student_gap_days INTEGER NOT NULL DEFAULT 7 CHECK (allow_same_student_gap_days >= 0),
          weekly_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS picket_assignments (
          id TEXT PRIMARY KEY,
          date DATE NOT NULL,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES picket_tasks(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'Ditugaskan',
          generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(date, student_id)
        );

        CREATE TABLE IF NOT EXISTS picket_submissions (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL REFERENCES picket_assignments(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          photo_url TEXT NOT NULL,
          file_url TEXT,
          photo_file_name TEXT,
          source TEXT,
          status TEXT NOT NULL DEFAULT 'Terkirim' CHECK (status IN ('Terkirim', 'Valid', 'Bermasalah')),
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          review_note TEXT,
          UNIQUE(assignment_id)
        );

        CREATE TABLE IF NOT EXISTS picket_leave_requests (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL REFERENCES picket_assignments(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Menunggu' CHECK (status IN ('Menunggu', 'Disetujui', 'Ditolak')),
          reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          review_note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(assignment_id, student_id)
        );

        CREATE TABLE IF NOT EXISTS picket_managers (
          student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_picket_assignments_date ON picket_assignments(date);
        CREATE INDEX IF NOT EXISTS idx_picket_assignments_student_date ON picket_assignments(student_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_picket_submissions_student_date ON picket_submissions(student_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_student_date ON picket_leave_requests(student_id, date DESC);
      `);

      await query(`
        ALTER TABLE picket_settings
        ADD COLUMN IF NOT EXISTS weekly_schedule JSONB NOT NULL DEFAULT '[]'::jsonb
      `);

      await query(
        `
        INSERT INTO picket_settings (id, people_per_day, randomize_enabled)
        VALUES ($1, 2, TRUE)
        ON CONFLICT (id) DO NOTHING
        `,
        [DEFAULT_SETTINGS_ID]
      );
    })();
  }

  await ensureTablesPromise;
}

function mapSettings(row) {
  const weeklySchedule = normalizeWeeklySchedule(row.weekly_schedule || []);
  return {
    people_per_day: Number(row.people_per_day),
    peoplePerDay: Number(row.people_per_day),
    randomize_enabled: row.randomize_enabled === true,
    randomizeEnabled: row.randomize_enabled === true,
    rotation_strategy: row.rotation_strategy,
    rotationStrategy: row.rotation_strategy,
    exclude_on_leave: row.exclude_on_leave === true,
    excludeOnLeave: row.exclude_on_leave === true,
    allow_same_student_gap_days: Number(row.allow_same_student_gap_days || 0),
    allowSameStudentGapDays: Number(row.allow_same_student_gap_days || 0),
    weekly_schedule: weeklySchedule,
    weeklySchedule,
    updated_at: row.updated_at,
    updatedAt: row.updated_at
  };
}

function normalizeWeeklySchedule(value) {
  const items = Array.isArray(value) ? value : [];
  const byDay = new Map();

  for (const item of items) {
    const dayOfWeek = Number(item?.dayOfWeek ?? item?.day_of_week);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

    const studentIds = [...new Set((item?.studentIds || item?.student_ids || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
    const fallbackPeoplePerDay = studentIds.length > 0 ? studentIds.length : 1;

    byDay.set(dayOfWeek, {
      dayOfWeek,
      day_of_week: dayOfWeek,
      label: String(item?.label || "").trim(),
      enabled: item?.enabled === undefined ? true : Boolean(item.enabled),
      peoplePerDay: normalizePositiveInteger(
        item?.peoplePerDay ?? item?.people_per_day,
        fallbackPeoplePerDay,
        "weeklySchedule.peoplePerDay"
      ),
      people_per_day: normalizePositiveInteger(
        item?.peoplePerDay ?? item?.people_per_day,
        fallbackPeoplePerDay,
        "weeklySchedule.peoplePerDay"
      ),
      studentIds,
      student_ids: studentIds
    });
  }

  return [...byDay.values()].sort((left, right) => left.dayOfWeek - right.dayOfWeek);
}

function getJakartaDayOfWeek(isoDate) {
  const date = normalizeIsoDate(isoDate, getJakartaDateIso());
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.getUTCDay();
}

function getWeeklyScheduleForDate(settings, isoDate) {
  const dayOfWeek = getJakartaDayOfWeek(isoDate);
  return (settings.weeklySchedule || []).find((item) => item.enabled !== false && item.dayOfWeek === dayOfWeek) || null;
}

function mapTask(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    active: row.active === true,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at
  };
}

function mapAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date_text || row.date,
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name || null,
    studentName: row.student_name || null,
    nim: row.nim || null,
    task_id: row.task_id,
    taskId: row.task_id,
    task_name: row.task_name || null,
    taskName: row.task_name || null,
    task_description: row.task_description || null,
    taskDescription: row.task_description || null,
    status: row.status,
    submitted: Boolean(row.submission_id),
    submission_id: row.submission_id || null,
    submissionId: row.submission_id || null,
    submission_status: row.submission_status || null,
    submissionStatus: row.submission_status || null,
    generated_by: row.generated_by || null,
    generatedBy: row.generated_by || null,
    generated_at: row.generated_at || null,
    generatedAt: row.generated_at || null
  };
}

function mapSubmission(row) {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    assignmentId: row.assignment_id,
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name || null,
    studentName: row.student_name || null,
    nim: row.nim || null,
    date: row.date_text || row.date,
    photo_url: row.photo_url,
    photoUrl: row.photo_url,
    file_url: row.file_url || row.photo_url,
    fileUrl: row.file_url || row.photo_url,
    photo_file_name: row.photo_file_name || null,
    photoFileName: row.photo_file_name || null,
    source: row.source || null,
    status: row.status,
    submitted_at: row.submitted_at,
    submittedAt: row.submitted_at,
    reviewed_by: row.reviewed_by || null,
    reviewedBy: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    reviewedAt: row.reviewed_at || null,
    review_note: row.review_note || null,
    reviewNote: row.review_note || null
  };
}

function mapLeaveRequest(row) {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    assignmentId: row.assignment_id,
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name || null,
    studentName: row.student_name || null,
    nim: row.nim || null,
    date: row.date_text || row.date,
    reason: row.reason,
    status: row.status,
    reviewed_by: row.reviewed_by || null,
    reviewedBy: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    reviewedAt: row.reviewed_at || null,
    review_note: row.review_note || null,
    reviewNote: row.review_note || null,
    created_at: row.created_at,
    createdAt: row.created_at
  };
}

async function getPicketSettings() {
  await ensurePicketTables();
  const result = await query("SELECT * FROM picket_settings WHERE id = $1 LIMIT 1", [DEFAULT_SETTINGS_ID]);
  return mapSettings(result.rows[0]);
}

async function updatePicketSettings(payload = {}) {
  await ensurePicketTables();
  const current = await getPicketSettings();
  const peoplePerDay = normalizePositiveInteger(payload.peoplePerDay ?? payload.people_per_day, current.peoplePerDay, "peoplePerDay");
  const randomizeEnabled =
    payload.randomizeEnabled == null && payload.randomize_enabled == null
      ? current.randomizeEnabled
      : Boolean(payload.randomizeEnabled ?? payload.randomize_enabled);
  const rotationStrategy = String(
    payload.rotationStrategy ?? payload.rotation_strategy ?? current.rotationStrategy ?? "random"
  ).trim() || "random";
  const excludeOnLeave =
    payload.excludeOnLeave == null && payload.exclude_on_leave == null
      ? current.excludeOnLeave
      : Boolean(payload.excludeOnLeave ?? payload.exclude_on_leave);
  const gapDays = normalizeNonNegativeInteger(
    payload.allowSameStudentGapDays ?? payload.allow_same_student_gap_days,
    current.allowSameStudentGapDays,
    "allowSameStudentGapDays"
  );
  const weeklySchedule = Array.isArray(payload.weeklySchedule || payload.weekly_schedule)
    ? normalizeWeeklySchedule(payload.weeklySchedule || payload.weekly_schedule)
    : current.weeklySchedule;

  const result = await query(
    `
    UPDATE picket_settings
    SET people_per_day = $2,
        randomize_enabled = $3,
        rotation_strategy = $4,
        exclude_on_leave = $5,
        allow_same_student_gap_days = $6,
        weekly_schedule = $7::jsonb,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [
      DEFAULT_SETTINGS_ID,
      peoplePerDay,
      randomizeEnabled,
      rotationStrategy,
      excludeOnLeave,
      gapDays,
      JSON.stringify(weeklySchedule)
    ]
  );
  return mapSettings(result.rows[0]);
}

async function listPicketTasks({ includeInactive = true } = {}) {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT *
    FROM picket_tasks
    WHERE deleted_at IS NULL
      AND ($1::boolean = TRUE OR active = TRUE)
    ORDER BY active DESC, name ASC
    `,
    [includeInactive]
  );
  return result.rows.map(mapTask);
}

async function createPicketTask(payload = {}) {
  await ensurePicketTables();
  const name = String(payload.name || "").trim();
  if (!name) {
    const error = new Error("name wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  const result = await query(
    `
    INSERT INTO picket_tasks (id, name, description, active)
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [buildId("PKT-TASK"), name, payload.description == null ? null : String(payload.description), payload.active === false ? false : true]
  );
  return mapTask(result.rows[0]);
}

async function updatePicketTask(id, payload = {}) {
  await ensurePicketTables();
  const result = await query(
    `
    UPDATE picket_tasks
    SET name = COALESCE($2, name),
        description = CASE WHEN $3::boolean THEN $4 ELSE description END,
        active = COALESCE($5, active),
        updated_at = NOW()
    WHERE id = $1
      AND deleted_at IS NULL
    RETURNING *
    `,
    [
      id,
      payload.name == null ? null : String(payload.name).trim(),
      Object.prototype.hasOwnProperty.call(payload, "description"),
      payload.description == null ? null : String(payload.description),
      payload.active == null ? null : Boolean(payload.active)
    ]
  );
  return result.rows[0] ? mapTask(result.rows[0]) : null;
}

async function deletePicketTask(id) {
  await ensurePicketTables();
  const result = await query(
    `
    UPDATE picket_tasks
    SET active = FALSE, deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *
    `,
    [id]
  );
  return result.rows[0] ? mapTask(result.rows[0]) : null;
}

async function isPicketManagerUser(userId) {
  await ensurePicketTables();
  const student = await resolveStudentRecord(userId);
  if (!student) return false;

  const result = await query(
    "SELECT 1 FROM picket_managers WHERE student_id = $1 LIMIT 1",
    [student.id]
  );
  return result.rowCount > 0;
}

async function listPicketManagers() {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT pm.student_id, pm.created_by, pm.created_at, s.nim, u.name AS student_name
    FROM picket_managers pm
    JOIN students s ON s.id = pm.student_id
    JOIN users u ON u.id = s.user_id
    ORDER BY u.name ASC
    `
  );
  return result.rows.map((row) => ({
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name,
    studentName: row.student_name,
    nim: row.nim,
    created_by: row.created_by,
    createdBy: row.created_by,
    created_at: row.created_at,
    createdAt: row.created_at
  }));
}

async function replacePicketManagers(studentIds = [], createdBy = null) {
  await ensurePicketTables();
  const uniqueStudentIds = [...new Set((studentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM picket_managers");
    for (const studentId of uniqueStudentIds) {
      await client.query(
        `
        INSERT INTO picket_managers (student_id, created_by)
        SELECT $1, $2
        WHERE EXISTS (SELECT 1 FROM students WHERE id = $1)
        ON CONFLICT (student_id) DO NOTHING
        `,
        [studentId, createdBy]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return listPicketManagers();
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

async function fetchCandidateStudents({ date, excludeOnLeave, gapDays }) {
  const gapClause = gapDays > 0
    ? `
      AND NOT EXISTS (
        SELECT 1
        FROM picket_assignments recent
        WHERE recent.student_id = s.id
          AND recent.date < $1::date
          AND recent.date >= ($1::date - ($2::int * INTERVAL '1 day'))
      )
    `
    : "";
  const params = gapDays > 0 ? [date, gapDays, excludeOnLeave] : [date, excludeOnLeave];
  const leaveParam = gapDays > 0 ? 3 : 2;

  const result = await query(
    `
    SELECT s.id, s.nim, u.name AS student_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif'
      AND u.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM picket_assignments existing
        WHERE existing.student_id = s.id
          AND existing.date = $1::date
      )
      AND (
        $${leaveParam}::boolean = FALSE
        OR NOT EXISTS (
          SELECT 1
          FROM leave_requests lr
          WHERE lr.student_id = s.id
            AND lr.status = 'Disetujui'
            AND $1::date BETWEEN lr.periode_start AND lr.periode_end
        )
      )
      ${gapClause}
    ORDER BY u.name ASC
    `,
    params
  );
  return result.rows;
}

async function chooseTaskForStudent(studentId, activeTasks) {
  if (activeTasks.length <= 1) return activeTasks[0];

  const previous = await query(
    `
    SELECT task_id
    FROM picket_assignments
    WHERE student_id = $1 AND task_id IS NOT NULL
    ORDER BY date DESC, generated_at DESC
    LIMIT 1
    `,
    [studentId]
  );
  const previousTaskId = previous.rows[0]?.task_id;
  const candidates = activeTasks.filter((task) => task.id !== previousTaskId);
  return candidates[Math.floor(Math.random() * candidates.length)] || activeTasks[0];
}

async function fetchAssignmentsByDate(date) {
  const result = await query(
    `
    SELECT pa.id, TO_CHAR(pa.date, 'YYYY-MM-DD') AS date_text, pa.student_id,
           pa.task_id, pa.status, pa.generated_by, pa.generated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ps.id AS submission_id, ps.status AS submission_status
    FROM picket_assignments pa
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_submissions ps ON ps.assignment_id = pa.id
    WHERE pa.date = $1::date
    ORDER BY u.name ASC
    `,
    [date]
  );
  return result.rows.map(mapAssignment);
}

async function normalizeManualStudentIds(studentIds) {
  const uniqueIds = [...new Set((studentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    const error = new Error("studentIds wajib diisi untuk mode manual.");
    error.statusCode = 400;
    throw error;
  }

  const result = await query(
    `
    SELECT s.id
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ANY($1::text[])
      AND s.status = 'Aktif'
      AND u.is_active = TRUE
    `,
    [uniqueIds]
  );
  const foundIds = new Set(result.rows.map((row) => row.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    const error = new Error(`studentIds tidak valid atau tidak aktif: ${missingIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return uniqueIds;
}

async function generateManualPicketSchedule({ date, studentIds, activeTasks, generatedBy = null }) {
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const manualStudentIds = await normalizeManualStudentIds(studentIds);
  const createdIds = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM picket_assignments WHERE date = $1::date", [targetDate]);

    for (let index = 0; index < manualStudentIds.length; index += 1) {
      const studentId = manualStudentIds[index];
      const task = activeTasks.length > 1
        ? activeTasks[index % activeTasks.length]
        : await chooseTaskForStudent(studentId, activeTasks);
      const id = buildId("PKT-ASG");

      const result = await client.query(
        `
        INSERT INTO picket_assignments (id, date, student_id, task_id, status, generated_by)
        VALUES ($1, $2::date, $3, $4, 'Ditugaskan', $5)
        RETURNING id
        `,
        [id, targetDate, studentId, task.id, generatedBy]
      );
      createdIds.push(result.rows[0].id);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    date: targetDate,
    assignments: await fetchAssignmentsByDate(targetDate),
    created: createdIds
  };
}

async function generatePicketSchedule({ date, peoplePerDay, randomize, studentIds, generatedBy = null } = {}) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const settings = await getPicketSettings();
  const weeklySchedule = getWeeklyScheduleForDate(settings, targetDate);
  const weeklyStudentIds = weeklySchedule?.studentIds || [];
  const effectiveStudentIds =
    Array.isArray(studentIds) && studentIds.length > 0
      ? studentIds
      : weeklyStudentIds.length > 0
        ? weeklyStudentIds
        : studentIds;
  const targetCount = Array.isArray(effectiveStudentIds) && effectiveStudentIds.length > 0
    ? effectiveStudentIds.length
    : normalizePositiveInteger(
        peoplePerDay ?? weeklySchedule?.peoplePerDay,
        settings.peoplePerDay,
        "peoplePerDay"
      );
  const useRandom = randomize == null ? settings.randomizeEnabled : Boolean(randomize);

  const activeTasks = await listPicketTasks({ includeInactive: false });
  if (activeTasks.length === 0) {
    const error = new Error("Belum ada tugas piket aktif.");
    error.statusCode = 400;
    throw error;
  }

  if (Array.isArray(effectiveStudentIds) && effectiveStudentIds.length > 0) {
    return generateManualPicketSchedule({
      date: targetDate,
      studentIds: effectiveStudentIds,
      activeTasks,
      generatedBy
    });
  }

  const existing = await fetchAssignmentsByDate(targetDate);
  const missingCount = Math.max(0, targetCount - existing.length);
  if (missingCount === 0) {
    return { date: targetDate, assignments: existing, created: [] };
  }

  let candidates = await fetchCandidateStudents({
    date: targetDate,
    excludeOnLeave: settings.excludeOnLeave,
    gapDays: settings.allowSameStudentGapDays
  });
  if (candidates.length < missingCount && settings.allowSameStudentGapDays > 0) {
    candidates = await fetchCandidateStudents({
      date: targetDate,
      excludeOnLeave: settings.excludeOnLeave,
      gapDays: 0
    });
  }

  const selected = (useRandom ? shuffle(candidates) : candidates).slice(0, missingCount);
  const createdIds = [];

  for (const student of selected) {
    const task = await chooseTaskForStudent(student.id, activeTasks);
    const id = buildId("PKT-ASG");
    const result = await query(
      `
      INSERT INTO picket_assignments (id, date, student_id, task_id, status, generated_by)
      VALUES ($1, $2::date, $3, $4, 'Ditugaskan', $5)
      ON CONFLICT (date, student_id) DO NOTHING
      RETURNING id
      `,
      [id, targetDate, student.id, task.id, generatedBy]
    );
    if (result.rowCount > 0) createdIds.push(result.rows[0].id);
  }

  return {
    date: targetDate,
    assignments: await fetchAssignmentsByDate(targetDate),
    created: createdIds
  };
}

async function listSubmissions({ date = null, studentId = null } = {}) {
  await ensurePicketTables();
  const params = [];
  const clauses = [];
  if (date) {
    params.push(normalizeIsoDate(date));
    clauses.push(`ps.date = $${params.length}::date`);
  }
  if (studentId) {
    params.push(studentId);
    clauses.push(`ps.student_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    SELECT ps.*, TO_CHAR(ps.date, 'YYYY-MM-DD') AS date_text, s.nim, u.name AS student_name
    FROM picket_submissions ps
    JOIN students s ON s.id = ps.student_id
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY ps.date DESC, ps.submitted_at DESC
    `,
    params
  );
  return result.rows.map(mapSubmission);
}

async function getPicketOverview(date) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const [assignments, submissions, leaveRequests] = await Promise.all([
    fetchAssignmentsByDate(targetDate),
    listSubmissions({ date: targetDate }),
    listPicketLeaveRequests({ date: targetDate })
  ]);
  return { date: targetDate, assignments, submissions, leaveRequests };
}

async function getPicketTodayForStudent(studentIdOrUserId, date = getJakartaDateIso()) {
  await ensurePicketTables();
  const studentId = await resolveStudentId(studentIdOrUserId);
  if (!studentId) return { assignment: null };
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const result = await query(
    `
    SELECT pa.id, TO_CHAR(pa.date, 'YYYY-MM-DD') AS date_text, pa.student_id,
           pa.task_id, pa.status, pa.generated_by, pa.generated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ps.id AS submission_id, ps.status AS submission_status
    FROM picket_assignments pa
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_submissions ps ON ps.assignment_id = pa.id
    WHERE pa.student_id = $1 AND pa.date = $2::date
    LIMIT 1
    `,
    [studentId, targetDate]
  );
  return { assignment: result.rows[0] ? mapAssignment(result.rows[0]) : null };
}

async function getPicketHistory(studentIdOrUserId) {
  await ensurePicketTables();
  const studentId = await resolveStudentId(studentIdOrUserId);
  if (!studentId) return [];
  const result = await query(
    `
    SELECT pa.id, TO_CHAR(pa.date, 'YYYY-MM-DD') AS date_text, pa.student_id,
           pa.task_id, pa.status, pa.generated_by, pa.generated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ps.id AS submission_id, ps.status AS submission_status
    FROM picket_assignments pa
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_submissions ps ON ps.assignment_id = pa.id
    WHERE pa.student_id = $1
    ORDER BY pa.date DESC
    `,
    [studentId]
  );
  return result.rows.map(mapAssignment);
}

async function hasApprovedPicketLeave({ assignmentId, studentId, date }) {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT 1
    FROM picket_leave_requests
    WHERE status = 'Disetujui'
      AND ($1::text IS NULL OR assignment_id = $1)
      AND ($2::text IS NULL OR student_id = $2)
      AND ($3::date IS NULL OR date = $3::date)
    LIMIT 1
    `,
    [assignmentId || null, studentId || null, date || null]
  );
  return result.rowCount > 0;
}

async function getPicketCheckoutRequirement(studentIdOrUserId, date = getJakartaDateIso()) {
  const today = await getPicketTodayForStudent(studentIdOrUserId, date);
  const assignment = today.assignment;
  if (!assignment) {
    return { required: false, assignment: null, approvedLeave: false, submitted: false };
  }

  const approvedLeave = await hasApprovedPicketLeave({
    assignmentId: assignment.id,
    studentId: assignment.studentId,
    date: assignment.date
  });
  const submitted = assignment.submitted === true;

  return {
    required: !submitted && !approvedLeave,
    assignment,
    approvedLeave,
    submitted
  };
}

async function createPicketSubmission(payload = {}) {
  await ensurePicketTables();
  const assignmentId = String(payload.assignmentId || payload.assignment_id || "").trim();
  const studentId = await resolveStudentId(payload.studentId || payload.student_id);
  const date = normalizeIsoDate(payload.date, getJakartaDateIso());
  if (!assignmentId || !studentId) {
    const error = new Error("assignmentId dan studentId wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  const assignment = await query(
    `
    SELECT id, student_id, TO_CHAR(date, 'YYYY-MM-DD') AS date_text, task_id
    FROM picket_assignments
    WHERE id = $1
    LIMIT 1
    `,
    [assignmentId]
  );
  if (assignment.rowCount === 0) {
    const error = new Error("Assignment piket tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
  if (assignment.rows[0].student_id !== studentId || assignment.rows[0].date_text !== date) {
    const error = new Error("Assignment piket tidak sesuai dengan studentId/date.");
    error.statusCode = 400;
    throw error;
  }
  const taskId = String(payload.taskId || payload.task_id || "").trim();
  if (taskId && assignment.rows[0].task_id !== taskId) {
    const error = new Error("taskId tidak sesuai dengan assignment piket.");
    error.statusCode = 400;
    throw error;
  }

  const photoUrl = await savePicketPhoto(payload.photoDataUrl || payload.photo_data_url, payload.photoFileName || payload.photo_file_name || "picket-photo");
  const result = await query(
    `
    INSERT INTO picket_submissions (
      id, assignment_id, student_id, date, photo_url, file_url, photo_file_name, source, status
    )
    VALUES ($1, $2, $3, $4::date, $5, $5, $6, $7, 'Terkirim')
    ON CONFLICT (assignment_id)
    DO UPDATE SET photo_url = EXCLUDED.photo_url,
                  file_url = EXCLUDED.file_url,
                  photo_file_name = EXCLUDED.photo_file_name,
                  source = EXCLUDED.source,
                  status = 'Terkirim',
                  submitted_at = NOW(),
                  reviewed_by = NULL,
                  reviewed_at = NULL,
                  review_note = NULL
    RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text
    `,
    [
      buildId("PKT-SUB"),
      assignmentId,
      studentId,
      date,
      photoUrl,
      payload.photoFileName || payload.photo_file_name || null,
      payload.source == null ? null : String(payload.source)
    ]
  );
  return mapSubmission(result.rows[0]);
}

async function reviewPicketSubmission(id, payload = {}) {
  await ensurePicketTables();
  const status = String(payload.status || "").trim();
  if (!SUBMISSION_STATUSES.includes(status)) {
    const error = new Error("status wajib salah satu dari Terkirim, Valid, Bermasalah.");
    error.statusCode = 400;
    throw error;
  }

  const reviewedBy = payload.reviewedBy || payload.reviewed_by || null;
  const result = await query(
    `
    UPDATE picket_submissions
    SET status = $2,
        reviewed_by = $3,
        reviewed_at = NOW(),
        review_note = $4
    WHERE id = $1
    RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text
    `,
    [id, status, reviewedBy, payload.reviewNote ?? payload.review_note ?? null]
  );
  if (result.rowCount === 0) return null;

  const submission = mapSubmission(result.rows[0]);
  if (status === "Bermasalah") {
    await createPicketSubmissionInvalidLocks({
      studentIds: [submission.studentId],
      date: submission.date
    });
    submission.accessLockReason = ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID;
  }

  return submission;
}

async function listPicketLeaveRequests({ studentId = null, date = null } = {}) {
  await ensurePicketTables();
  const params = [];
  const clauses = [];
  if (studentId) {
    const resolved = await resolveStudentId(studentId);
    params.push(resolved || studentId);
    clauses.push(`plr.student_id = $${params.length}`);
  }
  if (date) {
    params.push(normalizeIsoDate(date));
    clauses.push(`plr.date = $${params.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    SELECT plr.*, TO_CHAR(plr.date, 'YYYY-MM-DD') AS date_text, s.nim, u.name AS student_name
    FROM picket_leave_requests plr
    JOIN students s ON s.id = plr.student_id
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY plr.date DESC, plr.created_at DESC
    `,
    params
  );
  return result.rows.map(mapLeaveRequest);
}

async function createPicketLeaveRequest(payload = {}) {
  await ensurePicketTables();
  const assignmentId = String(payload.assignmentId || payload.assignment_id || "").trim();
  const studentId = await resolveStudentId(payload.studentId || payload.student_id);
  const date = normalizeIsoDate(payload.date, getJakartaDateIso());
  const reason = String(payload.reason || "").trim();
  if (!assignmentId || !studentId || !reason) {
    const error = new Error("assignmentId, studentId, date, dan reason wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  const assignment = await query(
    "SELECT id, student_id, TO_CHAR(date, 'YYYY-MM-DD') AS date_text FROM picket_assignments WHERE id = $1 LIMIT 1",
    [assignmentId]
  );
  if (assignment.rowCount === 0) {
    const error = new Error("Assignment piket tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
  if (assignment.rows[0].student_id !== studentId || assignment.rows[0].date_text !== date) {
    const error = new Error("Assignment piket tidak sesuai dengan studentId/date.");
    error.statusCode = 400;
    throw error;
  }

  const result = await query(
    `
    INSERT INTO picket_leave_requests (id, assignment_id, student_id, date, reason, status)
    VALUES ($1, $2, $3, $4::date, $5, 'Menunggu')
    ON CONFLICT (assignment_id, student_id)
    DO UPDATE SET reason = EXCLUDED.reason,
                  status = 'Menunggu',
                  reviewed_by = NULL,
                  reviewed_at = NULL,
                  review_note = NULL,
                  updated_at = NOW()
    RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text
    `,
    [buildId("PKT-LV"), assignmentId, studentId, date, reason]
  );
  return mapLeaveRequest(result.rows[0]);
}

async function reviewPicketLeaveRequest(id, payload = {}) {
  await ensurePicketTables();
  const status = String(payload.status || "").trim();
  if (!LEAVE_STATUSES.includes(status)) {
    const error = new Error("status wajib salah satu dari Menunggu, Disetujui, Ditolak.");
    error.statusCode = 400;
    throw error;
  }

  const result = await query(
    `
    UPDATE picket_leave_requests
    SET status = $2,
        reviewed_by = $3,
        reviewed_at = CASE WHEN $2 = 'Menunggu' THEN NULL ELSE NOW() END,
        review_note = $4,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text
    `,
    [id, status, payload.reviewedBy || payload.reviewed_by || null, payload.reviewNote ?? payload.review_note ?? null]
  );
  return result.rows[0] ? mapLeaveRequest(result.rows[0]) : null;
}

module.exports = {
  createPicketLeaveRequest,
  createPicketSubmission,
  createPicketTask,
  deletePicketTask,
  ensurePicketTables,
  generatePicketSchedule,
  getPicketCheckoutRequirement,
  getPicketHistory,
  getPicketOverview,
  getPicketSettings,
  getPicketTodayForStudent,
  isPicketManagerUser,
  listPicketLeaveRequests,
  listPicketManagers,
  listPicketTasks,
  replacePicketManagers,
  reviewPicketLeaveRequest,
  reviewPicketSubmission,
  updatePicketSettings,
  updatePicketTask
};
