const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();

const DEFAULT_UI_STATE = {
  readNotificationIds: [],
  dismissedWarningIds: [],
  readAttendanceWarningIds: [],
  preferences: {}
};

const MAX_NOTIFICATION_IDS = 1000;
const MAX_DISMISSED_WARNING_IDS = 500;
const MAX_ATTENDANCE_WARNING_DAYS = 90;
const MAX_ATTENDANCE_WARNING_IDS_PER_DAY = 200;
const MAX_ID_LENGTH = 160;
const MAX_PREFERENCES_BYTES = 20 * 1024;

let ensureUserUiStatesTablePromise = null;

function getAuthenticatedUserId(req) {
  return String(req.authUser?.id || "").trim();
}

async function ensureUserUiStatesTable() {
  if (!ensureUserUiStatesTablePromise) {
    ensureUserUiStatesTablePromise = query(`
      CREATE TABLE IF NOT EXISTS user_ui_states (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => {
      ensureUserUiStatesTablePromise = null;
      throw error;
    });
  }

  await ensureUserUiStatesTablePromise;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdList(value, maxItems) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const normalized = [];

  for (const item of value) {
    const id = String(item || "").trim();
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;

    seen.add(id);
    normalized.push(id);

    if (normalized.length >= maxItems) break;
  }

  return normalized;
}

function mergeIdList(current, incoming, maxItems) {
  return normalizeIdList([...(current || []), ...(incoming || [])], maxItems);
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function getCutoffDateKey(daysBack) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack);
  return date.toISOString().slice(0, 10);
}

function normalizeAttendanceWarnings(value) {
  if (!Array.isArray(value)) return [];

  const byDate = new Map();

  for (const item of value) {
    if (!isPlainObject(item)) continue;

    const date = normalizeDateKey(item.date);
    if (!date) continue;

    const ids = normalizeIdList(item.ids, MAX_ATTENDANCE_WARNING_IDS_PER_DAY);
    if (ids.length === 0) continue;

    const currentIds = byDate.get(date) || [];
    byDate.set(date, mergeIdList(currentIds, ids, MAX_ATTENDANCE_WARNING_IDS_PER_DAY));
  }

  const cutoffDate = getCutoffDateKey(MAX_ATTENDANCE_WARNING_DAYS);

  return [...byDate.entries()]
    .filter(([date]) => date >= cutoffDate)
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, MAX_ATTENDANCE_WARNING_DAYS)
    .map(([date, ids]) => ({ date, ids }));
}

function mergeAttendanceWarnings(current, incoming) {
  return normalizeAttendanceWarnings([...(current || []), ...(incoming || [])]);
}

function normalizePreferences(value) {
  if (!isPlainObject(value)) return {};

  const normalized = {};

  for (const [key, preferenceValue] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || normalizedKey.length > 80) continue;

    if (
      preferenceValue == null ||
      ["string", "number", "boolean"].includes(typeof preferenceValue) ||
      Array.isArray(preferenceValue) ||
      isPlainObject(preferenceValue)
    ) {
      normalized[normalizedKey] = preferenceValue;
    }
  }

  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PREFERENCES_BYTES) {
    const error = new Error("preferences terlalu besar.");
    error.status = 413;
    throw error;
  }

  return normalized;
}

function normalizeState(value) {
  const source = isPlainObject(value) ? value : {};

  return {
    readNotificationIds: normalizeIdList(source.readNotificationIds, MAX_NOTIFICATION_IDS),
    dismissedWarningIds: normalizeIdList(source.dismissedWarningIds, MAX_DISMISSED_WARNING_IDS),
    readAttendanceWarningIds: normalizeAttendanceWarnings(source.readAttendanceWarningIds),
    preferences: normalizePreferences(source.preferences)
  };
}

function mergeState(current, patch) {
  const normalizedCurrent = normalizeState(current);
  const source = isPlainObject(patch) ? patch : {};
  const nextState = { ...normalizedCurrent };

  if (Object.prototype.hasOwnProperty.call(source, "readNotificationIds")) {
    nextState.readNotificationIds = mergeIdList(
      normalizedCurrent.readNotificationIds,
      source.readNotificationIds,
      MAX_NOTIFICATION_IDS
    );
  }

  if (Object.prototype.hasOwnProperty.call(source, "dismissedWarningIds")) {
    nextState.dismissedWarningIds = mergeIdList(
      normalizedCurrent.dismissedWarningIds,
      source.dismissedWarningIds,
      MAX_DISMISSED_WARNING_IDS
    );
  }

  if (Object.prototype.hasOwnProperty.call(source, "readAttendanceWarningIds")) {
    nextState.readAttendanceWarningIds = mergeAttendanceWarnings(
      normalizedCurrent.readAttendanceWarningIds,
      source.readAttendanceWarningIds
    );
  }

  if (Object.prototype.hasOwnProperty.call(source, "preferences")) {
    nextState.preferences = {
      ...normalizedCurrent.preferences,
      ...normalizePreferences(source.preferences)
    };
  }

  return normalizeState(nextState);
}

function mapUiStateRow(row) {
  const state = normalizeState(row?.state);

  return {
    ...state,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null
  };
}

async function fetchUiStateRow(userId) {
  const result = await query(
    `
    SELECT state, created_at, updated_at
    FROM user_ui_states
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Sesi login wajib untuk membaca UI state." });
    }
    requireSafeId(userId, "userId");

    await ensureUserUiStatesTable();
    const row = await fetchUiStateRow(userId);

    res.json(mapUiStateRow(row || { state: DEFAULT_UI_STATE }));
  })
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Sesi login wajib untuk menyimpan UI state." });
    }
    requireSafeId(userId, "userId");

    await ensureUserUiStatesTable();

    const currentRow = await fetchUiStateRow(userId);
    const nextState = mergeState(currentRow?.state || DEFAULT_UI_STATE, req.body || {});

    const result = await query(
      `
      INSERT INTO user_ui_states (user_id, state, created_at, updated_at)
      VALUES ($1, $2::jsonb, NOW(), NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
      RETURNING state, created_at, updated_at
      `,
      [userId, JSON.stringify(nextState)]
    );

    res.json(mapUiStateRow(result.rows[0]));
  })
);

module.exports = router;
