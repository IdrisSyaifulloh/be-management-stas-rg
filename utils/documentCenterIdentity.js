const { query } = require("../db/pool");
const { isSafeId, requireSafeId } = require("./securityValidation");

const DOCUMENT_CENTER_KEY_PATTERN = /^[A-Za-z0-9:_\-.]{1,160}$/;

function requireDocumentCenterKey(value, label = "key") {
  const normalized = String(value || "").trim();

  if (!normalized || /\s/.test(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }

  if (isSafeId(normalized)) {
    return requireSafeId(normalized, label);
  }

  if (!DOCUMENT_CENTER_KEY_PATTERN.test(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }

  return normalized;
}

function buildStudentKey(legacyStudentId) {
  const safeStudentId = requireSafeId(legacyStudentId, "studentId");
  return requireDocumentCenterKey(`student:${safeStudentId}`, "studentKey");
}

async function resolveDocumentCenterStudent(authUserId) {
  const safeUserId = requireSafeId(authUserId, "userId");
  const result = await query(
    `
    SELECT s.id
    FROM students s
    WHERE s.user_id = $1
    LIMIT 1
    `,
    [safeUserId]
  );

  if (result.rowCount === 0) return null;

  const legacyStudentId = result.rows[0].id;
  return {
    legacyStudentId,
    studentKey: buildStudentKey(legacyStudentId)
  };
}

module.exports = {
  buildStudentKey,
  requireDocumentCenterKey,
  resolveDocumentCenterStudent
};
