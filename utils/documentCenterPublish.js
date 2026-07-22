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
  if (keys.some((key) => !["documentIds", "issueBatchIdsByTypeCode"].includes(key))) {
    throw createHttpError(400, "Input tidak valid.");
  }
  if (!Array.isArray(body.documentIds) || body.documentIds.length < 1 || body.documentIds.length > 100) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const documentIds = body.documentIds.map((value) => requireSafeId(value, "documentIds"));
  if (new Set(documentIds).size !== documentIds.length) {
    throw createHttpError(400, "Input tidak valid.");
  }

  const issueBatchIdsByTypeCode = {};
  if (body.issueBatchIdsByTypeCode != null) {
    if (!body.issueBatchIdsByTypeCode || typeof body.issueBatchIdsByTypeCode !== "object" || Array.isArray(body.issueBatchIdsByTypeCode)) {
      throw createHttpError(400, "Input tidak valid.");
    }
    for (const [typeCode, issueBatchId] of Object.entries(body.issueBatchIdsByTypeCode)) {
      if (!/^[0-9]{2}$/.test(typeCode)) {
        throw createHttpError(400, "Input tidak valid.");
      }
      issueBatchIdsByTypeCode[typeCode] = requireSafeId(issueBatchId, "issueBatchId");
    }
  }

  return { documentIds, issueBatchIdsByTypeCode };
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

async function findReleasedUnusedIssueBatch(client, { typeCode, publishTime }) {
  const result = await client.query(
    `
    SELECT
      b.id,
      b.type_code,
      b.sequence_number,
      b.document_number,
      b.issued_at
    FROM dc_issue_batches b
    JOIN LATERAL (
      SELECT al.target
      FROM audit_logs al
      WHERE al.target IN ('document_center_number_reserved', 'document_center_number_released')
        AND al.detail->>'issueBatchId' = b.id
      ORDER BY al.logged_at DESC, al.id DESC
      LIMIT 1
    ) latest_event ON TRUE
    WHERE b.type_code = $1
      AND b.sequence_year = $2
      AND b.sequence_month = $3
      AND latest_event.target = 'document_center_number_released'
      AND NOT EXISTS (
        SELECT 1
        FROM dc_official_documents od
        WHERE od.issue_batch_id = b.id
      )
    ORDER BY b.sequence_number ASC
    FOR UPDATE OF b SKIP LOCKED
    LIMIT 1
    `,
    [typeCode, publishTime.sequence_year, publishTime.sequence_month]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    typeCode: row.type_code,
    sequence: Number(row.sequence_number),
    documentNumber: row.document_number,
    issuedAt: row.issued_at,
    recycled: true
  };
}

function parseReserveNumberBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => !["documentDefinitionId", "note"].includes(key))) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const documentDefinitionId = requireSafeId(body.documentDefinitionId, "documentDefinitionId");
  const note = body.note == null ? null : String(body.note).trim();
  if (note && note.length > 500) {
    throw createHttpError(400, "Catatan maksimal 500 karakter.");
  }
  return { documentDefinitionId, note: note || null };
}

