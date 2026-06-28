const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pool, query } = require("../db/pool");
const { getJakartaDateIso } = require("./attendanceHistory");
const { resolveStudentId, resolveStudentRecord } = require("./studentResolver");
const {
  ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
  ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING,
  createPicketSubmissionInvalidLocks,
  deactivateAccessLocksForStudentDateReason
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

function runQuery(executor, text, params) {
  if (typeof executor === "function") return executor(text, params);
  return executor.query(text, params);
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

function normalizeBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return Boolean(value);
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

        CREATE TABLE IF NOT EXISTS picket_days (
          id SMALLINT PRIMARY KEY,
          name TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        INSERT INTO picket_days (id, name)
        VALUES
          (0, 'Minggu'),
          (1, 'Senin'),
          (2, 'Selasa'),
          (3, 'Rabu'),
          (4, 'Kamis'),
          (5, 'Jumat'),
          (6, 'Sabtu')
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            updated_at = NOW();

        CREATE TABLE IF NOT EXISTS picket_schedules (
          id TEXT PRIMARY KEY,
          schedule_date DATE NOT NULL,
          day_id SMALLINT NOT NULL REFERENCES picket_days(id),
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES picket_tasks(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'Ditugaskan',
          notes TEXT,
          generated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(schedule_date, student_id)
        );

        CREATE TABLE IF NOT EXISTS picket_submissions (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL REFERENCES picket_schedules(id) ON DELETE CASCADE,
          assignment_id TEXT NOT NULL,
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
          UNIQUE(schedule_id)
        );

        CREATE TABLE IF NOT EXISTS picket_leave_requests (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL REFERENCES picket_schedules(id) ON DELETE CASCADE,
          assignment_id TEXT NOT NULL,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Menunggu' CHECK (status IN ('Menunggu', 'Disetujui', 'Ditolak')),
          reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          review_note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(schedule_id, student_id)
        );

        CREATE TABLE IF NOT EXISTS picket_managers (
          student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS picket_holidays (
          id TEXT PRIMARY KEY,
          holiday_date DATE NOT NULL UNIQUE,
          name TEXT NOT NULL,
          notes TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_picket_schedules_date ON picket_schedules(schedule_date);
        CREATE INDEX IF NOT EXISTS idx_picket_schedules_student_date ON picket_schedules(student_id, schedule_date DESC);
        CREATE INDEX IF NOT EXISTS idx_picket_submissions_student_date ON picket_submissions(student_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_student_date ON picket_leave_requests(student_id, date DESC);
        CREATE INDEX IF NOT EXISTS idx_picket_holidays_date ON picket_holidays(holiday_date);
      `);

      await query(`
        DO $$
        BEGIN
          IF to_regclass('public.picket_assignments') IS NOT NULL THEN
            INSERT INTO picket_schedules (
              id, schedule_date, day_id, student_id, task_id, status,
              generated_by, generated_at, created_at, updated_at
            )
            SELECT id, date, EXTRACT(DOW FROM date)::smallint, student_id, task_id, status,
                   generated_by, generated_at, created_at, updated_at
            FROM picket_assignments
            ON CONFLICT (id) DO NOTHING;
          END IF;
        END $$;
      `);

      await query(`
        ALTER TABLE picket_submissions
        ADD COLUMN IF NOT EXISTS schedule_id TEXT;

        UPDATE picket_submissions
        SET schedule_id = COALESCE(schedule_id, assignment_id)
        WHERE schedule_id IS NULL;

        ALTER TABLE picket_submissions
        ALTER COLUMN schedule_id SET NOT NULL;

        ALTER TABLE picket_submissions
        DROP CONSTRAINT IF EXISTS picket_submissions_assignment_id_fkey;

        ALTER TABLE picket_submissions
        DROP CONSTRAINT IF EXISTS picket_submissions_assignment_id_key;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'picket_submissions_schedule_id_fkey'
          ) THEN
            ALTER TABLE picket_submissions
            ADD CONSTRAINT picket_submissions_schedule_id_fkey
            FOREIGN KEY (schedule_id) REFERENCES picket_schedules(id) ON DELETE CASCADE
            NOT VALID;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'picket_submissions_schedule_id_key'
          ) THEN
            ALTER TABLE picket_submissions
            ADD CONSTRAINT picket_submissions_schedule_id_key UNIQUE (schedule_id);
          END IF;
        END $$;

        ALTER TABLE picket_leave_requests
        ADD COLUMN IF NOT EXISTS schedule_id TEXT;

        UPDATE picket_leave_requests
        SET schedule_id = COALESCE(schedule_id, assignment_id)
        WHERE schedule_id IS NULL;

        ALTER TABLE picket_leave_requests
        ALTER COLUMN schedule_id SET NOT NULL;

        ALTER TABLE picket_leave_requests
        DROP CONSTRAINT IF EXISTS picket_leave_requests_assignment_id_fkey;

        ALTER TABLE picket_leave_requests
        DROP CONSTRAINT IF EXISTS picket_leave_requests_assignment_id_student_id_key;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'picket_leave_requests_schedule_id_fkey'
          ) THEN
            ALTER TABLE picket_leave_requests
            ADD CONSTRAINT picket_leave_requests_schedule_id_fkey
            FOREIGN KEY (schedule_id) REFERENCES picket_schedules(id) ON DELETE CASCADE
            NOT VALID;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'picket_leave_requests_schedule_id_student_id_key'
          ) THEN
            ALTER TABLE picket_leave_requests
            ADD CONSTRAINT picket_leave_requests_schedule_id_student_id_key UNIQUE (schedule_id, student_id);
          END IF;
        END $$;
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

function getWeeklySchedulePayload(payload = {}) {
  if (Array.isArray(payload.weeklySchedule)) return payload.weeklySchedule;
  if (Array.isArray(payload.weekly_schedule)) return payload.weekly_schedule;
  return null;
}

function weeklyScheduleItemSignature(item) {
  if (!item) return null;
  return JSON.stringify({
    enabled: item.enabled !== false,
    peoplePerDay: Number(item.peoplePerDay || item.people_per_day || 0),
    studentIds: item.studentIds || item.student_ids || []
  });
}

function isWeeklyScheduleChangedForDate(previousSettings, nextSettings, isoDate) {
  const dayOfWeek = getJakartaDayOfWeek(isoDate);
  const previous = (previousSettings.weeklySchedule || []).find((item) => item.dayOfWeek === dayOfWeek) || null;
  const next = (nextSettings.weeklySchedule || []).find((item) => item.dayOfWeek === dayOfWeek) || null;
  return weeklyScheduleItemSignature(previous) !== weeklyScheduleItemSignature(next);
}

function mapDay(row) {
  return {
    id: Number(row.id),
    name: row.name,
    active: row.active === true,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at
  };
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
  const date = row.date_text || row.schedule_date_text || row.schedule_date || row.date;
  const isHoliday = Boolean(row.holiday_id);
  return {
    id: row.id,
    schedule_id: row.id,
    scheduleId: row.id,
    assignment_id: row.id,
    assignmentId: row.id,
    date,
    schedule_date: date,
    scheduleDate: date,
    day_id: row.day_id == null ? null : Number(row.day_id),
    dayId: row.day_id == null ? null : Number(row.day_id),
    day_name: row.day_name || null,
    dayName: row.day_name || null,
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
    status: isHoliday ? "Libur" : row.status,
    original_status: row.status,
    originalStatus: row.status,
    is_holiday: isHoliday,
    isHoliday,
    is_exempt: isHoliday,
    isExempt: isHoliday,
    holiday: isHoliday
      ? {
          id: row.holiday_id,
          date: row.holiday_date_text || date,
          name: row.holiday_name,
          notes: row.holiday_notes || null
        }
      : null,
    submitted: Boolean(row.submission_id),
    submission_id: row.submission_id || null,
    submissionId: row.submission_id || null,
    submission_status: row.submission_status || null,
    submissionStatus: row.submission_status || null,
    photo_url: row.submission_photo_url || null,
    photoUrl: row.submission_photo_url || null,
    file_url: row.submission_file_url || row.submission_photo_url || null,
    fileUrl: row.submission_file_url || row.submission_photo_url || null,
    photo_file_name: row.submission_photo_file_name || null,
    photoFileName: row.submission_photo_file_name || null,
    submitted_at: row.submission_submitted_at || null,
    submittedAt: row.submission_submitted_at || null,
    reviewed_at: row.submission_reviewed_at || null,
    reviewedAt: row.submission_reviewed_at || null,
    reviewed_by: row.submission_reviewed_by || null,
    reviewedBy: row.submission_reviewed_by || null,
    review_note: row.submission_review_note || null,
    reviewNote: row.submission_review_note || null,
    submission: row.submission_id
      ? {
          id: row.submission_id,
          schedule_id: row.id,
          scheduleId: row.id,
          assignment_id: row.submission_assignment_id || row.id,
          assignmentId: row.submission_assignment_id || row.id,
          status: row.submission_status || null,
          photo_url: row.submission_photo_url || null,
          photoUrl: row.submission_photo_url || null,
          file_url: row.submission_file_url || row.submission_photo_url || null,
          fileUrl: row.submission_file_url || row.submission_photo_url || null,
          photo_file_name: row.submission_photo_file_name || null,
          photoFileName: row.submission_photo_file_name || null,
          submitted_at: row.submission_submitted_at || null,
          submittedAt: row.submission_submitted_at || null,
          reviewed_at: row.submission_reviewed_at || null,
          reviewedAt: row.submission_reviewed_at || null,
          reviewed_by: row.submission_reviewed_by || null,
          reviewedBy: row.submission_reviewed_by || null,
          review_note: row.submission_review_note || null,
          reviewNote: row.submission_review_note || null
        }
      : null,
    notes: row.notes || null,
    generated_by: row.generated_by || null,
    generatedBy: row.generated_by || null,
    generated_at: row.generated_at || null,
    generatedAt: row.generated_at || null,
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

function mapSubmission(row) {
  const scheduleId = row.schedule_id || row.assignment_id;
  return {
    id: row.id,
    schedule_id: scheduleId,
    scheduleId,
    assignment_id: row.assignment_id || scheduleId,
    assignmentId: row.assignment_id || scheduleId,
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
  const scheduleId = row.schedule_id || row.assignment_id;
  return {
    id: row.id,
    schedule_id: scheduleId,
    scheduleId,
    assignment_id: row.assignment_id || scheduleId,
    assignmentId: row.assignment_id || scheduleId,
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

function mapPicketHoliday(row) {
  if (!row) return null;
  const date = row.holiday_date_text || row.holiday_date;
  return {
    id: row.id,
    date,
    holiday_date: date,
    holidayDate: date,
    name: row.name,
    notes: row.notes || null,
    created_by: row.created_by || null,
    createdBy: row.created_by || null,
    updated_by: row.updated_by || null,
    updatedBy: row.updated_by || null,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at
  };
}

async function getPicketHolidayByDate(date, executor = query) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const result = await runQuery(
    executor,
    `
    SELECT *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
    FROM picket_holidays
    WHERE holiday_date = $1::date
    LIMIT 1
    `,
    [targetDate]
  );
  return result.rows[0] ? mapPicketHoliday(result.rows[0]) : null;
}

async function ensurePicketDateIsNotHoliday(date, executor = query) {
  const holiday = await getPicketHolidayByDate(date, executor);
  if (!holiday) return;
  const error = new Error(`Tanggal ${holiday.date} ditetapkan sebagai hari libur piket: ${holiday.name}.`);
  error.statusCode = 409;
  error.holiday = holiday;
  throw error;
}

async function listPicketHolidays({ startDate = null, endDate = null } = {}) {
  await ensurePicketTables();
  const params = [];
  const clauses = [];
  if (startDate) {
    params.push(normalizeIsoDate(startDate));
    clauses.push(`holiday_date >= $${params.length}::date`);
  }
  if (endDate) {
    params.push(normalizeIsoDate(endDate));
    clauses.push(`holiday_date <= $${params.length}::date`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    SELECT *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
    FROM picket_holidays
    ${where}
    ORDER BY holiday_date ASC
    `,
    params
  );
  return result.rows.map(mapPicketHoliday);
}

function normalizePicketHolidayPayload(payload = {}) {
  const date = normalizeIsoDate(payload.date || payload.holidayDate || payload.holiday_date);
  const dayOfWeek = getJakartaDayOfWeek(date);
  if (dayOfWeek < 1 || dayOfWeek > 5) {
    const error = new Error("Hari libur piket hanya dapat ditetapkan untuk Senin sampai Jumat.");
    error.statusCode = 400;
    throw error;
  }
  const name = String(payload.name || payload.title || payload.label || "").trim();
  if (!name) {
    const error = new Error("Nama hari libur wajib diisi.");
    error.statusCode = 400;
    throw error;
  }
  return {
    date,
    name,
    notes: payload.notes == null ? null : String(payload.notes).trim() || null
  };
}

async function releasePicketLocksForHoliday(date, updatedBy = null) {
  const result = await query(
    `
    SELECT DISTINCT student_id
    FROM picket_schedules
    WHERE schedule_date = $1::date
    `,
    [date]
  );
  await Promise.all(result.rows.flatMap((row) => [
    deactivateAccessLocksForStudentDateReason({
      studentId: row.student_id,
      date,
      reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING,
      unlockedBy: updatedBy
    }),
    deactivateAccessLocksForStudentDateReason({
      studentId: row.student_id,
      date,
      reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
      unlockedBy: updatedBy
    })
  ]));
}

async function createPicketHoliday(payload = {}) {
  await ensurePicketTables();
  const normalized = normalizePicketHolidayPayload(payload);
  const updatedBy = payload.updatedBy || payload.updated_by || payload.createdBy || payload.created_by || null;
  const id = buildId("PKT-HOL");
  const result = await query(
    `
    INSERT INTO picket_holidays (id, holiday_date, name, notes, created_by, updated_by)
    VALUES ($1, $2::date, $3, $4, $5, $5)
    ON CONFLICT (holiday_date)
    DO UPDATE SET name = EXCLUDED.name,
                  notes = EXCLUDED.notes,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = NOW()
    RETURNING *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
    `,
    [id, normalized.date, normalized.name, normalized.notes, updatedBy]
  );
  await releasePicketLocksForHoliday(normalized.date, updatedBy);
  return mapPicketHoliday(result.rows[0]);
}

async function updatePicketHoliday(id, payload = {}) {
  await ensurePicketTables();
  const currentResult = await query(
    `SELECT *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text FROM picket_holidays WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (currentResult.rowCount === 0) return null;
  const current = mapPicketHoliday(currentResult.rows[0]);
  const normalized = normalizePicketHolidayPayload({
    date: payload.date || payload.holidayDate || payload.holiday_date || current.date,
    name: payload.name || payload.title || payload.label || current.name,
    notes: Object.prototype.hasOwnProperty.call(payload, "notes") ? payload.notes : current.notes
  });
  const updatedBy = payload.updatedBy || payload.updated_by || null;
  let result;
  try {
    result = await query(
      `
      UPDATE picket_holidays
      SET holiday_date = $2::date,
          name = $3,
          notes = $4,
          updated_by = $5,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
      `,
      [id, normalized.date, normalized.name, normalized.notes, updatedBy]
    );
  } catch (error) {
    if (error?.code === "23505") {
      const conflict = new Error(`Hari libur piket untuk tanggal ${normalized.date} sudah tersedia.`);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  await releasePicketLocksForHoliday(normalized.date, updatedBy);
  return mapPicketHoliday(result.rows[0]);
}

async function deletePicketHoliday(id) {
  await ensurePicketTables();
  const result = await query(
    `
    DELETE FROM picket_holidays
    WHERE id = $1
    RETURNING *, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date_text
    `,
    [id]
  );
  return result.rows[0] ? mapPicketHoliday(result.rows[0]) : null;
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
  const weeklySchedulePayload = getWeeklySchedulePayload(payload);
  const hasWeeklySchedulePayload = weeklySchedulePayload !== null;
  const weeklySchedule = hasWeeklySchedulePayload
    ? normalizeWeeklySchedule(weeklySchedulePayload)
    : current.weeklySchedule;
  const syncDate = payload.syncDate || payload.sync_date
    ? normalizeIsoDate(payload.syncDate || payload.sync_date)
    : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
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

    const settings = mapSettings(result.rows[0]);
    const shouldSync = Boolean(
      syncDate &&
      hasWeeklySchedulePayload &&
      isWeeklyScheduleChangedForDate(current, settings, syncDate)
    );
    let sync = syncDate
      ? { date: syncDate, skipped: !shouldSync }
      : null;

    if (shouldSync) {
      sync = await reconcilePicketAssignmentsForDate({
        date: syncDate,
        settings,
        generatedBy: payload.updatedBy || payload.updated_by || null,
        executor: client
      });
    }

    await client.query("COMMIT");
    return sync ? { ...settings, sync } : settings;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

async function listPicketDays({ includeInactive = true } = {}) {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT *
    FROM picket_days
    WHERE $1::boolean = TRUE OR active = TRUE
    ORDER BY id ASC
    `,
    [includeInactive]
  );
  return result.rows.map(mapDay);
}

async function listPicketStudentOptions() {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT s.id, s.nim, s.tipe, u.name, u.initials
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif'
      AND u.is_active = TRUE
    ORDER BY u.name ASC
    `
  );
  return result.rows.map((row) => ({
    id: row.id,
    student_id: row.id,
    studentId: row.id,
    name: row.name,
    student_name: row.name,
    studentName: row.name,
    nim: row.nim || null,
    initials: row.initials || String(row.name || "M").slice(0, 2).toUpperCase(),
    tipe: row.tipe || null
  }));
}

async function ensureStudentCanBeScheduled(studentId) {
  const result = await query(
    `
    SELECT s.id
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
      AND s.status = 'Aktif'
      AND u.is_active = TRUE
    LIMIT 1
    `,
    [studentId]
  );
  if (result.rowCount === 0) {
    const error = new Error("Mahasiswa tidak valid atau tidak aktif.");
    error.statusCode = 400;
    throw error;
  }
}

async function ensureTaskCanBeScheduled(taskId) {
  if (!taskId) return null;
  const result = await query(
    `
    SELECT id
    FROM picket_tasks
    WHERE id = $1
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [taskId]
  );
  if (result.rowCount === 0) {
    const error = new Error("Tugas piket tidak ditemukan.");
    error.statusCode = 400;
    throw error;
  }
  return taskId;
}

function getManualTaskName(payload = {}) {
  if (Object.prototype.hasOwnProperty.call(payload, "taskName")) return String(payload.taskName || "").trim();
  if (Object.prototype.hasOwnProperty.call(payload, "manualTaskName")) return String(payload.manualTaskName || "").trim();
  if (Object.prototype.hasOwnProperty.call(payload, "task_name")) return String(payload.task_name || "").trim();
  if (Object.prototype.hasOwnProperty.call(payload, "manual_task_name")) return String(payload.manual_task_name || "").trim();
  return null;
}

function getManualTaskDescription(payload = {}) {
  const value = payload.taskDescription ?? payload.task_description ?? payload.manualTaskDescription ?? payload.manual_task_description;
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

async function createInlinePicketTask(payload = {}) {
  const taskName = getManualTaskName(payload);
  if (taskName === null) return null;
  if (!taskName) {
    const error = new Error("taskName/manualTaskName wajib diisi saat taskId kosong.");
    error.statusCode = 400;
    throw error;
  }

  return createPicketTask({
    name: taskName,
    description: getManualTaskDescription(payload),
    active: true
  });
}

function createDuplicatePicketScheduleError(scheduleDate, studentId) {
  const error = new Error(`Jadwal piket untuk mahasiswa ${studentId} pada tanggal ${scheduleDate} sudah ada.`);
  error.statusCode = 409;
  return error;
}

async function ensureNoDuplicatePicketSchedule(scheduleDate, studentId, excludeId = null) {
  const result = await query(
    `
    SELECT id
    FROM picket_schedules
    WHERE schedule_date = $1::date
      AND student_id = $2
      AND ($3::text IS NULL OR id <> $3)
    LIMIT 1
    `,
    [scheduleDate, studentId, excludeId]
  );
  if (result.rowCount > 0) {
    throw createDuplicatePicketScheduleError(scheduleDate, studentId);
  }
}

function rethrowDuplicatePicketScheduleError(error, scheduleDate, studentId) {
  const constraint = String(error?.constraint || "");
  const detail = String(error?.detail || "");
  const isScheduleStudentDuplicate =
    error?.code === "23505" &&
    (
      constraint === "picket_schedules_schedule_date_student_id_key" ||
      constraint.includes("schedule_date_student_id") ||
      detail.includes("(schedule_date, student_id)")
    );

  if (isScheduleStudentDuplicate) {
    throw createDuplicatePicketScheduleError(scheduleDate, studentId);
  }
  throw error;
}

function getScheduleId(payload = {}) {
  return String(payload.scheduleId || payload.schedule_id || payload.assignmentId || payload.assignment_id || "").trim();
}

async function resolvePicketScheduleForSubmission({ scheduleId, studentId, date }) {
  const exact = await query(
    `
    SELECT id, student_id, TO_CHAR(schedule_date, 'YYYY-MM-DD') AS date_text, task_id
    FROM picket_schedules
    WHERE id = $1
    LIMIT 1
    `,
    [scheduleId]
  );
  if (exact.rowCount > 0) return exact.rows[0];

  const fallback = await query(
    `
    SELECT id, student_id, TO_CHAR(schedule_date, 'YYYY-MM-DD') AS date_text, task_id
    FROM picket_schedules
    WHERE student_id = $1
      AND schedule_date = $2::date
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
    `,
    [studentId, date]
  );
  return fallback.rows[0] || null;
}

async function listPicketSchedules({ date = null, studentId = null, dayId = null } = {}) {
  await ensurePicketTables();
  const params = [];
  const clauses = [];
  if (date) {
    params.push(normalizeIsoDate(date));
    clauses.push(`psch.schedule_date = $${params.length}::date`);
  }
  if (studentId) {
    const resolved = await resolveStudentId(studentId);
    params.push(resolved || studentId);
    clauses.push(`psch.student_id = $${params.length}`);
  }
  if (dayId != null && dayId !== "") {
    const parsedDayId = Number(dayId);
    if (!Number.isInteger(parsedDayId) || parsedDayId < 0 || parsedDayId > 6) {
      const error = new Error("dayId wajib berupa angka 0-6.");
      error.statusCode = 400;
      throw error;
    }
    params.push(parsedDayId);
    clauses.push(`psch.day_id = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    SELECT psch.id, TO_CHAR(psch.schedule_date, 'YYYY-MM-DD') AS date_text,
           psch.schedule_date, psch.day_id, pd.name AS day_name,
           psch.student_id, psch.task_id, psch.status, psch.notes,
           psch.generated_by, psch.generated_at, psch.created_by, psch.updated_by,
           psch.created_at, psch.updated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ph.id AS holiday_id, TO_CHAR(ph.holiday_date, 'YYYY-MM-DD') AS holiday_date_text,
           ph.name AS holiday_name, ph.notes AS holiday_notes,
           psub.id AS submission_id, psub.status AS submission_status
    FROM picket_schedules psch
    JOIN picket_days pd ON pd.id = psch.day_id
    JOIN students s ON s.id = psch.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = psch.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = psch.schedule_date
    LEFT JOIN picket_submissions psub ON psub.schedule_id = psch.id
    ${where}
    ORDER BY psch.schedule_date DESC, pd.id ASC, u.name ASC
    `,
    params
  );
  return result.rows.map(mapAssignment);
}

async function getPicketScheduleById(id, executor = query) {
  const result = await runQuery(
    executor,
    `
    SELECT psch.id, TO_CHAR(psch.schedule_date, 'YYYY-MM-DD') AS date_text,
           psch.schedule_date, psch.day_id, pd.name AS day_name,
           psch.student_id, psch.task_id, psch.status, psch.notes,
           psch.generated_by, psch.generated_at, psch.created_by, psch.updated_by,
           psch.created_at, psch.updated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ph.id AS holiday_id, TO_CHAR(ph.holiday_date, 'YYYY-MM-DD') AS holiday_date_text,
           ph.name AS holiday_name, ph.notes AS holiday_notes,
           psub.id AS submission_id, psub.status AS submission_status
    FROM picket_schedules psch
    JOIN picket_days pd ON pd.id = psch.day_id
    JOIN students s ON s.id = psch.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = psch.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = psch.schedule_date
    LEFT JOIN picket_submissions psub ON psub.schedule_id = psch.id
    WHERE psch.id = $1
    LIMIT 1
    `,
    [id]
  );
  return result.rows[0] ? mapAssignment(result.rows[0]) : null;
}

async function createPicketSchedule(payload = {}) {
  await ensurePicketTables();
  const scheduleDate = normalizeIsoDate(payload.scheduleDate || payload.schedule_date || payload.date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(scheduleDate);
  const studentId = await resolveStudentId(payload.studentId || payload.student_id);
  let taskId = String(payload.taskId || payload.task_id || "").trim();
  const status = String(payload.status || "Ditugaskan").trim() || "Ditugaskan";
  if (!studentId) {
    const error = new Error("scheduleDate/date dan studentId wajib diisi.");
    error.statusCode = 400;
    throw error;
  }
  await ensureStudentCanBeScheduled(studentId);
  await ensureNoDuplicatePicketSchedule(scheduleDate, studentId);

  let createdTask = null;
  if (!taskId) {
    createdTask = await createInlinePicketTask(payload);
    taskId = createdTask?.id || "";
  }
  if (!taskId) {
    const error = new Error("taskId wajib diisi atau kirim taskName/manualTaskName untuk membuat tugas manual.");
    error.statusCode = 400;
    throw error;
  }
  await ensureTaskCanBeScheduled(taskId);

  const id = buildId("PKT-SCH");
  const dayId = getJakartaDayOfWeek(scheduleDate);
  let result;
  try {
    result = await query(
      `
      INSERT INTO picket_schedules (
        id, schedule_date, day_id, student_id, task_id, status, notes,
        generated_by, created_by, updated_by
      )
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, NULL, $8, $8)
      RETURNING id
      `,
      [
        id,
        scheduleDate,
        dayId,
        studentId,
        taskId,
        status,
        payload.notes == null ? null : String(payload.notes),
        payload.createdBy || payload.created_by || payload.updatedBy || payload.updated_by || null
      ]
    );
  } catch (error) {
    rethrowDuplicatePicketScheduleError(error, scheduleDate, studentId);
  }
  const schedule = await getPicketScheduleById(result.rows[0].id);
  return createdTask
    ? { schedule, assignment: schedule, task: createdTask }
    : schedule;
}

async function updatePicketSchedule(id, payload = {}) {
  await ensurePicketTables();
  const current = await getPicketScheduleById(id);
  if (!current) return null;

  const scheduleDate = payload.scheduleDate || payload.schedule_date || payload.date
    ? normalizeIsoDate(payload.scheduleDate || payload.schedule_date || payload.date)
    : current.date;
  await ensurePicketDateIsNotHoliday(scheduleDate);
  const studentId = payload.studentId || payload.student_id
    ? await resolveStudentId(payload.studentId || payload.student_id)
    : current.studentId;
  const hasTaskPayload = Object.prototype.hasOwnProperty.call(payload, "taskId") ||
    Object.prototype.hasOwnProperty.call(payload, "task_id");
  let taskId = hasTaskPayload
    ? String(payload.taskId ?? payload.task_id ?? "").trim()
    : current.taskId;
  const hasManualTaskPayload = getManualTaskName(payload) !== null;
  if (hasManualTaskPayload && (!hasTaskPayload || !taskId)) {
    taskId = "";
  }
  const status = payload.status == null ? current.status : String(payload.status).trim();

  if (!studentId) {
    const error = new Error("Mahasiswa tidak ditemukan.");
    error.statusCode = 400;
    throw error;
  }
  await ensureStudentCanBeScheduled(studentId);
  await ensureNoDuplicatePicketSchedule(scheduleDate, studentId, id);

  let createdTask = null;
  if (hasTaskPayload && !taskId && !hasManualTaskPayload) {
    const error = new Error("taskId wajib diisi atau kirim taskName/manualTaskName untuk membuat tugas manual.");
    error.statusCode = 400;
    throw error;
  }
  if (!taskId) {
    createdTask = await createInlinePicketTask(payload);
    taskId = createdTask?.id || "";
  }
  await ensureTaskCanBeScheduled(taskId);

  let result;
  try {
    result = await query(
      `
      UPDATE picket_schedules
      SET schedule_date = $2::date,
          day_id = $3,
          student_id = $4,
          task_id = $5,
          status = $6,
          notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
          updated_by = $9,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [
        id,
        scheduleDate,
        getJakartaDayOfWeek(scheduleDate),
        studentId,
        taskId || null,
        status || "Ditugaskan",
        Object.prototype.hasOwnProperty.call(payload, "notes"),
        payload.notes == null ? null : String(payload.notes),
        payload.updatedBy || payload.updated_by || null
      ]
    );
  } catch (error) {
    rethrowDuplicatePicketScheduleError(error, scheduleDate, studentId);
  }
  if (!result.rows[0]) return null;
  const schedule = await getPicketScheduleById(result.rows[0].id);
  return createdTask
    ? { schedule, assignment: schedule, task: createdTask }
    : schedule;
}

async function deletePicketSchedule(id) {
  await ensurePicketTables();
  const existing = await getPicketScheduleById(id);
  if (!existing) return null;
  await query("DELETE FROM picket_schedules WHERE id = $1", [id]);
  return existing;
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
        FROM picket_schedules recent
        WHERE recent.student_id = s.id
          AND recent.schedule_date < $1::date
          AND recent.schedule_date >= ($1::date - ($2::int * INTERVAL '1 day'))
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
        FROM picket_schedules existing
        WHERE existing.student_id = s.id
          AND existing.schedule_date = $1::date
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
    FROM picket_schedules
    WHERE student_id = $1 AND task_id IS NOT NULL
    ORDER BY schedule_date DESC, generated_at DESC
    LIMIT 1
    `,
    [studentId]
  );
  const previousTaskId = previous.rows[0]?.task_id;
  const candidates = activeTasks.filter((task) => task.id !== previousTaskId);
  return candidates[Math.floor(Math.random() * candidates.length)] || activeTasks[0];
}

async function fetchAssignmentsByDate(date, executor = query) {
  const result = await runQuery(
    executor,
    `
    SELECT pa.id, TO_CHAR(pa.schedule_date, 'YYYY-MM-DD') AS date_text,
           pa.schedule_date, pa.day_id, pd.name AS day_name,
           pa.student_id, pa.task_id, pa.status, pa.notes,
           pa.generated_by, pa.generated_at, pa.created_by, pa.updated_by,
           pa.created_at, pa.updated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ph.id AS holiday_id, TO_CHAR(ph.holiday_date, 'YYYY-MM-DD') AS holiday_date_text,
           ph.name AS holiday_name, ph.notes AS holiday_notes,
           ps.id AS submission_id,
           ps.schedule_id AS submission_schedule_id,
           ps.assignment_id AS submission_assignment_id,
           ps.status AS submission_status,
           ps.photo_url AS submission_photo_url,
           ps.file_url AS submission_file_url,
           ps.photo_file_name AS submission_photo_file_name,
           ps.submitted_at AS submission_submitted_at,
           ps.reviewed_at AS submission_reviewed_at,
           ps.reviewed_by AS submission_reviewed_by,
           ps.review_note AS submission_review_note
    FROM picket_schedules pa
    JOIN picket_days pd ON pd.id = pa.day_id
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = pa.schedule_date
    LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
    WHERE pa.schedule_date = $1::date
    ORDER BY u.name ASC
    `,
    [date]
  );
  return result.rows.map(mapAssignment);
}

async function normalizeManualStudentIds(studentIds, { allowEmpty = false, activeOnly = true } = {}) {
  const uniqueIds = [...new Set((studentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (uniqueIds.length === 0) {
    if (allowEmpty) return [];

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
      AND (
        $2::boolean = FALSE
        OR (s.status = 'Aktif' AND u.is_active = TRUE)
      )
    `,
    [uniqueIds, activeOnly]
  );
  const foundIds = new Set(result.rows.map((row) => row.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    const reason = activeOnly ? "tidak valid atau tidak aktif" : "tidak valid";
    const error = new Error(`studentIds ${reason}: ${missingIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return uniqueIds;
}

async function generateManualPicketSchedule({ date, studentIds, activeTasks, generatedBy = null, allowEmptyStudentIds = false }) {
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(targetDate);
  const manualStudentIds = await normalizeManualStudentIds(studentIds, { allowEmpty: allowEmptyStudentIds });
  const createdIds = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
      DELETE FROM picket_schedules psch
      WHERE psch.schedule_date = $1::date
        AND NOT EXISTS (
          SELECT 1 FROM picket_submissions psub WHERE psub.schedule_id = psch.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM picket_leave_requests plr WHERE plr.schedule_id = psch.id
        )
      `,
      [targetDate]
    );

    for (let index = 0; index < manualStudentIds.length; index += 1) {
      const studentId = manualStudentIds[index];
      const task = activeTasks.length > 1
        ? activeTasks[index % activeTasks.length]
        : await chooseTaskForStudent(studentId, activeTasks);
      const id = buildId("PKT-SCH");

      const result = await client.query(
        `
        INSERT INTO picket_schedules (id, schedule_date, day_id, student_id, task_id, status, generated_by, created_by, updated_by)
        VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6, $6)
        ON CONFLICT (schedule_date, student_id)
        DO UPDATE SET task_id = EXCLUDED.task_id,
                      status = 'Ditugaskan',
                      generated_by = EXCLUDED.generated_by,
                      generated_at = NOW(),
                      updated_by = EXCLUDED.updated_by,
                      updated_at = NOW()
        RETURNING id
        `,
        [id, targetDate, getJakartaDayOfWeek(targetDate), studentId, task.id, generatedBy]
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

async function generatePicketSchedule({
  date,
  peoplePerDay,
  randomize,
  studentIds,
  replaceExisting,
  overwrite,
  generatedBy = null
} = {}) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(targetDate);
  const settings = await getPicketSettings();
  const weeklySchedule = getWeeklyScheduleForDate(settings, targetDate);
  const weeklyStudentIds = weeklySchedule?.studentIds || [];
  const explicitStudentIdsProvided = Array.isArray(studentIds);
  const shouldReplaceExisting = normalizeBoolean(replaceExisting ?? overwrite, false);
  const effectiveStudentIds =
    explicitStudentIdsProvided
      ? studentIds
      : weeklySchedule
        ? weeklyStudentIds
        : studentIds;
  const targetCount = Array.isArray(effectiveStudentIds) && effectiveStudentIds.length > 0
    ? effectiveStudentIds.length
    : normalizePositiveInteger(
        peoplePerDay ?? weeklySchedule?.peoplePerDay,
        settings.peoplePerDay,
        "peoplePerDay"
      );
  const useRandom = normalizeBoolean(randomize, settings.randomizeEnabled);

  if (shouldReplaceExisting && !Array.isArray(effectiveStudentIds)) {
    const error = new Error("studentIds wajib diisi saat replaceExisting atau overwrite bernilai true.");
    error.statusCode = 400;
    throw error;
  }

  if (Array.isArray(effectiveStudentIds) && (shouldReplaceExisting || effectiveStudentIds.length > 0)) {
    const allowEmptyStudentIds = shouldReplaceExisting || explicitStudentIdsProvided;
    const manualStudentIds = await normalizeManualStudentIds(effectiveStudentIds, { allowEmpty: allowEmptyStudentIds });
    const activeTasks = manualStudentIds.length > 0
      ? await listPicketTasks({ includeInactive: false })
      : [];
    if (manualStudentIds.length > 0 && activeTasks.length === 0) {
      const error = new Error("Belum ada tugas piket aktif.");
      error.statusCode = 400;
      throw error;
    }

    return generateManualPicketSchedule({
      date: targetDate,
      studentIds: manualStudentIds,
      activeTasks,
      generatedBy,
      allowEmptyStudentIds
    });
  }

  const activeTasks = await listPicketTasks({ includeInactive: false });
  if (activeTasks.length === 0) {
    const error = new Error("Belum ada tugas piket aktif.");
    error.statusCode = 400;
    throw error;
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
    const id = buildId("PKT-SCH");
    const result = await query(
      `
      INSERT INTO picket_schedules (id, schedule_date, day_id, student_id, task_id, status, generated_by, created_by, updated_by)
      VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6, $6)
      ON CONFLICT (schedule_date, student_id) DO NOTHING
      RETURNING id
      `,
      [id, targetDate, getJakartaDayOfWeek(targetDate), student.id, task.id, generatedBy]
    );
    if (result.rowCount > 0) createdIds.push(result.rows[0].id);
  }

  return {
    date: targetDate,
    assignments: await fetchAssignmentsByDate(targetDate),
    created: createdIds
  };
}

async function reconcilePicketAssignmentsForDate({ date, settings = null, generatedBy = null, executor = null } = {}) {
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(targetDate, executor || query);
  const effectiveSettings = settings || await getPicketSettings();
  const weeklySchedule = getWeeklyScheduleForDate(effectiveSettings, targetDate);
  const weeklyStudentIds = await normalizeManualStudentIds(weeklySchedule?.studentIds || [], {
    allowEmpty: true,
    activeOnly: false
  });
  const dayOfWeek = getJakartaDayOfWeek(targetDate);
  const createdIds = [];
  const updatedIds = [];
  const client = executor || await pool.connect();
  const ownsTransaction = !executor;

  try {
    if (ownsTransaction) await client.query("BEGIN");

    const removed = await runQuery(
      client,
      `
      WITH ranked AS (
        SELECT pa.id,
               pa.student_id,
               (ps.id IS NOT NULL) AS has_submission,
               (plr.id IS NOT NULL) AS has_leave_request,
               ROW_NUMBER() OVER (
                 PARTITION BY pa.student_id
                 ORDER BY (ps.id IS NOT NULL) DESC, pa.generated_at DESC, pa.created_at DESC, pa.id ASC
               ) AS student_rank
        FROM picket_schedules pa
        LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
        LEFT JOIN picket_leave_requests plr ON plr.schedule_id = pa.id
        WHERE pa.schedule_date = $1::date
      )
      DELETE FROM picket_schedules pa
      USING ranked
      WHERE pa.id = ranked.id
        AND ranked.has_submission = FALSE
        AND ranked.has_leave_request = FALSE
        AND (
          NOT (ranked.student_id = ANY($2::text[]))
          OR ranked.student_rank > 1
        )
      RETURNING pa.id, pa.student_id
      `,
      [targetDate, weeklyStudentIds]
    );

    const existing = await runQuery(
      client,
      `
      SELECT id, student_id
      FROM picket_schedules
      WHERE schedule_date = $1::date
        AND student_id = ANY($2::text[])
      FOR UPDATE
      `,
      [targetDate, weeklyStudentIds]
    );
    const existingByStudentId = new Map(existing.rows.map((row) => [row.student_id, row.id]));

    const activeTasks = weeklyStudentIds.length > 0
      ? (await runQuery(
          client,
          `
          SELECT *
          FROM picket_tasks
          WHERE deleted_at IS NULL
            AND active = TRUE
          ORDER BY name ASC
          `
        )).rows.map(mapTask)
      : [];
    if (weeklyStudentIds.length > 0 && activeTasks.length === 0) {
      const error = new Error("Belum ada tugas piket aktif.");
      error.statusCode = 400;
      throw error;
    }

    for (let index = 0; index < weeklyStudentIds.length; index += 1) {
      const studentId = weeklyStudentIds[index];
      const task = activeTasks[index % activeTasks.length];
      const existingId = existingByStudentId.get(studentId);

      if (existingId) {
        const result = await runQuery(
          client,
          `
          UPDATE picket_schedules
          SET task_id = $2,
              status = 'Ditugaskan',
              generated_by = $3,
              generated_at = NOW(),
              updated_by = $3,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id
          `,
          [existingId, task.id, generatedBy]
        );
        if (result.rowCount > 0) updatedIds.push(result.rows[0].id);
        continue;
      }

      const id = buildId("PKT-SCH");
      const result = await runQuery(
        client,
        `
        INSERT INTO picket_schedules (id, schedule_date, day_id, student_id, task_id, status, generated_by, created_by, updated_by)
        VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6, $6)
        ON CONFLICT (schedule_date, student_id)
        DO UPDATE SET task_id = EXCLUDED.task_id,
                      status = 'Ditugaskan',
                      generated_by = EXCLUDED.generated_by,
                      generated_at = NOW(),
                      updated_by = EXCLUDED.updated_by,
                      updated_at = NOW()
        RETURNING id
        `,
        [id, targetDate, dayOfWeek, studentId, task.id, generatedBy]
      );
      createdIds.push(result.rows[0].id);
    }

    const assignments = await fetchAssignmentsByDate(targetDate, client);
    if (ownsTransaction) await client.query("COMMIT");

    return {
      date: targetDate,
      dayOfWeek,
      weeklyStudentIds,
      assignments,
      created: createdIds,
      updated: updatedIds,
      removed: removed.rows.map((row) => row.id),
      removedStudentIds: removed.rows.map((row) => row.student_id)
    };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

async function resyncPicketSchedule({ date, generatedBy = null } = {}) {
  await ensurePicketTables();
  return reconcilePicketAssignmentsForDate({ date, generatedBy });
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

function normalizeSubmissionStatusFilter(value) {
  const status = String(value || "").trim();
  if (!status) return null;
  if (status === "Menunggu") return "Terkirim";
  if (SUBMISSION_STATUSES.includes(status)) return status;

  const error = new Error("status wajib salah satu dari Menunggu, Terkirim, Valid, Bermasalah.");
  error.statusCode = 400;
  throw error;
}

function mapPicketSubmissionApproval(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id || row.assignment_id,
    assignmentId: row.assignment_id || row.schedule_id,
    studentId: row.student_id,
    studentName: row.student_name || null,
    nim: row.nim || null,
    taskName: row.task_name || null,
    date: row.date_text || row.date,
    photoUrl: row.photo_url || row.file_url || null,
    submittedAt: row.submitted_at || null,
    status: row.status,
    reviewNote: row.review_note || null
  };
}

async function listPicketSubmissions({
  status = null,
  date = null,
  startDate = null,
  endDate = null
} = {}) {
  await ensurePicketTables();
  const params = [];
  const clauses = [];
  const statusFilter = normalizeSubmissionStatusFilter(status);

  if (statusFilter) {
    params.push(statusFilter);
    clauses.push(`ps.status = $${params.length}`);
  }

  if (date) {
    params.push(normalizeIsoDate(date));
    clauses.push(`ps.date = $${params.length}::date`);
  } else {
    if (startDate) {
      params.push(normalizeIsoDate(startDate));
      clauses.push(`ps.date >= $${params.length}::date`);
    }
    if (endDate) {
      params.push(normalizeIsoDate(endDate));
      clauses.push(`ps.date <= $${params.length}::date`);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    SELECT ps.id, ps.schedule_id, ps.assignment_id, ps.student_id,
           TO_CHAR(ps.date, 'YYYY-MM-DD') AS date_text,
           ps.photo_url, ps.file_url, ps.status, ps.submitted_at, ps.review_note,
           s.nim, u.name AS student_name, pt.name AS task_name
    FROM picket_submissions ps
    JOIN students s ON s.id = ps.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_schedules psch ON psch.id = ps.schedule_id
    LEFT JOIN picket_tasks pt ON pt.id = psch.task_id
    ${where}
    ORDER BY ps.date DESC, ps.submitted_at DESC, u.name ASC
    `,
    params
  );
  return result.rows.map(mapPicketSubmissionApproval);
}

async function getPicketOverview(date) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const [assignments, submissions, leaveRequests, holiday] = await Promise.all([
    fetchAssignmentsByDate(targetDate),
    listSubmissions({ date: targetDate }),
    listPicketLeaveRequests({ date: targetDate }),
    getPicketHolidayByDate(targetDate)
  ]);
  return {
    date: targetDate,
    is_holiday: Boolean(holiday),
    isHoliday: Boolean(holiday),
    holiday,
    schedules: assignments,
    assignments,
    submissions,
    leaveRequests,
    sync: {
      date: targetDate,
      skipped: true,
      reason: "overview_read_only"
    }
  };
}

async function getPicketTodayForStudent(studentIdOrUserId, date = getJakartaDateIso()) {
  await ensurePicketTables();
  const studentId = await resolveStudentId(studentIdOrUserId);
  if (!studentId) return { assignment: null, holiday: null, isHoliday: false, is_holiday: false };
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const holiday = await getPicketHolidayByDate(targetDate);
  const result = await query(
    `
    SELECT pa.id, TO_CHAR(pa.schedule_date, 'YYYY-MM-DD') AS date_text,
           pa.schedule_date, pa.day_id, pd.name AS day_name,
           pa.student_id, pa.task_id, pa.status, pa.notes,
           pa.generated_by, pa.generated_at, pa.created_by, pa.updated_by,
           pa.created_at, pa.updated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ph.id AS holiday_id, TO_CHAR(ph.holiday_date, 'YYYY-MM-DD') AS holiday_date_text,
           ph.name AS holiday_name, ph.notes AS holiday_notes,
           ps.id AS submission_id,
           ps.schedule_id AS submission_schedule_id,
           ps.assignment_id AS submission_assignment_id,
           ps.status AS submission_status,
           ps.photo_url AS submission_photo_url,
           ps.file_url AS submission_file_url,
           ps.photo_file_name AS submission_photo_file_name,
           ps.submitted_at AS submission_submitted_at,
           ps.reviewed_at AS submission_reviewed_at,
           ps.reviewed_by AS submission_reviewed_by,
           ps.review_note AS submission_review_note
    FROM picket_schedules pa
    JOIN picket_days pd ON pd.id = pa.day_id
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = pa.schedule_date
    LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
    WHERE pa.student_id = $1 AND pa.schedule_date = $2::date
    LIMIT 1
    `,
    [studentId, targetDate]
  );
  return {
    assignment: result.rows[0] ? mapAssignment(result.rows[0]) : null,
    holiday,
    is_holiday: Boolean(holiday),
    isHoliday: Boolean(holiday),
    is_exempt: Boolean(holiday),
    isExempt: Boolean(holiday)
  };
}

async function getPicketHistory(studentIdOrUserId) {
  await ensurePicketTables();
  const studentId = await resolveStudentId(studentIdOrUserId);
  if (!studentId) return [];
  const result = await query(
    `
    SELECT pa.id, TO_CHAR(pa.schedule_date, 'YYYY-MM-DD') AS date_text,
           pa.schedule_date, pa.day_id, pd.name AS day_name,
           pa.student_id, pa.task_id, pa.status, pa.notes,
           pa.generated_by, pa.generated_at, pa.created_by, pa.updated_by,
           pa.created_at, pa.updated_at,
           s.nim, u.name AS student_name,
           pt.name AS task_name, pt.description AS task_description,
           ph.id AS holiday_id, TO_CHAR(ph.holiday_date, 'YYYY-MM-DD') AS holiday_date_text,
           ph.name AS holiday_name, ph.notes AS holiday_notes,
           ps.id AS submission_id,
           ps.schedule_id AS submission_schedule_id,
           ps.assignment_id AS submission_assignment_id,
           ps.status AS submission_status,
           ps.photo_url AS submission_photo_url,
           ps.file_url AS submission_file_url,
           ps.photo_file_name AS submission_photo_file_name,
           ps.submitted_at AS submission_submitted_at,
           ps.reviewed_at AS submission_reviewed_at,
           ps.reviewed_by AS submission_reviewed_by,
           ps.review_note AS submission_review_note
    FROM picket_schedules pa
    JOIN picket_days pd ON pd.id = pa.day_id
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = pa.schedule_date
    LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
    WHERE pa.student_id = $1
    ORDER BY pa.schedule_date DESC, pa.created_at DESC, pa.id ASC
    `,
    [studentId]
  );
  return result.rows.map(mapAssignment);
}

async function hasApprovedPicketLeave({ scheduleId, assignmentId, studentId, date }) {
  await ensurePicketTables();
  const effectiveScheduleId = scheduleId || assignmentId || null;
  const result = await query(
    `
    SELECT 1
    FROM picket_leave_requests
    WHERE status = 'Disetujui'
      AND ($1::text IS NULL OR schedule_id = $1 OR assignment_id = $1)
      AND ($2::text IS NULL OR student_id = $2)
      AND ($3::date IS NULL OR date = $3::date)
    LIMIT 1
    `,
    [effectiveScheduleId, studentId || null, date || null]
  );
  return result.rowCount > 0;
}

async function getPicketCheckoutRequirement(studentIdOrUserId, date = getJakartaDateIso()) {
  const today = await getPicketTodayForStudent(studentIdOrUserId, date);
  const assignment = today.assignment;
  if (today.isHoliday) {
    return {
      required: false,
      assignment,
      holiday: today.holiday,
      isHoliday: true,
      is_holiday: true,
      isExempt: true,
      is_exempt: true,
      approvedLeave: false,
      submitted: assignment?.submitted === true
    };
  }
  if (!assignment) {
    return { required: false, assignment: null, approvedLeave: false, submitted: false };
  }

  const approvedLeave = await hasApprovedPicketLeave({
    scheduleId: assignment.id,
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
  const scheduleId = getScheduleId(payload);
  const studentId = await resolveStudentId(payload.studentId || payload.student_id);
  const date = normalizeIsoDate(payload.date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(date);
  if (!scheduleId || !studentId) {
    const error = new Error("scheduleId dan studentId wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  const schedule = await resolvePicketScheduleForSubmission({ scheduleId, studentId, date });
  if (!schedule) {
    const error = new Error("Jadwal piket tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
  if (schedule.student_id !== studentId || schedule.date_text !== date) {
    const error = new Error("Jadwal piket tidak sesuai dengan studentId/date.");
    error.statusCode = 400;
    throw error;
  }
  const effectiveScheduleId = schedule.id;
  const taskId = String(payload.taskId || payload.task_id || "").trim();
  if (taskId && schedule.task_id !== taskId) {
    const error = new Error("taskId tidak sesuai dengan jadwal piket.");
    error.statusCode = 400;
    throw error;
  }

  const photoUrl = await savePicketPhoto(payload.photoDataUrl || payload.photo_data_url, payload.photoFileName || payload.photo_file_name || "picket-photo");
  const result = await query(
    `
    INSERT INTO picket_submissions (
      id, schedule_id, assignment_id, student_id, date, photo_url, file_url, photo_file_name, source, status
    )
    VALUES ($1, $2, $2, $3, $4::date, $5, $5, $6, $7, 'Terkirim')
    ON CONFLICT (schedule_id)
    DO UPDATE SET photo_url = EXCLUDED.photo_url,
                  assignment_id = EXCLUDED.assignment_id,
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
      effectiveScheduleId,
      studentId,
      date,
      photoUrl,
      payload.photoFileName || payload.photo_file_name || null,
      payload.source == null ? null : String(payload.source)
    ]
  );
  const submission = mapSubmission(result.rows[0]);
  await deactivateAccessLocksForStudentDateReason({
    studentId,
    date,
    reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING
  });

  const assignment = await getPicketScheduleById(effectiveScheduleId);
  return {
    ...submission,
    submission,
    assignment,
    schedule: assignment,
    submitted: assignment?.submitted === true,
    submissionStatus: assignment?.submissionStatus || submission.status,
    submission_status: assignment?.submission_status || submission.status
  };
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
  } else if (status === "Valid") {
    await Promise.all([
      deactivateAccessLocksForStudentDateReason({
        studentId: submission.studentId,
        date: submission.date,
        reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
        unlockedBy: reviewedBy
      }),
      deactivateAccessLocksForStudentDateReason({
        studentId: submission.studentId,
        date: submission.date,
        reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING,
        unlockedBy: reviewedBy
      })
    ]);
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
  const scheduleId = getScheduleId(payload);
  const studentId = await resolveStudentId(payload.studentId || payload.student_id);
  const date = normalizeIsoDate(payload.date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(date);
  const reason = String(payload.reason || "").trim();
  if (!scheduleId || !studentId || !reason) {
    const error = new Error("scheduleId, studentId, date, dan reason wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  const schedule = await query(
    "SELECT id, student_id, TO_CHAR(schedule_date, 'YYYY-MM-DD') AS date_text FROM picket_schedules WHERE id = $1 LIMIT 1",
    [scheduleId]
  );
  if (schedule.rowCount === 0) {
    const error = new Error("Jadwal piket tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
  if (schedule.rows[0].student_id !== studentId || schedule.rows[0].date_text !== date) {
    const error = new Error("Jadwal piket tidak sesuai dengan studentId/date.");
    error.statusCode = 400;
    throw error;
  }

  const result = await query(
    `
    INSERT INTO picket_leave_requests (id, schedule_id, assignment_id, student_id, date, reason, status)
    VALUES ($1, $2, $2, $3, $4::date, $5, 'Menunggu')
    ON CONFLICT (schedule_id, student_id)
    DO UPDATE SET reason = EXCLUDED.reason,
                  assignment_id = EXCLUDED.assignment_id,
                  status = 'Menunggu',
                  reviewed_by = NULL,
                  reviewed_at = NULL,
                  review_note = NULL,
                  updated_at = NOW()
    RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text
    `,
    [buildId("PKT-LV"), scheduleId, studentId, date, reason]
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
  createPicketHoliday,
  createPicketLeaveRequest,
  createPicketSchedule,
  createPicketSubmission,
  createPicketTask,
  deletePicketHoliday,
  deletePicketSchedule,
  deletePicketTask,
  ensurePicketTables,
  generatePicketSchedule,
  getPicketCheckoutRequirement,
  getPicketHistory,
  getPicketHolidayByDate,
  getPicketOverview,
  getPicketSettings,
  getPicketTodayForStudent,
  isPicketManagerUser,
  listPicketDays,
  listPicketHolidays,
  listPicketLeaveRequests,
  listPicketManagers,
  listPicketSchedules,
  listPicketSubmissions,
  listPicketStudentOptions,
  listPicketTasks,
  replacePicketManagers,
  resyncPicketSchedule,
  reviewPicketLeaveRequest,
  reviewPicketSubmission,
  updatePicketSchedule,
  updatePicketHoliday,
  updatePicketSettings,
  updatePicketTask
};
