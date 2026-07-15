const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");

function httpError(statusCode, message, field = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  return error;
}

function requirePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Input tidak valid.", "body");
  }
}

function parseReason(value) {
  if (typeof value !== "string") throw httpError(400, "Input tidak valid.", "reason");
  const normalized = value.trim();
  if (!normalized || normalized.length > 2000 || /[\x00-\x1F\x7F]/.test(normalized)) {
    throw httpError(400, "Input tidak valid.", "reason");
  }
  return normalized;
}

function parseIsoDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, "Input tidak valid.", field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw httpError(400, "Input tidak valid.", field);
  }
  return value;
}

function parseBody(body) {
  requirePlainObject(body);
  const allowed = new Set(["reason", "effectiveDate"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw httpError(400, "Input tidak valid.", key);
  }
  return {
    reason: parseReason(body.reason),
    effectiveDate: parseIsoDate(body.effectiveDate, "effectiveDate")
  };
}

async function insertAudit(client, { authUser, ip, event, target, detail }) {
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
     VALUES ($1, $2, 'Operator', 'Update', $3, $4, $5::jsonb)`,
    [
      `AUD-DC-${crypto.randomUUID()}`,
      requireSafeId(authUser?.id, "userId"),
      target,
      ip || null,
      JSON.stringify({ module: "document_center", event, ...detail })
    ]
  );
}

async function lockOfficialDocument(client, documentId) {
  return client.query(
    `
    SELECT od.id, od.status, od.document_number, od.issued_at,
           od.current_version_number, od.revoked_at,
           dd.id AS definition_id, dd.document_purpose, dd.type_code, dd.type_name
    FROM dc_official_documents od
    JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
    WHERE od.id = $1
    FOR UPDATE OF od
    `,
    [documentId]
  );
}

async function lockFinalActivityLink(client, documentId) {
  const completion = await client.query(
    `SELECT * FROM dc_final_activity_cases WHERE completion_document_id = $1 FOR UPDATE`,
    [documentId]
  );
  const certificate = await client.query(
    `SELECT * FROM dc_final_activity_case_projects WHERE certificate_document_id = $1 FOR UPDATE`,
    [documentId]
  );
  if (completion.rowCount && certificate.rowCount) {
    throw httpError(409, "Relasi dokumen final activity tidak konsisten.");
  }
  if (completion.rowCount) {
    return { kind: "completion", row: completion.rows[0] };
  }
  if (certificate.rowCount) {
    return { kind: "certificate", row: certificate.rows[0] };
  }
  throw httpError(409, "Dokumen bukan dokumen final activity.");
}

async function revokeDocument({ documentId, authUser, ip, body }) {
  const safeDocumentId = requireSafeId(documentId, "documentId");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  const parsed = parseBody(body);
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const locked = await lockOfficialDocument(client, safeDocumentId);
    if (locked.rowCount === 0) throw httpError(404, "Dokumen tidak ditemukan.");
    const document = locked.rows[0];

    if (document.status === "dicabut") throw httpError(409, "Dokumen sudah dicabut.");
    if (!["terbit", "diarsipkan"].includes(document.status)) {
      throw httpError(409, "Dokumen belum dapat dicabut.");
    }
    if (!document.document_number) throw httpError(409, "Dokumen belum memiliki nomor resmi.");

    const dateCheck = await client.query(
      `SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today,
              TO_CHAR($1::date, 'YYYY-MM-DD') AS effective_date,
              TO_CHAR($2::timestamptz::date, 'YYYY-MM-DD') AS issued_date`,
      [parsed.effectiveDate, document.issued_at]
    );
    const { today, effective_date: effectiveDate, issued_date: issuedDate } = dateCheck.rows[0];
    if (String(effectiveDate) > String(today)) {
      throw httpError(400, "Input tidak valid.", "effectiveDate");
    }
    if (issuedDate && String(effectiveDate) < String(issuedDate)) {
      throw httpError(400, "Input tidak valid.", "effectiveDate");
    }

    const link = await lockFinalActivityLink(client, safeDocumentId);
    if (link.kind === "completion" && link.row.case_status !== "issued") {
      throw httpError(409, "Status case final activity tidak dapat dicabut.");
    }
    if (link.kind === "certificate" && link.row.certificate_status !== "issued") {
      throw httpError(409, "Status sertifikat final activity tidak dapat dicabut.");
    }

    const revokedBySnapshot = {
      userId: operatorUserId,
      role: "operator"
    };

    const updated = await client.query(
      `
      UPDATE dc_official_documents
      SET status = 'dicabut',
          revoked_at = NOW(),
          revocation_effective_date = $2::date,
          revocation_reason = $3,
          revoked_by_snapshot = $4::jsonb,
          updated_at = NOW()
      WHERE id = $1
        AND status IN ('terbit', 'diarsipkan')
      RETURNING id, status, document_number, issued_at, revoked_at,
                revocation_effective_date, current_version_number
      `,
      [safeDocumentId, parsed.effectiveDate, parsed.reason, JSON.stringify(revokedBySnapshot)]
    );
    if (!updated.rowCount) throw httpError(409, "Dokumen tidak dapat dicabut.");

    if (link.kind === "completion") {
      const caseUpdate = await client.query(
        `UPDATE dc_final_activity_cases
         SET case_status = 'revoked', updated_at = NOW()
         WHERE id = $1 AND case_status = 'issued'
         RETURNING id`,
        [link.row.id]
      );
      if (!caseUpdate.rowCount) throw httpError(409, "Status case final activity berubah.");
    } else {
      const projectUpdate = await client.query(
        `UPDATE dc_final_activity_case_projects
         SET certificate_status = 'revoked', updated_at = NOW()
         WHERE id = $1 AND certificate_status = 'issued'
         RETURNING id`,
        [link.row.id]
      );
      if (!projectUpdate.rowCount) throw httpError(409, "Status sertifikat final activity berubah.");
    }

    await insertAudit(client, {
      authUser,
      ip,
      event: "document_revoked",
      target: "document_center_document",
      detail: {
        documentId: safeDocumentId,
        documentNumber: document.document_number,
        reason: parsed.reason,
        effectiveDate: parsed.effectiveDate,
        finalActivityKind: link.kind
      }
    });

    await insertAudit(client, {
      authUser,
      ip,
      event: link.kind === "completion" ? "final_activity_completion_revoked" : "final_activity_certificate_revoked",
      target: "document_center_final_activity",
      detail: link.kind === "completion"
        ? { caseId: link.row.id, documentId: safeDocumentId, reason: parsed.reason, effectiveDate: parsed.effectiveDate }
        : { caseProjectId: link.row.id, caseId: link.row.final_activity_case_id, documentId: safeDocumentId, reason: parsed.reason, effectiveDate: parsed.effectiveDate }
    });

    await client.query("COMMIT");
    transactionStarted = false;
    const row = updated.rows[0];
    return {
      id: row.id,
      status: row.status,
      documentNumber: row.document_number,
      issuedAt: row.issued_at,
      revokedAt: row.revoked_at,
      revocationEffectiveDate: row.revocation_effective_date,
      currentVersionNumber: row.current_version_number,
      canDownload: Number(row.current_version_number) > 0
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  revokeDocument
};