async function reserveDocumentCenterNumber({ authUser, body }) {
  const { documentDefinitionId, note } = parseReserveNumberBody(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const definitionResult = await client.query(
      `
      SELECT id, type_code, type_name, name, document_purpose, request_mode, is_active
      FROM dc_document_definitions
      WHERE id = $1
      LIMIT 1
      `,
      [documentDefinitionId]
    );
    const definition = definitionResult.rows[0];
    if (!definition || !/^[0-9]{2}$/.test(definition.type_code || "")) {
      throw createHttpError(404, "Jenis dokumen tidak ditemukan.");
    }

    const publishTime = await getPublishTimestamp(client);
    const batch =
      (await findReleasedUnusedIssueBatch(client, {
        typeCode: definition.type_code,
        publishTime
      })) ||
      (await createIssueBatch(client, {
        typeCode: definition.type_code,
        publishTime,
        operatorUserId: authUser.id
      }));

    await client.query(
      `INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
       VALUES ($1, $2, 'Operator', 'Create', 'document_center_number_reserved', $3)`,
      [
        `AUD-${crypto.randomUUID()}`,
        authUser.id,
        JSON.stringify({
          event: "document_center_number_reserved",
          issueBatchId: batch.id,
          documentDefinitionId: definition.id,
          typeCode: definition.type_code,
          documentNumber: batch.documentNumber,
          recycled: Boolean(batch.recycled),
          note
        })
      ]
    );

    await client.query("COMMIT");
    return {
      id: batch.id,
      documentNumber: batch.documentNumber,
      typeCode: batch.typeCode,
      sequence: batch.sequence,
      issuedAt: batch.issuedAt,
      definition: {
        id: definition.id,
        name: definition.name,
        typeName: definition.type_name,
        documentPurpose: definition.document_purpose,
        requestMode: definition.request_mode,
        isActive: definition.is_active
      },
      note
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function parseReleaseNumberBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError(400, "Input tidak valid.");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "issueBatchId")) {
    throw createHttpError(400, "Input tidak valid.");
  }
  return { issueBatchId: requireSafeId(body.issueBatchId, "issueBatchId") };
}

function mapReservedNumberRow(row) {
  return {
    id: row.id,
    documentNumber: row.document_number,
    typeCode: row.type_code,
    sequence: Number(row.sequence_number),
    issuedAt: row.issued_at,
    definition: {
      id: row.definition_id,
      name: row.definition_name,
      typeName: row.type_name,
      documentPurpose: row.document_purpose,
      requestMode: row.request_mode,
      isActive: row.is_active
    },
    note: row.note || null
  };
}

async function listReservedDocumentCenterNumbers({ authUser }) {
  const result = await pool.query(
    `
    WITH number_events AS (
      SELECT
        al.logged_at,
        'reserved' AS event_name,
        al.detail->>'issueBatchId' AS issue_batch_id,
        al.detail->>'documentDefinitionId' AS document_definition_id,
        al.detail->>'typeCode' AS type_code,
        al.detail->>'note' AS note
      FROM audit_logs al
      WHERE al.user_id = $1
        AND al.target = 'document_center_number_reserved'
      UNION ALL
      SELECT
        al.logged_at,
        'released' AS event_name,
        al.detail->>'issueBatchId' AS issue_batch_id,
        NULL AS document_definition_id,
        al.detail->>'typeCode' AS type_code,
        NULL AS note
      FROM audit_logs al
      WHERE al.user_id = $1
        AND al.target = 'document_center_number_released'
    ),
    latest_events AS (
      SELECT DISTINCT ON (type_code) *
      FROM number_events
      WHERE type_code IS NOT NULL
      ORDER BY type_code, logged_at DESC, event_name DESC
    )
    SELECT
      b.id,
      b.document_number,
      b.type_code,
      b.sequence_number,
      b.issued_at,
      d.id AS definition_id,
      d.name AS definition_name,
      d.type_name,
      d.document_purpose,
      d.request_mode,
      d.is_active,
      h.note,
      h.logged_at
    FROM latest_events h
    JOIN dc_issue_batches b ON b.id = h.issue_batch_id
    JOIN dc_document_definitions d ON d.id = h.document_definition_id
    WHERE h.event_name = 'reserved'
      AND (
        b.type_code IN ('09', '13')
        OR NOT EXISTS (
          SELECT 1 FROM dc_official_documents od WHERE od.issue_batch_id = b.id
        )
      )
    ORDER BY h.type_code
    `,
    [authUser.id]
  );

  return { items: result.rows.map(mapReservedNumberRow) };
}

