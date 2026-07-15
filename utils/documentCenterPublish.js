const crypto = require("crypto");
const fs = require("fs/promises");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
const { openPrivateDocumentVersion, STAGING_ROOT, buildStagingFilePath, buildVersionStorageKey, buildVersionFilePath, getVersionDirectory } = require("./documentCenterStorage");
const { loadRequest, validateRequestDocumentContext, insertAudit } = require("./documentCenterOperatorRequests");
const { markIssuedForPublishedDocument } = require("./documentCenterFinalActivity");
const { renderPublishedCertificateVersion } = require("./documentCenterCertificateTemplates");
const { renderPublishedCompletionLetterVersion } = require("./documentCenterCompletionLetterTemplates");

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

function parseBulkPublishBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "documentIds")) {
    throw createHttpError(400, "Input tidak valid.");
  }
  if (!Array.isArray(body.documentIds) || body.documentIds.length < 1 || body.documentIds.length > 100) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const documentIds = body.documentIds.map((value) => requireSafeId(value, "documentIds"));
  if (new Set(documentIds).size !== documentIds.length) {
    throw createHttpError(400, "Input tidak valid.");
  }
  return documentIds;
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
           od.issue_batch_id,
           od.current_version_number, od.snapshot_data,
           dd.id AS definition_id, dd.type_code, dd.is_active AS definition_active,
           dv.id AS version_id, dv.storage_key, dv.mime_type, dv.file_size,
           dv.original_filename, dv.download_filename, dv.template_version_id,
           dv.signer_snapshot, dv.snapshot_data AS version_snapshot_data,
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

