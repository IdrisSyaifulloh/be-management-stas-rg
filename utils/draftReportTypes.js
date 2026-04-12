const crypto = require("crypto");
const { query } = require("../db/pool");

const SETTING_KEY = "draft_report_types";
const DEFAULT_DRAFT_REPORT_TYPES = [
  { id: "DRT-001", label: "Laporan TA", is_active: true, sort_order: 1 },
  { id: "DRT-002", label: "Jurnal", is_active: true, sort_order: 2 },
  { id: "DRT-003", label: "Laporan Kemajuan", is_active: true, sort_order: 3 }
];

let appSettingsTableReady = false;

async function ensureAppSettingsTable() {
  if (appSettingsTableReady) return;

  await query(
    `
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    `
  );

  appSettingsTableReady = true;
}

function normalizeDraftReportType(item, fallbackIndex) {
  const label = String(item?.label || "").trim();
  if (!label) return null;

  const numericSortOrder = Number(item?.sort_order);

  return {
    id: String(item?.id || `DRT-${crypto.randomUUID().slice(0, 8)}`).trim(),
    label,
    is_active: item?.is_active !== false,
    sort_order: Number.isFinite(numericSortOrder) ? numericSortOrder : fallbackIndex + 1
  };
}

function sortDraftReportTypes(items) {
  return [...items].sort((left, right) => {
    if (left.sort_order !== right.sort_order) {
      return left.sort_order - right.sort_order;
    }
    return left.label.localeCompare(right.label, "id");
  });
}

async function getDraftReportTypes(options = {}) {
  const { activeOnly = false } = options;
  await ensureAppSettingsTable();

  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key = $1 LIMIT 1",
    [SETTING_KEY]
  );

  const sourceItems =
    result.rowCount > 0 && Array.isArray(result.rows[0].setting_value?.items)
      ? result.rows[0].setting_value.items
      : DEFAULT_DRAFT_REPORT_TYPES;

  const normalizedItems = sortDraftReportTypes(
    sourceItems
      .map((item, index) => normalizeDraftReportType(item, index))
      .filter(Boolean)
  );

  return activeOnly
    ? normalizedItems.filter((item) => item.is_active)
    : normalizedItems;
}

async function saveDraftReportTypes(items) {
  await ensureAppSettingsTable();

  const sanitizedItems = sortDraftReportTypes(
    (items || [])
      .map((item, index) => normalizeDraftReportType(item, index))
      .filter(Boolean)
  );

  await query(
    `
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (setting_key)
    DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
    `,
    [SETTING_KEY, JSON.stringify({ items: sanitizedItems })]
  );

  return sanitizedItems;
}

async function getDraftReportTypeLabels(options = {}) {
  const items = await getDraftReportTypes(options);
  return items.map((item) => item.label);
}

module.exports = {
  DEFAULT_DRAFT_REPORT_TYPES,
  ensureAppSettingsTable,
  getDraftReportTypes,
  getDraftReportTypeLabels,
  saveDraftReportTypes
};