async function releaseDocumentCenterNumber({ authUser, body }) {
  const { issueBatchId } = parseReleaseNumberBody(body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT
        b.id,
        b.document_number,
        b.type_code,
        b.sequence_number,
        b.issued_at
      FROM dc_issue_batches b
      WHERE b.id = $1
        AND EXISTS (
          SELECT 1
          FROM audit_logs al
          WHERE al.user_id = $2
            AND al.target = 'document_center_number_reserved'
            AND al.detail->>'issueBatchId' = b.id
        )
      LIMIT 1
      `,
      [issueBatchId, authUser.id]
    );
    const batch = result.rows[0];
    if (!batch) {
      throw createHttpError(404, "Nomor dokumen tidak ditemukan.");
    }

    await client.query(
      `INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
       VALUES ($1, $2, 'Operator', 'Update', 'document_center_number_released', $3)`,
      [
        `AUD-${crypto.randomUUID()}`,
        authUser.id,
        JSON.stringify({
          event: "document_center_number_released",
          issueBatchId: batch.id,
          typeCode: batch.type_code,
          documentNumber: batch.document_number
        })
      ]
    );

    await client.query("COMMIT");
    return {
      released: true,
      issueBatchId: batch.id,
      typeCode: batch.type_code,
      documentNumber: batch.document_number
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mapIssueBatchRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    typeCode: row.type_code,
    sequence: Number(row.sequence_number),
    documentNumber: row.document_number,
    issuedAt: row.issued_at,
    reused: true
  };
}

async function findReusableFinalActivityIssueBatch(client, { documentId, typeCode, publishTime }) {
  const completion = await client.query(
    `
    SELECT b.id, b.type_code, b.sequence_number, b.document_number, b.issued_at
    FROM dc_final_activity_cases current_case
    JOIN dc_final_activity_cases existing_case
      ON existing_case.completion_document_definition_id = current_case.completion_document_definition_id
     AND existing_case.activity_type = current_case.activity_type
     AND existing_case.period_key = current_case.period_key
     AND existing_case.outcome = current_case.outcome
    JOIN dc_official_documents existing_document
      ON existing_document.id = existing_case.completion_document_id
    JOIN dc_issue_batches b
      ON b.id = existing_document.issue_batch_id
    WHERE current_case.completion_document_id = $1
      AND existing_case.id <> current_case.id
      AND existing_document.status IN ('terbit', 'diarsipkan')
      AND existing_document.document_definition_id = current_case.completion_document_definition_id
      AND b.type_code = $2
      AND b.sequence_year = $3
    ORDER BY b.issued_at ASC, b.created_at ASC, b.id ASC
    LIMIT 1
    `,
    [documentId, typeCode, publishTime.sequence_year]
  );
  if (completion.rowCount) return mapIssueBatchRow(completion.rows[0]);

  const certificate = await client.query(
    `
    SELECT b.id, b.type_code, b.sequence_number, b.document_number, b.issued_at
    FROM dc_final_activity_case_projects current_project
    JOIN dc_final_activity_cases current_case
      ON current_case.id = current_project.final_activity_case_id
    JOIN dc_final_activity_case_projects existing_project
      ON existing_project.certificate_document_definition_id = current_project.certificate_document_definition_id
    JOIN dc_final_activity_cases existing_case
      ON existing_case.id = existing_project.final_activity_case_id
     AND existing_case.activity_type = current_case.activity_type
     AND existing_case.period_key = current_case.period_key
     AND existing_case.outcome = current_case.outcome
    JOIN dc_official_documents existing_document
      ON existing_document.id = existing_project.certificate_document_id
    JOIN dc_issue_batches b
      ON b.id = existing_document.issue_batch_id
    WHERE current_project.certificate_document_id = $1
      AND existing_project.id <> current_project.id
      AND existing_project.certificate_required = TRUE
      AND existing_document.status IN ('terbit', 'diarsipkan')
      AND existing_document.document_definition_id = current_project.certificate_document_definition_id
      AND b.type_code = $2
      AND b.sequence_year = $3
    ORDER BY b.issued_at ASC, b.created_at ASC, b.id ASC
    LIMIT 1
    `,
    [documentId, typeCode, publishTime.sequence_year]
  );
  if (certificate.rowCount) return mapIssueBatchRow(certificate.rows[0]);

  return null;
}

async function loadReservedIssueBatches(client, { issueBatchIdsByTypeCode, requiredTypeCodes }) {
  const entries = Object.entries(issueBatchIdsByTypeCode || {});
  if (!entries.length) return new Map();

  const required = new Set(requiredTypeCodes);
  const reserved = new Map();
  for (const [typeCode, issueBatchId] of entries) {
    if (!required.has(typeCode)) {
      // A retry may repair a legacy partial case (for example, certificate
      // already issued but completion letter still missing). Keep the other
      // reserved number untouched instead of rejecting the whole operation.
      continue;
    }
    const batch = await client.query(
      `
      SELECT id, type_code, sequence_number, document_number, issued_at
      FROM dc_issue_batches
      WHERE id=$1 AND type_code=$2
      FOR UPDATE
      `,
      [issueBatchId, typeCode]
    );
    if (!batch.rowCount) throw createHttpError(404, "Nomor dokumen tidak ditemukan.");

    const mapped = mapIssueBatchRow(batch.rows[0]);
    mapped.reserved = true;
    reserved.set(typeCode, mapped);
  }
  return reserved;
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
  const isCompletionLetter = document.definition_id === "DCDEF-COMPLETE-NORMAL-01" ||
    document.definition_id === "DCDEF-COMPLETE-EARLY-01";
  const isGeneratedCertificate = document.definition_id === "DCDEF-CERT-NORMAL-01" ||
    document.definition_id === "DCDEF-CERT-EARLY-01";
  const generatedFinal = isCompletionLetter
    ? await renderPublishedCompletionLetterVersion({
      client,
      document,
      documentNumber: issueBatch.documentNumber,
      issuedAt: issueBatch.issuedAt
    })
    : isGeneratedCertificate
      ? await renderPublishedCertificateVersion({
        client,
        document,
        documentNumber: issueBatch.documentNumber,
        issuedAt: issueBatch.issuedAt
      })
      : null;

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

async function publishDocumentsInIssueBatches({ documentIds, authUser, ip, reuseFinalActivityIssueBatches = false, issueBatchIdsByTypeCode = {} }) {
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
    const reservedIssueBatches = await loadReservedIssueBatches(client, {
      issueBatchIdsByTypeCode,
      requiredTypeCodes: prepared.map((item) => item.document.type_code)
    });
    const batchesByKey = new Map();
    for (const item of prepared) {
      let issueBatch = reservedIssueBatches.get(item.document.type_code) || null;
      if (!issueBatch && reuseFinalActivityIssueBatches) {
        issueBatch = await findReusableFinalActivityIssueBatch(client, {
          documentId: item.safeDocumentId,
          typeCode: item.document.type_code,
          publishTime
        });
      }
      if (!issueBatch && reuseFinalActivityIssueBatches) {
        throw createHttpError(409, `Ambil nomor dokumen kode ${item.document.type_code} terlebih dahulu.`);
      }

      const batchKey = issueBatch ? `existing:${issueBatch.id}` : `new:${item.document.type_code}`;
      if (!batchesByKey.has(batchKey)) {
        batchesByKey.set(
          batchKey,
          issueBatch || await createIssueBatch(client, {
            typeCode: item.document.type_code,
            publishTime,
            operatorUserId
          })
        );
      }
      item.batchKey = batchKey;
    }

    const results = [];
    for (const item of prepared) {
      const issueBatch = batchesByKey.get(item.batchKey);
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
      batches: [...batchesByKey.values()].map((batch) => ({
        id: batch.id,
        typeCode: batch.typeCode,
        sequence: batch.sequence,
        documentNumber: batch.documentNumber,
        issuedAt: batch.issuedAt,
        reused: batch.reused === true,
        reserved: batch.reserved === true
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

async function publishDocumentBatch({ authUser, ip, body, reuseFinalActivityIssueBatches = false }) {
  const { documentIds, issueBatchIdsByTypeCode } = parseBulkPublishBody(body);
  return publishDocumentsInIssueBatches({ documentIds, authUser, ip, reuseFinalActivityIssueBatches, issueBatchIdsByTypeCode });
}

module.exports = {
  publishDocument,
  publishDocumentBatch,
  reserveDocumentCenterNumber,
  listReservedDocumentCenterNumbers,
  releaseDocumentCenterNumber
};