async function createIssueBatch(client, { typeCode, publishTime, operatorUserId }) {
  const sequence = await allocateSequence(client, typeCode, publishTime.sequence_year);
  const romanMonth = ROMAN_MONTHS[publishTime.sequence_month - 1];
  if (!romanMonth) throw createHttpError(409, "Waktu penerbitan tidak valid.");
  const documentNumber = `${typeCode}.${String(sequence).padStart(3, "0")}/STASRG/${romanMonth}/${publishTime.sequence_year}`;
  const id = `DCBATCH-${crypto.randomUUID()}`;
  await client.query(
    `
    INSERT INTO dc_issue_batches (
      id, type_code, sequence_year, sequence_month, sequence_number,
      document_number, issued_at, issued_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      id,
      typeCode,
      publishTime.sequence_year,
      publishTime.sequence_month,
      sequence,
      documentNumber,
      publishTime.issued_at,
      operatorUserId
    ]
  );
  return { id, typeCode, sequence, documentNumber, issuedAt: publishTime.issued_at };
}

async function validateLockedDocumentForPublish(client, safeDocumentId, document) {
  if (!Number.isInteger(document.current_version_number) || document.current_version_number < 1 || !document.version_id) {
    throw unavailableFileError();
  }
  const linkedId = await client.query(`SELECT id FROM dc_document_requests WHERE official_document_id = $1 LIMIT 1`, [safeDocumentId]);
  let linkedRequest = null;
  if (linkedId.rowCount) {
    linkedRequest = await loadRequest(client, linkedId.rows[0].id, true);
    await validateRequestDocumentContext(client, linkedRequest, document, true);
  }
  if (document.issue_batch_id) {
    throw createHttpError(409, "Dokumen sudah masuk batch penerbitan.");
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

  return linkedRequest;
}

async function publishPreparedDocument({
  client,
  document,
  safeDocumentId,
  linkedRequest,
  operatorUserId,
  ip,
  issueBatch
}) {
  const generatedFiles = [];
  const generatedFinal = await renderPublishedCompletionLetterVersion({
    client,
    document,
    documentNumber: issueBatch.documentNumber,
    issuedAt: issueBatch.issuedAt
  }) || await renderPublishedCertificateVersion({
    client,
    document,
    documentNumber: issueBatch.documentNumber,
    issuedAt: issueBatch.issuedAt
  });

  let nextVersionNumber = document.current_version_number;
  if (generatedFinal) {
    nextVersionNumber = document.current_version_number + 1;
    const stagingPath = buildStagingFilePath(`${crypto.randomUUID()}.pdf`);
    const finalStorageKey = buildVersionStorageKey(safeDocumentId, nextVersionNumber);
    const finalPath = buildVersionFilePath(safeDocumentId, nextVersionNumber);
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, generatedFinal.pdfBuffer, { flag: "wx" });
    generatedFiles.push({ stagingPath, finalPath, documentId: safeDocumentId });
    await client.query(
      `
      INSERT INTO dc_document_versions (
        id, document_id, version_number, storage_key, original_filename,
        download_filename, mime_type, file_size, checksum_sha256,
        signer_snapshot, snapshot_data, version_reason, template_version_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9::jsonb,$10::jsonb,'publish_final',$11)
      `,
      [
        `DCVER-${crypto.randomUUID()}`,
        safeDocumentId,
        nextVersionNumber,
        finalStorageKey,
        document.original_filename || `${safeDocumentId}-final.pdf`,
        `${safeDocumentId}-v${nextVersionNumber}.pdf`,
        generatedFinal.pdfBuffer.length,
        crypto.createHash("sha256").update(generatedFinal.pdfBuffer).digest("hex"),
        JSON.stringify(generatedFinal.signer),
        JSON.stringify(generatedFinal.snapshotData),
        generatedFinal.templateVersionId
      ]
    );
  }

  const updated = await client.query(
    `
    UPDATE dc_official_documents
    SET status = 'terbit',
        document_number = $2,
        issued_at = $3,
        issued_by_user_id = $4,
        current_version_number = $5,
        issue_batch_id = $6,
        updated_at = NOW()
    WHERE id = $1
      AND status = 'draft'
      AND document_number IS NULL
      AND issued_at IS NULL
      AND issued_by_user_id IS NULL
      AND issue_batch_id IS NULL
    RETURNING id, status, document_number, issued_at, current_version_number, issue_batch_id
    `,
    [safeDocumentId, issueBatch.documentNumber, issueBatch.issuedAt, operatorUserId, nextVersionNumber, issueBatch.id]
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
        documentNumber: issueBatch.documentNumber,
        issueBatchId: issueBatch.id,
        definitionId: document.definition_id,
        versionNumber: nextVersionNumber,
        generatedFinal: Boolean(generatedFinal)
      })
    ]
  );

  if (generatedFinal) {
    await client.query(
      `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
       VALUES ($1, $2, 'Operator', 'Create', 'document_center_document', $3, $4::jsonb)`,
      [
        `AUD-DC-${crypto.randomUUID()}`,
        operatorUserId,
        ip || null,
        JSON.stringify({
          module: "document_center",
          event: generatedFinal.auditEvent || "final_activity_certificate_generated_final",
          documentId: safeDocumentId,
          documentNumber: issueBatch.documentNumber,
          issueBatchId: issueBatch.id,
          versionNumber: nextVersionNumber,
          templateVersionId: generatedFinal.templateVersionId
        })
      ]
    );
  }

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

  return { row: updated.rows[0], generatedFiles };
}

async function publishDocumentsInIssueBatches({ documentIds, authUser, ip }) {
  const safeDocumentIds = [...new Set(documentIds.map((id) => requireSafeId(id, "documentIds")))].sort();
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  let client;
  let transactionStarted = false;
  const generatedFiles = [];
  const movedFiles = [];

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const prepared = [];
    for (const safeDocumentId of safeDocumentIds) {
      const locked = await lockPublishDocument(client, safeDocumentId);
      if (locked.rowCount === 0) throw createHttpError(404, "Dokumen tidak ditemukan.");
      const document = locked.rows[0];
      const linkedRequest = await validateLockedDocumentForPublish(client, safeDocumentId, document);
      prepared.push({ safeDocumentId, document, linkedRequest });
    }

    const publishTime = await getPublishTimestamp(client);
    const batchesByTypeCode = new Map();
    for (const item of prepared) {
      if (!batchesByTypeCode.has(item.document.type_code)) {
        batchesByTypeCode.set(
          item.document.type_code,
          await createIssueBatch(client, {
            typeCode: item.document.type_code,
            publishTime,
            operatorUserId
          })
        );
      }
    }

    const results = [];
    for (const item of prepared) {
      const issueBatch = batchesByTypeCode.get(item.document.type_code);
      const published = await publishPreparedDocument({
        client,
        document: item.document,
        safeDocumentId: item.safeDocumentId,
        linkedRequest: item.linkedRequest,
        operatorUserId,
        ip,
        issueBatch
      });
      generatedFiles.push(...published.generatedFiles);
      results.push({
        id: published.row.id,
        status: published.row.status,
        documentNumber: published.row.document_number,
        issuedAt: published.row.issued_at,
        currentVersionNumber: published.row.current_version_number,
        issueBatchId: published.row.issue_batch_id,
        canDownload: true
      });
    }

    for (const file of generatedFiles) {
      await fs.mkdir(getVersionDirectory(file.documentId), { recursive: true });
      await fs.rename(file.stagingPath, file.finalPath);
      movedFiles.push(file);
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return {
      items: results,
      batches: [...batchesByTypeCode.values()].map((batch) => ({
        id: batch.id,
        typeCode: batch.typeCode,
        sequence: batch.sequence,
        documentNumber: batch.documentNumber,
        issuedAt: batch.issuedAt
      }))
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    for (const file of movedFiles) await fs.unlink(file.finalPath).catch(() => {});
    for (const file of generatedFiles) await fs.unlink(file.stagingPath).catch(() => {});
    if (error?.code === "23505") {
      throw createHttpError(409, "Nomor dokumen tidak dapat dialokasikan.");
    }
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function publishDocument({ documentId, authUser, ip, body }) {
  ensureEmptyPublishBody(body);
  const result = await publishDocumentsInIssueBatches({ documentIds: [documentId], authUser, ip });
  return result.items[0];
}

async function publishDocumentBatch({ authUser, ip, body }) {
  const documentIds = parseBulkPublishBody(body);
  return publishDocumentsInIssueBatches({ documentIds, authUser, ip });
}

module.exports = {
  publishDocument,
  publishDocumentBatch
};
