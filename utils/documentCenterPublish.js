const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
const { openPrivateDocumentVersion } = require("./documentCenterStorage");
const { loadRequest, validateRequestDocumentContext, insertAudit } = require("./documentCenterOperatorRequests");
const { markIssuedForPublishedDocument } = require("./documentCenterFinalActivity");

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function unavailableFileError() {
  return createHttpError(410, "File dokumen tidak tersedia.");
}

function ensureEmptyPublishBody(body) {
  if (body == null) return;
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
    throw createHttpError(400, "Input tidak valid.");
  }
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function assertPublishEligibility(document, allowInactiveDefinition = false) {
  if (
    document.status !== "draft" ||
    document.document_number !== null ||
    document.issued_at !== null ||
    document.issued_by_user_id !== null ||
    !document.definition_id ||
    (!document.definition_active && !allowInactiveDefinition) ||
    !/^[0-9]{2}$/.test(document.type_code || "") ||
    !Number.isInteger(document.current_version_number) ||
    document.current_version_number < 1 ||
    !document.version_id ||
    !isNonEmptyObject(document.version_snapshot_data) ||
    Number(document.participant_count) < 1
  ) {
    throw createHttpError(409, "Dokumen belum memenuhi syarat untuk diterbitkan.");
  }
}

async function lockPublishDocument(client, documentId) {
  return client.query(
    `
    SELECT od.id, od.status, od.document_number, od.issued_at, od.issued_by_user_id,
           od.current_version_number, od.snapshot_data,
           dd.id AS definition_id, dd.type_code, dd.is_active AS definition_active,
           dv.id AS version_id, dv.storage_key, dv.mime_type, dv.file_size,
           dv.snapshot_data AS version_snapshot_data,
           (
             SELECT COUNT(*)::int
             FROM dc_official_document_students ods
             WHERE ods.document_id = od.id
           ) AS participant_count
    FROM dc_official_documents od
    LEFT JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
    LEFT JOIN dc_document_versions dv
      ON dv.document_id = od.id
     AND dv.version_number = od.current_version_number
    WHERE od.id = $1
    FOR UPDATE OF od
    `,
    [documentId]
  );
}

async function getPublishTimestamp(client) {
  const result = await client.query(
    `
    SELECT NOW() AS issued_at,
           EXTRACT(YEAR FROM NOW())::int AS sequence_year,
           EXTRACT(MONTH FROM NOW())::int AS sequence_month
    `
  );
  return result.rows[0];
}

async function allocateSequence(client, typeCode, sequenceYear) {
  const result = await client.query(
    `
    INSERT INTO dc_number_sequences (
      type_code,
      sequence_year,
      last_sequence,
      updated_at
    )
    VALUES ($1, $2, 1, NOW())
    ON CONFLICT (type_code, sequence_year)
    DO UPDATE
    SET
      last_sequence = dc_number_sequences.last_sequence + 1,
      updated_at = NOW()
    WHERE dc_number_sequences.last_sequence < 999
    RETURNING last_sequence
    `,
    [typeCode, sequenceYear]
  );
  if (result.rowCount === 0) {
    throw createHttpError(409, "Nomor dokumen untuk tahun ini telah mencapai batas maksimum.");
  }
  return Number(result.rows[0].last_sequence);
}

async function publishDocument({ documentId, authUser, ip, body }) {
  ensureEmptyPublishBody(body);
  const safeDocumentId = requireSafeId(documentId, "documentId");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const locked = await lockPublishDocument(client, safeDocumentId);
    if (locked.rowCount === 0) throw createHttpError(404, "Dokumen tidak ditemukan.");
    const document = locked.rows[0];
    if (!Number.isInteger(document.current_version_number) || document.current_version_number < 1 || !document.version_id) {
      throw unavailableFileError();
    }
    const linkedId = await client.query(`SELECT id FROM dc_document_requests WHERE official_document_id = $1 LIMIT 1`, [safeDocumentId]);
    let linkedRequest = null;
    if (linkedId.rowCount) {
      linkedRequest = await loadRequest(client, linkedId.rows[0].id, true);
      await validateRequestDocumentContext(client, linkedRequest, document, true);
    }
    assertPublishEligibility(document, Boolean(linkedRequest));

    let openedFile;
    try {
      openedFile = await openPrivateDocumentVersion({
        storageKey: document.storage_key,
        mimeType: document.mime_type,
        fileSize: document.file_size
      });
    } catch (error) {
      if (error?.code === "DOCUMENT_FILE_UNAVAILABLE") throw unavailableFileError();
      throw error;
    } finally {
      await openedFile?.handle.close().catch(() => {});
    }

    const publishTime = await getPublishTimestamp(client);
    const sequence = await allocateSequence(client, document.type_code, publishTime.sequence_year);
    const romanMonth = ROMAN_MONTHS[publishTime.sequence_month - 1];
    if (!romanMonth) throw createHttpError(409, "Waktu penerbitan tidak valid.");
    const documentNumber = `${document.type_code}.${String(sequence).padStart(3, "0")}/STASRG/${romanMonth}/${publishTime.sequence_year}`;

    const updated = await client.query(
      `
      UPDATE dc_official_documents
      SET status = 'terbit',
          document_number = $2,
          issued_at = $3,
          issued_by_user_id = $4,
          updated_at = NOW()
      WHERE id = $1
        AND status = 'draft'
        AND document_number IS NULL
        AND issued_at IS NULL
        AND issued_by_user_id IS NULL
      RETURNING id, status, document_number, issued_at, current_version_number
      `,
      [safeDocumentId, documentNumber, publishTime.issued_at, operatorUserId]
    );
    if (updated.rowCount === 0) {
      throw createHttpError(409, "Dokumen belum memenuhi syarat untuk diterbitkan.");
    }

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, 'Operator', 'Update', 'document_center_document', $3, $4::jsonb)
      `,
      [
        `AUD-DC-${crypto.randomUUID()}`,
        operatorUserId,
        ip || null,
        JSON.stringify({
          module: "document_center",
          event: "document_published",
          documentId: safeDocumentId,
          documentNumber,
          definitionId: document.definition_id,
          versionNumber: document.current_version_number
        })
      ]
    );

    if (linkedRequest) {
      const completed = await client.query(
        `UPDATE dc_document_requests
         SET status='completed', completed_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status='approved' AND official_document_id=$2
         RETURNING id`,
        [linkedRequest.id, safeDocumentId]
      );
      if (!completed.rowCount) throw createHttpError(409, "Permintaan tidak konsisten.");
      await insertAudit(client, {
        authUser: { id: operatorUserId }, request: linkedRequest,
        event: "document_request_completed", action: "Update",
        previousStatus: "approved", newStatus: "completed", officialDocumentId: safeDocumentId
      });
    }

    await markIssuedForPublishedDocument(client, {
      documentId: safeDocumentId,
      authUser: { id: operatorUserId },
      ip
    });

    await client.query("COMMIT");
    transactionStarted = false;
    const row = updated.rows[0];
    return {
      id: row.id,
      status: row.status,
      documentNumber: row.document_number,
      issuedAt: row.issued_at,
      currentVersionNumber: row.current_version_number,
      canDownload: true
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505") {
      throw createHttpError(409, "Nomor dokumen tidak dapat dialokasikan.");
    }
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  publishDocument
};
