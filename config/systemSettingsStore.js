const { query } = require("../db/pool");

const DEFAULT_SETTINGS = {
  umum: {
    appName: "STAS-RG MS",
    universityName: "Telkom University",
    academicYear: "2025/2026",
    semester: "Genap",
    logoDataUrl: null
  },
  gps: {
    latitude: -6.87361,
    longitude: 107.60510,
    radius: 80,
    maxAccuracyMeters: 100,
    sampleCount: 2,
    timeoutMs: 6000
  },
  cuti: {
    maxSemesterDays: 3,
    maxMonthDays: 2,
    minAttendancePct: 80,
    period: "Genap 2025/2026"
  },
  notif: {
    events: [
      { id: "logbook_reminder", label: "Pengingat Logbook Harian", enabled: true },
      { id: "cuti_request", label: "Pengajuan Cuti Masuk", enabled: true },
      { id: "surat_request", label: "Permintaan Surat Masuk", enabled: true },
      { id: "milestone_update", label: "Update Milestone Riset", enabled: false },
      { id: "low_attendance", label: "Kehadiran Rendah (< 75%)", enabled: true },
      { id: "logbook_missing", label: "Logbook Tidak Diisi 3+ Hari", enabled: true }
    ],
    reminder: {
      firstTime: "09:00",
      secondTime: "15:00",
      deadlineTime: "23:59",
      toleranceDays: 1
    }
  },
  attendanceRules: {
    risetMinWeeklyHours: 4,
    risetTargetWeeklyHours: 6,
    magangDailyHours: 9,
    magangMinCheckoutHours: 8,
    magangWorkDays: "5",
    earlyCheckoutWarning: true,
    autoCheckoutEnabled: true,
    autoCheckoutTime: "22:00"
  }
};

let settings = { ...DEFAULT_SETTINGS };
let initialized = false;

function normalize(patch) {
  return patch && typeof patch === "object" ? patch : {};
}

function mergeSettings(current, patch) {
  const source = normalize(patch);
  return {
    ...current,
    ...source,
    umum: { ...(current.umum || {}), ...(source.umum || {}) },
    gps: { ...(current.gps || {}), ...(source.gps || {}) },
    cuti: { ...(current.cuti || {}), ...(source.cuti || {}) },
    notif: {
      ...(current.notif || {}),
      ...(source.notif || {}),
      reminder: {
        ...((current.notif || {}).reminder || {}),
        ...((source.notif || {}).reminder || {})
      },
      events: Array.isArray(source?.notif?.events)
        ? source.notif.events
        : (current.notif || {}).events || []
    },
    attendanceRules: {
      ...(current.attendanceRules || {}),
      ...(source.attendanceRules || {})
    }
  };
}

async function ensureTable() {
  await query(
    `
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    `
  );
}

async function loadSettings() {
  if (initialized) return settings;

  await ensureTable();
  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'system' LIMIT 1"
  );

  if (result.rowCount === 0) {
    settings = { ...DEFAULT_SETTINGS };
    await query(
      `
      INSERT INTO app_settings (setting_key, setting_value)
      VALUES ('system', $1::jsonb)
      ON CONFLICT (setting_key) DO NOTHING
      `,
      [JSON.stringify(settings)]
    );
  } else {
    settings = mergeSettings(DEFAULT_SETTINGS, result.rows[0].setting_value);
  }

  initialized = true;
  return settings;
}

function getSettings() {
  return settings;
}

async function getSettingsAsync() {
  return loadSettings();
}

async function updateSettings(patch) {
  const current = await loadSettings();
  settings = mergeSettings(current, patch);

  await query(
    `
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES ('system', $1::jsonb, NOW())
    ON CONFLICT (setting_key)
    DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `,
    [JSON.stringify(settings)]
  );

  return settings;
}

module.exports = {
  getSettings,
  getSettingsAsync,
  DEFAULT_SETTINGS,
  updateSettings
};
