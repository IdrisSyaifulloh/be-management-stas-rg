const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pool, query } = require("../db/pool");
const { getJakartaDateIso } = require("./attendanceHistory");
const { resolveStudentId, resolveStudentRecord } = require("./studentResolver");
const { addIsoDays, findNextPicketReplacementDate } = require("./picketLeaveReplacement");
const {
  expandIsoDateRange,
  normalizeStudentLeaveType,
  resolveStudentLeavePicketAction,
  selectPicketSchedulesOnLeaveDates
} = require("./studentLeavePicketPolicy");
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

        CREATE TABLE IF NOT EXISTS picket_student_days (
          student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
          day_id SMALLINT NOT NULL REFERENCES picket_days(id),
          effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
          assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE picket_student_days
        ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE;

        CREATE TABLE IF NOT EXISTS picket_schedules (
          id TEXT PRIMARY KEY,
          schedule_date DATE NOT NULL,
          day_id SMALLINT NOT NULL REFERENCES picket_days(id),
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES picket_tasks(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'Ditugaskan',
          notes TEXT,
          auto_leave_request_id TEXT,
          auto_leave_type TEXT,
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
          source_leave_request_id TEXT,
          replacement_schedule_id TEXT REFERENCES picket_schedules(id) ON DELETE SET NULL,
          replacement_date DATE,
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
        CREATE INDEX IF NOT EXISTS idx_picket_student_days_day ON picket_student_days(day_id, student_id);
      `);

      await query(`
        ALTER TABLE picket_schedules
        ADD COLUMN IF NOT EXISTS auto_leave_request_id TEXT,
        ADD COLUMN IF NOT EXISTS auto_leave_type TEXT;

        ALTER TABLE picket_leave_requests
        ADD COLUMN IF NOT EXISTS source_leave_request_id TEXT;

        CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_source_leave
        ON picket_leave_requests(source_leave_request_id);
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

        ALTER TABLE picket_leave_requests
        ADD COLUMN IF NOT EXISTS replacement_schedule_id TEXT,
        ADD COLUMN IF NOT EXISTS replacement_date DATE;

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

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'picket_leave_requests_replacement_schedule_id_fkey'
          ) THEN
            ALTER TABLE picket_leave_requests
            ADD CONSTRAINT picket_leave_requests_replacement_schedule_id_fkey
            FOREIGN KEY (replacement_schedule_id) REFERENCES picket_schedules(id) ON DELETE SET NULL
            NOT VALID;
          END IF;
        END $$;

        CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_replacement_schedule
        ON picket_leave_requests(replacement_schedule_id);
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

      await initializePicketStudentDays();
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
    const dayOfWeek = Number(item?.dayOfWeek ?? item?.day_of_week ?? item?.dayId ?? item?.day_id);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

    const studentIds = [...new Set((item?.studentIds || item?.student_ids || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))];
    const fallbackPeoplePerDay = studentIds.length > 0 ? studentIds.length : 1;

    byDay.set(dayOfWeek, {
      dayOfWeek,
      day_of_week: dayOfWeek,
      label: String(item?.label || "").trim(),
      enabled: item?.enabled === undefined && item?.active === undefined
        ? true
        : Boolean(item?.enabled ?? item?.active),
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

function chooseLeastLoadedPicketDay(dayIds, countsByDay, random = Math.random) {
  if (!Array.isArray(dayIds) || dayIds.length === 0) return null;
  const minimum = Math.min(...dayIds.map((dayId) => Number(countsByDay.get(dayId) || 0)));
  const candidates = dayIds.filter((dayId) => Number(countsByDay.get(dayId) || 0) === minimum);
  return candidates[Math.floor(random() * candidates.length)] ?? candidates[0] ?? null;
}

function buildRandomizedPicketDayAssignments(studentIds, dayIds, random = Math.random) {
  if (!Array.isArray(dayIds) || dayIds.length === 0) return [];
  const randomizedStudents = shuffle(studentIds, random);
  const randomizedDays = shuffle(dayIds, random);
  return randomizedStudents.map((studentId, index) => ({
    studentId,
    dayId: randomizedDays[index % randomizedDays.length]
  }));
}

async function getFixedPicketDayConfig(executor = query) {
  const [settingsResult, daysResult] = await Promise.all([
    runQuery(executor, "SELECT * FROM picket_settings WHERE id = $1 LIMIT 1", [DEFAULT_SETTINGS_ID]),
    runQuery(executor, "SELECT id, name FROM picket_days WHERE active = TRUE ORDER BY id ASC")
  ]);
  const settings = mapSettings(settingsResult.rows[0]);
  const activeDays = daysResult.rows.map((row) => ({ id: Number(row.id), name: row.name }));
  const activeDayIds = new Set(activeDays.map((day) => day.id));
  const configuredDayIds = settings.weeklySchedule
    .filter((item) => item.enabled !== false && activeDayIds.has(item.dayOfWeek))
    .map((item) => item.dayOfWeek);

  return {
    settings,
    activeDays,
    dayIds: configuredDayIds.length > 0 ? configuredDayIds : [...activeDayIds]
  };
}

async function syncWeeklyScheduleFromFixedDays(executor = query) {
  const { settings, activeDays, dayIds } = await getFixedPicketDayConfig(executor);
  const assignments = await runQuery(
    executor,
    `
    SELECT psd.student_id, psd.day_id
    FROM picket_student_days psd
    JOIN students s ON s.id = psd.student_id
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif' AND u.is_active = TRUE
    ORDER BY psd.day_id ASC, psd.student_id ASC
    `
  );
  const studentIdsByDay = new Map(dayIds.map((dayId) => [dayId, []]));
  for (const row of assignments.rows) {
    const dayId = Number(row.day_id);
    if (studentIdsByDay.has(dayId)) studentIdsByDay.get(dayId).push(row.student_id);
  }

  const dayNames = new Map(activeDays.map((day) => [day.id, day.name]));
  const existingByDay = new Map(settings.weeklySchedule.map((item) => [item.dayOfWeek, item]));
  const weeklySchedule = dayIds.map((dayId) => {
    const current = existingByDay.get(dayId);
    const studentIds = studentIdsByDay.get(dayId) || [];
    const peoplePerDay = Math.max(1, studentIds.length, Number(current?.peoplePerDay || settings.peoplePerDay));
    return {
      dayOfWeek: dayId,
      day_of_week: dayId,
      label: current?.label || dayNames.get(dayId) || "",
      enabled: true,
      peoplePerDay,
      people_per_day: peoplePerDay,
      studentIds,
      student_ids: studentIds
    };
  });

  await runQuery(
    executor,
    "UPDATE picket_settings SET weekly_schedule = $2::jsonb, updated_at = NOW() WHERE id = $1",
    [DEFAULT_SETTINGS_ID, JSON.stringify(weeklySchedule)]
  );
  return weeklySchedule;
}

async function initializePicketStudentDays() {
  const { settings, dayIds } = await getFixedPicketDayConfig(query);
  if (dayIds.length === 0) return;

  for (const item of settings.weeklySchedule) {
    if (!dayIds.includes(item.dayOfWeek)) continue;
    for (const studentId of item.studentIds) {
      await query(
        `
        INSERT INTO picket_student_days (student_id, day_id)
        SELECT s.id, $2
        FROM students s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.status = 'Aktif' AND u.is_active = TRUE
        ON CONFLICT (student_id) DO NOTHING
        `,
        [studentId, item.dayOfWeek]
      );
    }
  }

  await query(
    `
    WITH historical_frequency AS (
      SELECT psch.student_id,
             EXTRACT(DOW FROM psch.schedule_date)::smallint AS day_id,
             COUNT(*) AS occurrence_count,
             MAX(psch.schedule_date) AS latest_date
      FROM picket_schedules psch
      WHERE EXTRACT(DOW FROM psch.schedule_date)::smallint = ANY($1::smallint[])
      GROUP BY psch.student_id, EXTRACT(DOW FROM psch.schedule_date)::smallint
    ), ranked_history AS (
      SELECT frequency.*,
             ROW_NUMBER() OVER (
               PARTITION BY frequency.student_id
               ORDER BY frequency.occurrence_count DESC,
                        frequency.latest_date DESC,
                        frequency.day_id ASC
             ) AS rank_number
      FROM historical_frequency frequency
    )
    INSERT INTO picket_student_days (student_id, day_id, effective_from)
    SELECT s.id, history.day_id, CURRENT_DATE
    FROM ranked_history history
    JOIN students s ON s.id = history.student_id
    JOIN users u ON u.id = s.user_id
    WHERE history.rank_number = 1
      AND s.status = 'Aktif'
      AND u.is_active = TRUE
    ON CONFLICT (student_id) DO NOTHING
    `,
    [dayIds]
  );

  const [missingResult, countsResult] = await Promise.all([
    query(
      `
      SELECT s.id
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN picket_student_days psd ON psd.student_id = s.id
      WHERE s.status = 'Aktif' AND u.is_active = TRUE AND psd.student_id IS NULL
      ORDER BY s.id ASC
      `
    ),
    query("SELECT day_id, COUNT(*)::int AS total FROM picket_student_days GROUP BY day_id")
  ]);
  const countsByDay = new Map(countsResult.rows.map((row) => [Number(row.day_id), Number(row.total)]));

  for (const student of shuffle(missingResult.rows)) {
    const dayId = chooseLeastLoadedPicketDay(dayIds, countsByDay);
    await query(
      "INSERT INTO picket_student_days (student_id, day_id) VALUES ($1, $2) ON CONFLICT (student_id) DO NOTHING",
      [student.id, dayId]
    );
    countsByDay.set(dayId, Number(countsByDay.get(dayId) || 0) + 1);
  }

  await syncWeeklyScheduleFromFixedDays(query);
}

async function applyWeeklyScheduleToFixedDays(weeklySchedule, assignedBy, executor = query) {
  const enabledItems = weeklySchedule.filter((item) => item.enabled !== false);
  const { activeDays } = await getFixedPicketDayConfig(executor);
  const activeDayIds = new Set(activeDays.map((day) => day.id));
  const dayIds = enabledItems.map((item) => item.dayOfWeek).filter((dayId) => activeDayIds.has(dayId));
  if (dayIds.length === 0) return;

  const explicitDayByStudent = new Map();
  for (const item of enabledItems) {
    if (!dayIds.includes(item.dayOfWeek)) continue;
    for (const studentId of item.studentIds) {
      if (explicitDayByStudent.has(studentId) && explicitDayByStudent.get(studentId) !== item.dayOfWeek) {
        const error = new Error(`Mahasiswa ${studentId} tidak boleh ditempatkan pada lebih dari satu hari piket.`);
        error.statusCode = 400;
        throw error;
      }
      explicitDayByStudent.set(studentId, item.dayOfWeek);
    }
  }

  for (const [studentId, dayId] of explicitDayByStudent) {
    await runQuery(
      executor,
      `
      INSERT INTO picket_student_days (student_id, day_id, effective_from, assigned_by)
      SELECT s.id, $2, CURRENT_DATE + 1, $3
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.status = 'Aktif' AND u.is_active = TRUE
      ON CONFLICT (student_id)
      DO UPDATE SET day_id = EXCLUDED.day_id,
                    assigned_by = EXCLUDED.assigned_by,
                    effective_from = EXCLUDED.effective_from,
                    assigned_at = NOW(),
                    updated_at = NOW()
      `,
      [studentId, dayId, assignedBy]
    );
  }

  const studentsResult = await runQuery(
    executor,
    `
    SELECT s.id, psd.day_id
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_student_days psd ON psd.student_id = s.id
    WHERE s.status = 'Aktif' AND u.is_active = TRUE
    ORDER BY s.id ASC
    `
  );
  const countsByDay = new Map(dayIds.map((dayId) => [dayId, 0]));
  for (const row of studentsResult.rows) {
    const dayId = Number(row.day_id);
    if (dayIds.includes(dayId)) countsByDay.set(dayId, countsByDay.get(dayId) + 1);
  }
  for (const row of shuffle(studentsResult.rows)) {
    const currentDayId = Number(row.day_id);
    if (dayIds.includes(currentDayId)) continue;
    const dayId = chooseLeastLoadedPicketDay(dayIds, countsByDay);
    await runQuery(
      executor,
      `
      INSERT INTO picket_student_days (student_id, day_id, effective_from, assigned_by)
      VALUES ($1, $2, CURRENT_DATE + 1, $3)
      ON CONFLICT (student_id)
      DO UPDATE SET day_id = EXCLUDED.day_id,
                    assigned_by = EXCLUDED.assigned_by,
                    effective_from = EXCLUDED.effective_from,
                    assigned_at = NOW(),
                    updated_at = NOW()
      `,
      [row.id, dayId, assignedBy]
    );
    countsByDay.set(dayId, countsByDay.get(dayId) + 1);
  }
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

function isApprovedLeaveStatus(value) {
  return String(value || "").trim().toLowerCase() === "disetujui";
}

function normalizeMappedLeaveType(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function mapAssignment(row) {
  if (!row) return null;
  const date = row.date_text || row.schedule_date_text || row.schedule_date || row.date;
  const isHoliday = Boolean(row.holiday_id);
  const activeLeaveLookupAvailable = Object.prototype.hasOwnProperty.call(row, "active_leave_status");
  const activeLeaveApproved = isApprovedLeaveStatus(row.active_leave_status);
  const activeLeaveType = normalizeMappedLeaveType(row.active_leave_type);
  const activeLeaveRequestId = activeLeaveApproved ? row.active_leave_request_id || null : null;
  const storedAutoWfh =
    normalizeMappedLeaveType(row.auto_leave_type) === "wfh" && Boolean(row.auto_leave_request_id);
  const autoCompletedByWfh =
    (activeLeaveApproved && activeLeaveType === "wfh") ||
    (!activeLeaveLookupAvailable && storedAutoWfh);
  const approvedPicketLeave = isApprovedLeaveStatus(row.picket_leave_status);
  const approvedNonWfhStudentLeave = activeLeaveApproved && activeLeaveType !== "wfh";
  const approvedLeave = activeLeaveApproved || approvedPicketLeave;
  const effectiveAutoLeaveRequestId = autoCompletedByWfh
    ? activeLeaveRequestId || row.auto_leave_request_id || null
    : null;
  const effectiveAutoLeaveType = autoCompletedByWfh ? "wfh" : null;
  const leaveStatus = activeLeaveApproved
    ? row.active_leave_status
    : approvedPicketLeave
      ? row.picket_leave_status
      : null;
  const effectiveStatus = isHoliday
    ? "Libur"
    : autoCompletedByWfh
      ? "Selesai"
      : (approvedNonWfhStudentLeave || approvedPicketLeave)
        ? "Izin"
        : row.status;
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
    status: effectiveStatus,
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
    submitted: Boolean(row.submission_id) || autoCompletedByWfh,
    auto_completed_by_wfh: autoCompletedByWfh,
    autoCompletedByWfh,
    auto_leave_request_id: effectiveAutoLeaveRequestId,
    autoLeaveRequestId: effectiveAutoLeaveRequestId,
    auto_leave_type: effectiveAutoLeaveType,
    autoLeaveType: effectiveAutoLeaveType,
    leave_request_id: activeLeaveRequestId,
    leaveRequestId: activeLeaveRequestId,
    leave_type: activeLeaveType,
    leaveType: activeLeaveType,
    leave_status: leaveStatus,
    leaveStatus,
    approved_leave: approvedLeave,
    approvedLeave,
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
    source_leave_request_id: row.source_leave_request_id || null,
    sourceLeaveRequestId: row.source_leave_request_id || null,
    replacement_schedule_id: row.replacement_schedule_id || null,
    replacementScheduleId: row.replacement_schedule_id || null,
    replacement_date: row.replacement_date_text || row.replacement_date || null,
    replacementDate: row.replacement_date_text || row.replacement_date || null,
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
    if (hasWeeklySchedulePayload) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["picket-student-day-assignment"]);
    }
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

    let settings = mapSettings(result.rows[0]);
    if (hasWeeklySchedulePayload) {
      await applyWeeklyScheduleToFixedDays(
        settings.weeklySchedule,
        payload.updatedBy || payload.updated_by || null,
        client
      );
      const syncedWeeklySchedule = await syncWeeklyScheduleFromFixedDays(client);
      settings = {
        ...settings,
        weekly_schedule: syncedWeeklySchedule,
        weeklySchedule: syncedWeeklySchedule
      };
    }
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
    SELECT s.id, s.nim, s.tipe, u.name, u.initials,
           psd.day_id, TO_CHAR(psd.effective_from, 'YYYY-MM-DD') AS effective_from_text,
           pd.name AS day_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_student_days psd ON psd.student_id = s.id
    LEFT JOIN picket_days pd ON pd.id = psd.day_id
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
    tipe: row.tipe || null,
    day_id: row.day_id == null ? null : Number(row.day_id),
    dayId: row.day_id == null ? null : Number(row.day_id),
    day_name: row.day_name || null,
    dayName: row.day_name || null,
    effective_from: row.effective_from_text || null,
    effectiveFrom: row.effective_from_text || null
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

async function updatePicketScheduleStatusFromSubmission(scheduleId, submissionStatus, executor = query) {
  const normalizedStatus = String(submissionStatus || "").trim();
  let scheduleStatus = null;
  if (normalizedStatus === "Bermasalah") scheduleStatus = "Bermasalah";
  if (normalizedStatus === "Valid" || normalizedStatus === "Terkirim") scheduleStatus = "Selesai";
  if (!scheduleStatus) return;

  await runQuery(
    executor,
    `
    UPDATE picket_schedules
    SET status = $2,
        updated_at = NOW()
    WHERE id = $1
      AND status <> 'Izin'
    `,
    [scheduleId, scheduleStatus]
  );
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
  if (date) await materializePicketSchedulesForDate(date);
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
           psch.auto_leave_request_id, psch.auto_leave_type,
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
           psch.auto_leave_request_id, psch.auto_leave_type,
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

function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function chooseRandomPicketTask(activeTasks, random = Math.random) {
  if (!Array.isArray(activeTasks) || activeTasks.length === 0) return null;
  return activeTasks[Math.floor(random() * activeTasks.length)] || activeTasks[0];
}

function mapPicketStudentDay(row) {
  return {
    student_id: row.student_id,
    studentId: row.student_id,
    student_name: row.student_name || null,
    studentName: row.student_name || null,
    nim: row.nim || null,
    day_id: Number(row.day_id),
    dayId: Number(row.day_id),
    day_name: row.day_name || null,
    dayName: row.day_name || null,
    assigned_by: row.assigned_by || null,
    assignedBy: row.assigned_by || null,
    assigned_at: row.assigned_at || null,
    assignedAt: row.assigned_at || null,
    effective_from: row.effective_from_text || row.effective_from || null,
    effectiveFrom: row.effective_from_text || row.effective_from || null,
    updated_at: row.updated_at || null,
    updatedAt: row.updated_at || null
  };
}

async function getPicketStudentDay(studentId, executor = query) {
  const result = await runQuery(
    executor,
    `
    SELECT psd.*, TO_CHAR(psd.effective_from, 'YYYY-MM-DD') AS effective_from_text,
           pd.name AS day_name, s.nim, u.name AS student_name
    FROM picket_student_days psd
    JOIN picket_days pd ON pd.id = psd.day_id
    JOIN students s ON s.id = psd.student_id
    JOIN users u ON u.id = s.user_id
    WHERE psd.student_id = $1
    LIMIT 1
    `,
    [studentId]
  );
  return result.rows[0] ? mapPicketStudentDay(result.rows[0]) : null;
}

async function listPicketStudentDays() {
  await ensurePicketTables();
  const result = await query(
    `
    SELECT psd.*, TO_CHAR(psd.effective_from, 'YYYY-MM-DD') AS effective_from_text,
           pd.name AS day_name, s.nim, u.name AS student_name
    FROM picket_student_days psd
    JOIN picket_days pd ON pd.id = psd.day_id
    JOIN students s ON s.id = psd.student_id
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif' AND u.is_active = TRUE
    ORDER BY psd.day_id ASC, u.name ASC
    `
  );
  return result.rows.map(mapPicketStudentDay);
}

async function assignPicketDayForStudent({
  studentId,
  assignedBy = null,
  executor = query,
  random = Math.random
} = {}) {
  await ensurePicketTables();
  const normalizedStudentId = String(studentId || "").trim();
  const studentResult = await runQuery(
    executor,
    `
    SELECT s.id, s.status, u.is_active
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [normalizedStudentId]
  );
  const student = studentResult.rows[0];
  if (!student) {
    const error = new Error("Mahasiswa tidak ditemukan untuk penetapan hari piket.");
    error.statusCode = 404;
    throw error;
  }
  if (student.status !== "Aktif" || student.is_active !== true) return null;

  await runQuery(executor, "SELECT pg_advisory_xact_lock(hashtext($1))", ["picket-student-day-assignment"]);
  const existing = await getPicketStudentDay(normalizedStudentId, executor);
  if (existing) return existing;

  const { dayIds } = await getFixedPicketDayConfig(executor);
  if (dayIds.length === 0) {
    const error = new Error("Belum ada hari piket aktif.");
    error.statusCode = 409;
    throw error;
  }
  const countsResult = await runQuery(
    executor,
    "SELECT day_id, COUNT(*)::int AS total FROM picket_student_days GROUP BY day_id"
  );
  const countsByDay = new Map(countsResult.rows.map((row) => [Number(row.day_id), Number(row.total)]));
  const dayId = chooseLeastLoadedPicketDay(dayIds, countsByDay, random);

  await runQuery(
    executor,
    `
    INSERT INTO picket_student_days (student_id, day_id, effective_from, assigned_by)
    VALUES ($1, $2, CURRENT_DATE + 1, $3)
    ON CONFLICT (student_id) DO NOTHING
    `,
    [normalizedStudentId, dayId, assignedBy]
  );
  await syncWeeklyScheduleFromFixedDays(executor);
  return getPicketStudentDay(normalizedStudentId, executor);
}

async function setPicketStudentDay({ studentId, dayId, assignedBy = null } = {}) {
  await ensurePicketTables();
  const normalizedStudentId = await resolveStudentId(studentId);
  const normalizedDayId = Number(dayId);
  if (!normalizedStudentId || !Number.isInteger(normalizedDayId) || normalizedDayId < 0 || normalizedDayId > 6) {
    const error = new Error("studentId dan dayId (0-6) wajib valid.");
    error.statusCode = 400;
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["picket-student-day-assignment"]);
    const { dayIds } = await getFixedPicketDayConfig(client);
    if (!dayIds.includes(normalizedDayId)) {
      const error = new Error("Hari tersebut tidak aktif untuk piket.");
      error.statusCode = 400;
      throw error;
    }
    await client.query(
      `
      INSERT INTO picket_student_days (student_id, day_id, effective_from, assigned_by)
      VALUES ($1, $2, CURRENT_DATE + 1, $3)
      ON CONFLICT (student_id)
      DO UPDATE SET day_id = EXCLUDED.day_id,
                    effective_from = EXCLUDED.effective_from,
                    assigned_by = EXCLUDED.assigned_by,
                    assigned_at = NOW(),
                    updated_at = NOW()
      `,
      [normalizedStudentId, normalizedDayId, assignedBy]
    );
    await syncWeeklyScheduleFromFixedDays(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getPicketStudentDay(normalizedStudentId);
}

async function randomizePicketStudentDays({ assignedBy = null, random = Math.random } = {}) {
  await ensurePicketTables();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["picket-student-day-assignment"]);
    const { dayIds } = await getFixedPicketDayConfig(client);
    if (dayIds.length === 0) {
      const error = new Error("Belum ada hari piket aktif.");
      error.statusCode = 409;
      throw error;
    }
    const students = await client.query(
      `
      SELECT s.id
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.status = 'Aktif' AND u.is_active = TRUE
      ORDER BY s.id ASC
      `
    );
    const assignments = buildRandomizedPicketDayAssignments(
      students.rows.map((student) => student.id),
      dayIds,
      random
    );
    await client.query(
      `
      DELETE FROM picket_student_days psd
      USING students s, users u
      WHERE s.id = psd.student_id
        AND u.id = s.user_id
        AND s.status = 'Aktif'
        AND u.is_active = TRUE
      `
    );
    for (const assignment of assignments) {
      await client.query(
        "INSERT INTO picket_student_days (student_id, day_id, effective_from, assigned_by) VALUES ($1, $2, CURRENT_DATE + 1, $3)",
        [assignment.studentId, assignment.dayId, assignedBy]
      );
    }
    await syncWeeklyScheduleFromFixedDays(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return listPicketStudentDays();
}

async function fetchAssignmentsByDate(date, executor = query) {
  const result = await runQuery(
    executor,
    `
    SELECT pa.id, TO_CHAR(pa.schedule_date, 'YYYY-MM-DD') AS date_text,
           pa.schedule_date, pa.day_id, pd.name AS day_name,
           pa.student_id, pa.task_id, pa.status, pa.notes,
           pa.auto_leave_request_id, pa.auto_leave_type,
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
           ps.review_note AS submission_review_note,
           active_leave.id AS active_leave_request_id,
           active_leave.jenis_pengajuan AS active_leave_type,
           active_leave.status AS active_leave_status,
           approved_picket_leave.status AS picket_leave_status
    FROM picket_schedules pa
    JOIN picket_days pd ON pd.id = pa.day_id
    JOIN students s ON s.id = pa.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
    LEFT JOIN picket_holidays ph ON ph.holiday_date = pa.schedule_date
    LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
    LEFT JOIN LATERAL (
      SELECT lr.id, lr.jenis_pengajuan, lr.status
      FROM leave_requests lr
      WHERE lr.student_id = pa.student_id
        AND pa.schedule_date BETWEEN lr.periode_start AND lr.periode_end
        AND LOWER(BTRIM(lr.status)) = LOWER('Disetujui')
      ORDER BY
        CASE WHEN LOWER(BTRIM(lr.jenis_pengajuan)) = 'wfh' THEN 0 ELSE 1 END,
        lr.updated_at DESC,
        lr.created_at DESC,
        lr.id DESC
      LIMIT 1
    ) active_leave ON TRUE
    LEFT JOIN LATERAL (
      SELECT plr.status
      FROM picket_leave_requests plr
      WHERE (plr.schedule_id = pa.id OR plr.assignment_id = pa.id)
        AND plr.student_id = pa.student_id
        AND plr.date = pa.schedule_date
        AND LOWER(BTRIM(plr.status)) = LOWER('Disetujui')
      ORDER BY plr.updated_at DESC, plr.created_at DESC, plr.id DESC
      LIMIT 1
    ) approved_picket_leave ON TRUE
    WHERE pa.schedule_date = $1::date
    ORDER BY u.name ASC
    `,
    [date]
  );
  return result.rows.map(mapAssignment);
}

async function generatePicketSchedule({
  date,
  generatedBy = null
} = {}) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(targetDate);
  return reconcilePicketAssignmentsForDate({ date: targetDate, generatedBy });
}

async function reconcilePicketAssignmentsForDate({ date, generatedBy = null, executor = null } = {}) {
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  await ensurePicketDateIsNotHoliday(targetDate, executor || query);
  const dayOfWeek = getJakartaDayOfWeek(targetDate);
  let weeklyStudentIds = [];
  const createdIds = [];
  const updatedIds = [];
  const client = executor || await pool.connect();
  const ownsTransaction = !executor;

  try {
    if (ownsTransaction) await client.query("BEGIN");
    await runQuery(client, "SELECT pg_advisory_xact_lock(hashtext($1))", ["picket-student-day-assignment"]);
    const fixedStudents = await runQuery(
      client,
      `
      SELECT psd.student_id
      FROM picket_student_days psd
      JOIN students s ON s.id = psd.student_id
      JOIN users u ON u.id = s.user_id
      WHERE psd.day_id = $1
        AND psd.effective_from <= $2::date
        AND s.status = 'Aktif'
        AND u.is_active = TRUE
      ORDER BY psd.student_id ASC
      `,
      [dayOfWeek, targetDate]
    );
    weeklyStudentIds = fixedStudents.rows.map((row) => row.student_id);

    const removed = await runQuery(
      client,
      `
      WITH ranked AS (
        SELECT pa.id,
               pa.student_id,
               (ps.id IS NOT NULL) AS has_submission,
               (plr.id IS NOT NULL OR replacement_plr.id IS NOT NULL) AS has_leave_request,
               ROW_NUMBER() OVER (
                 PARTITION BY pa.student_id
                 ORDER BY (ps.id IS NOT NULL) DESC, pa.generated_at DESC, pa.created_at DESC, pa.id ASC
               ) AS student_rank
        FROM picket_schedules pa
        LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
        LEFT JOIN picket_leave_requests plr ON plr.schedule_id = pa.id
        LEFT JOIN picket_leave_requests replacement_plr ON replacement_plr.replacement_schedule_id = pa.id
        WHERE pa.schedule_date = $1::date
      )
      DELETE FROM picket_schedules pa
      USING ranked
      WHERE pa.id = ranked.id
        AND ranked.has_submission = FALSE
        AND ranked.has_leave_request = FALSE
        AND $3::boolean = TRUE
        AND (
          NOT (ranked.student_id = ANY($2::text[]))
          OR ranked.student_rank > 1
        )
      RETURNING pa.id, pa.student_id
      `,
      [targetDate, weeklyStudentIds, targetDate > getJakartaDateIso()]
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
      const existingId = existingByStudentId.get(studentId);

      if (existingId) {
        continue;
      }

      const task = chooseRandomPicketTask(activeTasks);
      const id = buildId("PKT-SCH");
      const result = await runQuery(
        client,
        `
        INSERT INTO picket_schedules (id, schedule_date, day_id, student_id, task_id, status, generated_by, created_by, updated_by)
        VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6, $6)
        ON CONFLICT (schedule_date, student_id) DO NOTHING
        RETURNING id
        `,
        [id, targetDate, dayOfWeek, studentId, task.id, generatedBy]
      );
      if (result.rowCount > 0) createdIds.push(result.rows[0].id);
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

async function materializePicketSchedulesForDate(date = getJakartaDateIso(), generatedBy = null) {
  await ensurePicketTables();
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const today = getJakartaDateIso();
  if (targetDate < today) {
    return { date: targetDate, assignments: [], created: [], updated: [], skipped: true, reason: "historical_date" };
  }
  const holiday = await getPicketHolidayByDate(targetDate);
  if (holiday) {
    return { date: targetDate, holiday, assignments: [], created: [], updated: [], skipped: true };
  }
  return reconcilePicketAssignmentsForDate({ date: targetDate, generatedBy });
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
  const sync = await materializePicketSchedulesForDate(targetDate);
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
    sync
  };
}

async function getPicketTodayForStudent(studentIdOrUserId, date = getJakartaDateIso()) {
  await ensurePicketTables();
  const studentId = await resolveStudentId(studentIdOrUserId);
  if (!studentId) {
    return { assignment: null, fixedDay: null, fixed_day: null, holiday: null, isHoliday: false, is_holiday: false };
  }
  const targetDate = normalizeIsoDate(date, getJakartaDateIso());
  const holiday = await getPicketHolidayByDate(targetDate);
  if (!holiday) await materializePicketSchedulesForDate(targetDate);
  const [result, fixedDay] = await Promise.all([
    query(
      `
      SELECT pa.id, TO_CHAR(pa.schedule_date, 'YYYY-MM-DD') AS date_text,
             pa.schedule_date, pa.day_id, pd.name AS day_name,
             pa.student_id, pa.task_id, pa.status, pa.notes,
             pa.auto_leave_request_id, pa.auto_leave_type,
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
             ps.review_note AS submission_review_note,
             active_leave.id AS active_leave_request_id,
             active_leave.jenis_pengajuan AS active_leave_type,
             active_leave.status AS active_leave_status,
             approved_picket_leave.status AS picket_leave_status
      FROM picket_schedules pa
      JOIN picket_days pd ON pd.id = pa.day_id
      JOIN students s ON s.id = pa.student_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN picket_tasks pt ON pt.id = pa.task_id
      LEFT JOIN picket_holidays ph ON ph.holiday_date = pa.schedule_date
      LEFT JOIN picket_submissions ps ON ps.schedule_id = pa.id
      LEFT JOIN LATERAL (
        SELECT lr.id, lr.jenis_pengajuan, lr.status
        FROM leave_requests lr
        WHERE lr.student_id = pa.student_id
          AND pa.schedule_date BETWEEN lr.periode_start AND lr.periode_end
          AND LOWER(BTRIM(lr.status)) = LOWER('Disetujui')
        ORDER BY
          CASE WHEN LOWER(BTRIM(lr.jenis_pengajuan)) = 'wfh' THEN 0 ELSE 1 END,
          lr.updated_at DESC,
          lr.created_at DESC,
          lr.id DESC
        LIMIT 1
      ) active_leave ON TRUE
      LEFT JOIN LATERAL (
        SELECT plr.status
        FROM picket_leave_requests plr
        WHERE (plr.schedule_id = pa.id OR plr.assignment_id = pa.id)
          AND plr.student_id = pa.student_id
          AND plr.date = pa.schedule_date
          AND LOWER(BTRIM(plr.status)) = LOWER('Disetujui')
        ORDER BY plr.updated_at DESC, plr.created_at DESC, plr.id DESC
        LIMIT 1
      ) approved_picket_leave ON TRUE
      WHERE pa.student_id = $1 AND pa.schedule_date = $2::date
      LIMIT 1
      `,
      [studentId, targetDate]
    ),
    getPicketStudentDay(studentId)
  ]);
  return {
    assignment: result.rows[0] ? mapAssignment(result.rows[0]) : null,
    fixed_day: fixedDay,
    fixedDay,
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
           pa.auto_leave_request_id, pa.auto_leave_type,
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
    WHERE LOWER(BTRIM(status)) = LOWER('Disetujui')
      AND ($1::text IS NULL OR schedule_id = $1 OR assignment_id = $1)
      AND ($2::text IS NULL OR student_id = $2)
      AND ($3::date IS NULL OR date = $3::date)
    LIMIT 1
    `,
    [effectiveScheduleId, studentId || null, date || null]
  );
  return result.rowCount > 0;
}

async function getLatestApprovedStudentLeaveForDate(studentId, date) {
  const result = await query(
    `
    SELECT id, jenis_pengajuan AS leave_type, status AS leave_status
    FROM leave_requests
    WHERE student_id = $1
      AND $2::date BETWEEN periode_start AND periode_end
      AND LOWER(BTRIM(status)) = LOWER('Disetujui')
    ORDER BY
      CASE WHEN LOWER(BTRIM(jenis_pengajuan)) = 'wfh' THEN 0 ELSE 1 END,
      updated_at DESC,
      created_at DESC,
      id DESC
    LIMIT 1
    `,
    [studentId, date]
  );
  if (result.rowCount === 0) return null;
  return {
    id: result.rows[0].id,
    type: normalizeMappedLeaveType(result.rows[0].leave_type),
    status: result.rows[0].leave_status
  };
}

function applyApprovedStudentLeaveToAssignment(assignment, studentLeave) {
  if (!assignment || !studentLeave || !isApprovedLeaveStatus(studentLeave.status)) return assignment;
  const leaveType = normalizeMappedLeaveType(studentLeave.type || studentLeave.leaveType || studentLeave.leave_type);
  const leaveRequestId = studentLeave.id || studentLeave.leaveRequestId || studentLeave.leave_request_id || null;
  const autoCompletedByWfh = leaveType === "wfh";

  return {
    ...assignment,
    status: autoCompletedByWfh ? "Selesai" : "Izin",
    submitted: assignment.submitted === true || autoCompletedByWfh,
    auto_completed_by_wfh: autoCompletedByWfh,
    autoCompletedByWfh,
    auto_leave_request_id: autoCompletedByWfh ? leaveRequestId : null,
    autoLeaveRequestId: autoCompletedByWfh ? leaveRequestId : null,
    auto_leave_type: autoCompletedByWfh ? "wfh" : null,
    autoLeaveType: autoCompletedByWfh ? "wfh" : null,
    leave_request_id: leaveRequestId,
    leaveRequestId,
    leave_type: leaveType,
    leaveType,
    leave_status: studentLeave.status,
    leaveStatus: studentLeave.status,
    approved_leave: true,
    approvedLeave: true
  };
}

function buildPicketCheckoutRequirement({
  assignment,
  holiday = null,
  approvedPicketLeave = false,
  approvedStudentLeave = null
} = {}) {
  const effectiveAssignment = applyApprovedStudentLeaveToAssignment(assignment, approvedStudentLeave);
  const isHoliday = Boolean(holiday || effectiveAssignment?.isHoliday || effectiveAssignment?.is_holiday);

  if (isHoliday) {
    return {
      required: false,
      assignment: effectiveAssignment || null,
      holiday,
      isHoliday: true,
      is_holiday: true,
      isExempt: true,
      is_exempt: true,
      approvedLeave: false,
      submitted: effectiveAssignment?.submitted === true
    };
  }

  if (!effectiveAssignment) {
    return { required: false, assignment: null, approvedLeave: false, submitted: false };
  }

  if (effectiveAssignment.isExempt === true || effectiveAssignment.is_exempt === true) {
    return {
      required: false,
      assignment: effectiveAssignment,
      approvedLeave: false,
      submitted: effectiveAssignment.submitted === true,
      isExempt: true,
      is_exempt: true
    };
  }

  const autoCompletedByWfh =
    effectiveAssignment.autoCompletedByWfh === true ||
    effectiveAssignment.auto_completed_by_wfh === true ||
    normalizeMappedLeaveType(effectiveAssignment.autoLeaveType || effectiveAssignment.auto_leave_type) === "wfh";

  // Piket WFH memang tidak mempunyai submissionId/photoUrl. Flag otomatis
  // harus dievaluasi lebih dulu daripada keberadaan bukti foto.
  if (autoCompletedByWfh) {
    return {
      required: false,
      assignment: effectiveAssignment,
      approvedLeave: true,
      submitted: true,
      autoCompletedByWfh: true,
      auto_completed_by_wfh: true
    };
  }

  const studentLeaveApproved = isApprovedLeaveStatus(
    approvedStudentLeave?.status || effectiveAssignment.leaveStatus || effectiveAssignment.leave_status
  );
  const approvedLeave = approvedPicketLeave === true || studentLeaveApproved || effectiveAssignment.approvedLeave === true;
  const submitted =
    effectiveAssignment.submitted === true ||
    Boolean(effectiveAssignment.submissionId || effectiveAssignment.submission_id);

  return {
    required: !approvedLeave && !submitted,
    assignment: effectiveAssignment,
    approvedLeave,
    submitted
  };
}

async function getPicketCheckoutRequirement(studentIdOrUserId, date = getJakartaDateIso()) {
  const today = await getPicketTodayForStudent(studentIdOrUserId, date);
  const assignment = today.assignment;
  if (today.isHoliday || !assignment) {
    return buildPicketCheckoutRequirement({ assignment, holiday: today.holiday });
  }

  const [approvedPicketLeave, approvedStudentLeave] = await Promise.all([
    hasApprovedPicketLeave({
      scheduleId: assignment.id,
      studentId: assignment.studentId,
      date: assignment.date
    }),
    getLatestApprovedStudentLeaveForDate(assignment.studentId, assignment.date)
  ]);

  return buildPicketCheckoutRequirement({
    assignment,
    holiday: today.holiday,
    approvedPicketLeave,
    approvedStudentLeave
  });
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
  await updatePicketScheduleStatusFromSubmission(effectiveScheduleId, submission.status);
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
  await updatePicketScheduleStatusFromSubmission(submission.scheduleId, submission.status);
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

async function findTemporaryPicketReplacementDate({ originalDate, studentId, executor = query }) {
  const baseDate = originalDate > getJakartaDateIso() ? originalDate : getJakartaDateIso();
  const endDate = addIsoDays(baseDate, 14);
  const { dayIds } = await getFixedPicketDayConfig(executor);
  if (dayIds.length === 0) {
    const error = new Error("Belum ada hari piket aktif untuk jadwal pengganti.");
    error.statusCode = 409;
    throw error;
  }
  const [studentDay, holidays, occupied] = await Promise.all([
    runQuery(
      executor,
      "SELECT day_id FROM picket_student_days WHERE student_id = $1 LIMIT 1",
      [studentId]
    ),
    runQuery(
      executor,
      `
      SELECT TO_CHAR(holiday_date, 'YYYY-MM-DD') AS date_text
      FROM picket_holidays
      WHERE holiday_date > $1::date AND holiday_date <= $2::date
      `,
      [baseDate, endDate]
    ),
    runQuery(
      executor,
      `
      SELECT TO_CHAR(schedule_date, 'YYYY-MM-DD') AS date_text
      FROM picket_schedules
      WHERE student_id = $1
        AND schedule_date > $2::date
        AND schedule_date <= $3::date
      `,
      [studentId, baseDate, endDate]
    )
  ]);
  const replacementDate = findNextPicketReplacementDate({
    afterDate: baseDate,
    activeDayIds: dayIds,
    excludedDayIds: studentDay.rowCount > 0 ? [studentDay.rows[0].day_id] : [],
    holidayDates: new Set(holidays.rows.map((row) => row.date_text)),
    occupiedDates: new Set(occupied.rows.map((row) => row.date_text)),
    maxDays: 14
  });
  if (!replacementDate) {
    const error = new Error("Tidak ditemukan hari piket pengganti dalam 14 hari ke depan.");
    error.statusCode = 409;
    throw error;
  }
  return replacementDate;
}

async function syncStudentLeaveToPicket({
  leaveRequestId,
  studentId,
  leaveType,
  status,
  startDate,
  endDate,
  reviewedBy = null
} = {}) {
  await ensurePicketTables();
  const normalizedLeaveRequestId = String(leaveRequestId || "").trim();
  const normalizedStudentId = await resolveStudentId(studentId);
  const normalizedLeaveType = normalizeStudentLeaveType(leaveType);
  const dates = expandIsoDateRange(startDate, endDate);
  const action = resolveStudentLeavePicketAction({ leaveType: normalizedLeaveType, status });

  if (!normalizedLeaveRequestId || !normalizedStudentId || !normalizedLeaveType) {
    const error = new Error("Data sinkronisasi izin mahasiswa ke piket tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (action !== "clear") {
    for (const date of dates) {
      await materializePicketSchedulesForDate(date, reviewedBy);
    }
  }

  const summary = {
    action,
    leaveRequestId: normalizedLeaveRequestId,
    leaveType: normalizedLeaveType,
    scheduledDates: [],
    picketLeaveGranted: [],
    wfhAutoCompleted: [],
    alreadyCompleted: [],
    cleared: [],
    warnings: []
  };
  let scheduleRows = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `student-leave-picket:${normalizedStudentId}`
    ]);

    const schedules = await client.query(
      `
      SELECT psch.id,
             TO_CHAR(psch.schedule_date, 'YYYY-MM-DD') AS date_text,
             psch.auto_leave_request_id,
             psch.auto_leave_type,
             EXISTS (
               SELECT 1 FROM picket_submissions psub WHERE psub.schedule_id = psch.id
             ) AS has_submission
      FROM picket_schedules psch
      WHERE psch.student_id = $1
        AND psch.schedule_date BETWEEN $2::date AND $3::date
      ORDER BY psch.schedule_date ASC
      FOR UPDATE OF psch
      `,
      [normalizedStudentId, dates[0], dates[dates.length - 1]]
    );
    // WFH/izin hanya boleh memengaruhi jadwal yang tanggalnya benar-benar
    // berada di dalam periode izin. Tanpa jadwal pada tanggal itu, tidak ada
    // status piket yang dibuat atau diselesaikan otomatis.
    scheduleRows = selectPicketSchedulesOnLeaveDates(schedules.rows, dates);
    summary.scheduledDates = scheduleRows.map((row) => row.date_text);

    if (action === "clear") {
      const automaticLeaves = await client.query(
        `
        SELECT schedule_id, replacement_schedule_id
        FROM picket_leave_requests
        WHERE source_leave_request_id = $1
        FOR UPDATE
        `,
        [normalizedLeaveRequestId]
      );
      const affectedScheduleIds = automaticLeaves.rows.map((row) => row.schedule_id);

      for (const leave of automaticLeaves.rows) {
        if (leave.replacement_schedule_id) {
          const replacementSubmission = await client.query(
            "SELECT 1 FROM picket_submissions WHERE schedule_id = $1 LIMIT 1",
            [leave.replacement_schedule_id]
          );
          if (replacementSubmission.rowCount > 0) continue;
          await client.query("DELETE FROM picket_schedules WHERE id = $1", [leave.replacement_schedule_id]);
        }
        await client.query(
          "DELETE FROM picket_leave_requests WHERE schedule_id = $1 AND source_leave_request_id = $2",
          [leave.schedule_id, normalizedLeaveRequestId]
        );
        summary.cleared.push(leave.schedule_id);
      }

      const autoCompletedSchedules = await client.query(
        "SELECT id FROM picket_schedules WHERE auto_leave_request_id = $1 FOR UPDATE",
        [normalizedLeaveRequestId]
      );
      const resetScheduleIds = [
        ...new Set([
          ...affectedScheduleIds,
          ...autoCompletedSchedules.rows.map((row) => row.id)
        ])
      ];

      for (const scheduleId of resetScheduleIds) {
        await client.query(
          `
          UPDATE picket_schedules psch
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM picket_submissions psub
                  WHERE psub.schedule_id = psch.id AND psub.status = 'Bermasalah'
                ) THEN 'Bermasalah'
                WHEN EXISTS (
                  SELECT 1 FROM picket_submissions psub WHERE psub.schedule_id = psch.id
                ) THEN 'Selesai'
                WHEN EXISTS (
                  SELECT 1 FROM picket_leave_requests plr
                  WHERE plr.schedule_id = psch.id AND plr.status = 'Disetujui'
                ) THEN 'Izin'
                ELSE 'Ditugaskan'
              END,
              auto_leave_request_id = CASE
                WHEN auto_leave_request_id = $2 THEN NULL ELSE auto_leave_request_id
              END,
              auto_leave_type = CASE
                WHEN auto_leave_request_id = $2 THEN NULL ELSE auto_leave_type
              END,
              updated_by = $3,
              updated_at = NOW()
          WHERE psch.id = $1
          `,
          [scheduleId, normalizedLeaveRequestId, reviewedBy]
        );
      }
    } else {
      for (const schedule of scheduleRows) {
        if (schedule.has_submission) {
          summary.alreadyCompleted.push(schedule.id);
          continue;
        }

        if (
          action === "leave" &&
          schedule.auto_leave_type === "wfh" &&
          schedule.auto_leave_request_id
        ) {
          summary.alreadyCompleted.push(schedule.id);
          continue;
        }

        if (action === "complete") {
          await client.query(
            `
            UPDATE picket_schedules
            SET status = 'Selesai',
                auto_leave_request_id = $2,
                auto_leave_type = 'wfh',
                updated_by = $3,
                updated_at = NOW()
            WHERE id = $1
            `,
            [schedule.id, normalizedLeaveRequestId, reviewedBy]
          );
          summary.wfhAutoCompleted.push(schedule.id);
          continue;
        }

        const reason = `Izin piket otomatis dari pengajuan ${normalizedLeaveType} mahasiswa ${normalizedLeaveRequestId}.`;
        await client.query(
          `
          INSERT INTO picket_leave_requests (
            id, schedule_id, assignment_id, student_id, date, reason, status,
            reviewed_by, reviewed_at, review_note, source_leave_request_id
          )
          VALUES ($1, $2, $2, $3, $4::date, $5, 'Disetujui', $6, NOW(), $7, $8)
          ON CONFLICT (schedule_id, student_id)
          DO UPDATE SET status = 'Disetujui',
                        reviewed_by = EXCLUDED.reviewed_by,
                        reviewed_at = NOW(),
                        review_note = EXCLUDED.review_note,
                        source_leave_request_id = CASE
                          WHEN picket_leave_requests.status = 'Disetujui'
                            THEN picket_leave_requests.source_leave_request_id
                          ELSE EXCLUDED.source_leave_request_id
                        END,
                        updated_at = NOW()
          `,
          [
            buildId("PKT-LV-AUTO"),
            schedule.id,
            normalizedStudentId,
            schedule.date_text,
            reason,
            reviewedBy,
            `Disetujui otomatis bersama pengajuan ${normalizedLeaveType} mahasiswa.`,
            normalizedLeaveRequestId
          ]
        );
        await client.query(
          `
          UPDATE picket_schedules
          SET status = 'Izin',
              auto_leave_request_id = NULL,
              auto_leave_type = NULL,
              updated_by = $2,
              updated_at = NOW()
          WHERE id = $1
          `,
          [schedule.id, reviewedBy]
        );
        summary.picketLeaveGranted.push(schedule.id);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const lockScheduleIds = [...summary.picketLeaveGranted, ...summary.wfhAutoCompleted];
  for (const scheduleId of lockScheduleIds) {
    const schedule = scheduleRows.find((item) => item.id === scheduleId);
    if (!schedule) continue;
    try {
      await Promise.all([
        deactivateAccessLocksForStudentDateReason({
          studentId: normalizedStudentId,
          date: schedule.date_text,
          reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING,
          unlockedBy: reviewedBy
        }),
        deactivateAccessLocksForStudentDateReason({
          studentId: normalizedStudentId,
          date: schedule.date_text,
          reason: ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
          unlockedBy: reviewedBy
        })
      ]);
    } catch (error) {
      summary.warnings.push({ scheduleId, step: "release_access_lock", message: error.message });
    }
  }

  if (action === "leave" && summary.picketLeaveGranted.length > 0) {
    try {
      summary.leaveReplacements = await backfillApprovedPicketLeaveReplacements();
    } catch (error) {
      summary.warnings.push({ step: "create_leave_replacement", message: error.message });
    }
  }

  return summary;
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
    SELECT plr.*, TO_CHAR(plr.date, 'YYYY-MM-DD') AS date_text,
           TO_CHAR(plr.replacement_date, 'YYYY-MM-DD') AS replacement_date_text,
           s.nim, u.name AS student_name
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

  const approvedExisting = await query(
    "SELECT 1 FROM picket_leave_requests WHERE schedule_id = $1 AND student_id = $2 AND status = 'Disetujui' LIMIT 1",
    [scheduleId, studentId]
  );
  if (approvedExisting.rowCount > 0) {
    const error = new Error("Izin piket yang sudah disetujui tidak dapat diajukan ulang.");
    error.statusCode = 409;
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
                  replacement_schedule_id = NULL,
                  replacement_date = NULL,
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
  const reviewedBy = payload.reviewedBy || payload.reviewed_by || null;
  const reviewNote = payload.reviewNote ?? payload.review_note ?? null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const leaveResult = await client.query(
      `
      SELECT plr.*, TO_CHAR(plr.date, 'YYYY-MM-DD') AS date_text,
             TO_CHAR(plr.replacement_date, 'YYYY-MM-DD') AS replacement_date_text,
             psch.task_id, psch.status AS schedule_status
      FROM picket_leave_requests plr
      JOIN picket_schedules psch ON psch.id = plr.schedule_id
      WHERE plr.id = $1
      FOR UPDATE OF plr, psch
      `,
      [id]
    );
    if (leaveResult.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const leave = leaveResult.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`picket-leave-replacement:${leave.student_id}`]);

    if (status === "Disetujui" && !leave.replacement_schedule_id) {
      const submitted = await client.query(
        "SELECT 1 FROM picket_submissions WHERE schedule_id = $1 LIMIT 1",
        [leave.schedule_id]
      );
      if (submitted.rowCount > 0) {
        const error = new Error("Izin tidak dapat disetujui karena jadwal asal sudah memiliki submission.");
        error.statusCode = 409;
        throw error;
      }

      const replacementDate = await findTemporaryPicketReplacementDate({
        originalDate: leave.date_text,
        studentId: leave.student_id,
        executor: client
      });
      const replacementScheduleId = buildId("PKT-SCH-RPL");
      await client.query(
        `
        INSERT INTO picket_schedules (
          id, schedule_date, day_id, student_id, task_id, status, notes,
          generated_by, created_by, updated_by
        )
        VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $7, $7, $7)
        `,
        [
          replacementScheduleId,
          replacementDate,
          getJakartaDayOfWeek(replacementDate),
          leave.student_id,
          leave.task_id,
          `Jadwal pengganti sementara untuk izin piket ${leave.id}.`,
          reviewedBy
        ]
      );
      leave.replacement_schedule_id = replacementScheduleId;
      leave.replacement_date_text = replacementDate;
    }

    if (status === "Disetujui") {
      await client.query(
        "UPDATE picket_schedules SET status = 'Izin', updated_by = $2, updated_at = NOW() WHERE id = $1",
        [leave.schedule_id, reviewedBy]
      );
    }

    if (status !== "Disetujui" && leave.replacement_schedule_id) {
      const replacementSubmission = await client.query(
        "SELECT 1 FROM picket_submissions WHERE schedule_id = $1 LIMIT 1",
        [leave.replacement_schedule_id]
      );
      if (replacementSubmission.rowCount > 0) {
        const error = new Error("Status izin tidak dapat dibatalkan karena jadwal pengganti sudah memiliki submission.");
        error.statusCode = 409;
        throw error;
      }
      await client.query("DELETE FROM picket_schedules WHERE id = $1", [leave.replacement_schedule_id]);
      await client.query(
        "UPDATE picket_schedules SET status = 'Ditugaskan', updated_by = $2, updated_at = NOW() WHERE id = $1 AND status = 'Izin'",
        [leave.schedule_id, reviewedBy]
      );
      leave.replacement_schedule_id = null;
      leave.replacement_date_text = null;
    }

    const result = await client.query(
      `
      UPDATE picket_leave_requests
      SET status = $2,
          reviewed_by = CASE WHEN $2 = 'Menunggu' THEN NULL ELSE $3 END,
          reviewed_at = CASE WHEN $2 = 'Menunggu' THEN NULL ELSE NOW() END,
          review_note = $4,
          replacement_schedule_id = $5,
          replacement_date = $6::date,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *, TO_CHAR(date, 'YYYY-MM-DD') AS date_text,
                   TO_CHAR(replacement_date, 'YYYY-MM-DD') AS replacement_date_text
      `,
      [
        id,
        status,
        reviewedBy,
        reviewNote,
        status === "Disetujui" ? leave.replacement_schedule_id : null,
        status === "Disetujui" ? leave.replacement_date_text : null
      ]
    );
    await client.query("COMMIT");
    return mapLeaveRequest(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function backfillApprovedPicketLeaveReplacements() {
  await ensurePicketTables();
  const today = getJakartaDateIso();
  const result = await query(
    `
    SELECT id, reviewed_by, review_note
    FROM picket_leave_requests
    WHERE status = 'Disetujui'
      AND replacement_schedule_id IS NULL
      AND date >= $1::date
    ORDER BY date ASC, created_at ASC
    `,
    [today]
  );
  const summary = { found: result.rowCount, created: 0, failed: [] };
  for (const row of result.rows) {
    try {
      const reviewed = await reviewPicketLeaveRequest(row.id, {
        status: "Disetujui",
        reviewedBy: row.reviewed_by,
        reviewNote: row.review_note
      });
      if (reviewed?.replacementScheduleId) summary.created += 1;
    } catch (error) {
      summary.failed.push({ id: row.id, message: error.message });
    }
  }
  return summary;
}

module.exports = {
  applyApprovedStudentLeaveToAssignment,
  assignPicketDayForStudent,
  backfillApprovedPicketLeaveReplacements,
  buildPicketCheckoutRequirement,
  buildRandomizedPicketDayAssignments,
  chooseLeastLoadedPicketDay,
  chooseRandomPicketTask,
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
  listPicketStudentDays,
  listPicketStudentOptions,
  listPicketTasks,
  materializePicketSchedulesForDate,
  mapPicketAssignment: mapAssignment,
  randomizePicketStudentDays,
  replacePicketManagers,
  resyncPicketSchedule,
  reviewPicketLeaveRequest,
  reviewPicketSubmission,
  setPicketStudentDay,
  syncStudentLeaveToPicket,
  updatePicketSchedule,
  updatePicketHoliday,
  updatePicketSettings,
  updatePicketTask
};
