function hasControlChars(value) {
  if (typeof value === "string") {
    return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasControlChars);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(hasControlChars);
  }
  return false;
}

function isSafeId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(String(value || ""));
}

function requireSafeId(value, label = "id") {
  if (!isSafeId(value)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }
  return String(value);
}

function parseBoundedLimit(value, defaultValue = 50, maxValue = 200) {
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    throw error;
  }
  return Math.min(parsed, maxValue);
}

function parseBoundedOffset(value, defaultValue = 0, maxValue = 10000) {
  if (value == null || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxValue) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function resolveSortColumn(value, allowedSort, defaultKey) {
  const key = String(value || defaultKey || "").trim();
  const column = allowedSort[key];
  if (!column) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    throw error;
  }
  return column;
}

function resolveSortDirection(value, defaultDirection = "ASC") {
  const normalized = String(value || defaultDirection).trim().toUpperCase();
  if (!["ASC", "DESC"].includes(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function requireEnum(value, allowedValues, label = "value") {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!allowedValues.includes(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }
  return normalized;
}

function requireIsoDate(value, label = "date") {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }
  return normalized;
}

module.exports = {
  hasControlChars,
  isSafeId,
  requireSafeId,
  parseBoundedLimit,
  parseBoundedOffset,
  resolveSortColumn,
  resolveSortDirection,
  requireEnum,
  requireIsoDate
};
