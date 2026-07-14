const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
const { buildStudentKey } = require("./documentCenterIdentity");
const {
  STAGING_ROOT,
  buildStagingFilePath,
  buildVersionStorageKey,
  buildVersionFilePath,
  getVersionDirectory
} = require("./documentCenterStorage");

const MAX_RAW_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PARTICIPANTS = 100;
const ACTIVITY_OUTCOMES = new Set([
  "completed",
  "withdrawn_early",
  "terminated_early"
]);
const REQUEST_FIELDS = new Set([
  "documentDefinitionId",
  "title",
  "activityOutcome",
  "fileName",
  "fileDataUrl",
  "participants"
]);
const PARTICIPANT_FIELDS = new Set([
  "legacyStudentId",
  "legacyProjectId",
  "period"
]);

function createInputError(field) {
  const error = new Error("Input tidak valid.");
  error.statusCode = 400;
  error.field = field;
  return error;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createInputError(field);
  }
  return value;
}

function rejectUnexpectedFields(value, allowedFields, field) {
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw createInputError(field);
  }
}

function requireTrimmedText(value, field, maxLength) {
  if (typeof value !== "string") throw createInputError(field);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\x00-\x1F\x7F]/.test(normalized)) {
    throw createInputError(field);
  }
  return normalized;
}

function requireNullableSafeId(value, field) {
  if (value == null) return null;
  if (typeof value !== "string" || value.trim() !== value) throw createInputError(field);
  return requireSafeId(value, field);
}

function parseActivityOutcome(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !ACTIVITY_OUTCOMES.has(value)) {
    throw createInputError("activityOutcome");
  }
  return value;
}

function requireIsoDate(value, field, allowNull = false) {
  if (value == null && allowNull) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createInputError(field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw createInputError(field);
  }
  return value;
}

function parsePeriodSelection(value) {
  if (value == null) return null;
  requirePlainObject(value, "period");
  rejectUnexpectedFields(value, new Set(["activityType", "startDate", "endDate"]), "period");
  const activityType = requireTrimmedText(value.activityType, "period.activityType", 20);
  if (!["Magang", "Riset"].includes(activityType)) {
    throw createInputError("period.activityType");
  }
  const startDate = requireIsoDate(value.startDate, "period.startDate");
  const endDate = requireIsoDate(value.endDate, "period.endDate", true);
  if (endDate && endDate < startDate) throw createInputError("period.endDate");
  return { activityType, startDate, endDate };
}

function validateOutcomeForDefinition(requestMode, activityOutcome) {
  if (requestMode === "alumni_sync" && activityOutcome !== "completed") {
    throw createInputError("activityOutcome");
  }
  if (
    requestMode === "early_exit_review" &&
    !["withdrawn_early", "terminated_early"].includes(activityOutcome)
  ) {
    throw createInputError("activityOutcome");
  }
  if (
    ["student_request", "operator_only"].includes(requestMode) &&
    activityOutcome !== null
  ) {
    throw createInputError("activityOutcome");
  }
}

function sanitizeFilename(value) {
  const filename = requireTrimmedText(value, "fileName", 160);
  const basename = path.basename(filename.replace(/\\/g, "/"));
  if (basename !== filename || !/\.pdf$/i.test(basename)) {
    throw createInputError("fileName");
  }
  return basename;
}

function decodePdfDataUrl(value) {
  if (typeof value !== "string") throw createInputError("fileDataUrl");
  const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw createInputError("fileDataUrl");

  const payload = match[1];
  const maxBase64Length = Math.ceil(MAX_RAW_PDF_BYTES / 3) * 4;
  if (payload.length > maxBase64Length || payload.length % 4 !== 0) {
    throw createInputError("fileDataUrl");
  }

  const buffer = Buffer.from(payload, "base64");
  if (
    buffer.length === 0 ||
    buffer.length > MAX_RAW_PDF_BYTES ||
    buffer.toString("base64") !== payload ||
    !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    throw createInputError("fileDataUrl");
  }

  return buffer;
}

function parseParticipants(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTICIPANTS) {
    throw createInputError("participants");
  }

  return value.map((participant, index) => {
    requirePlainObject(participant, `participants.${index}`);
    rejectUnexpectedFields(participant, PARTICIPANT_FIELDS, `participants.${index}`);
    return {
      legacyStudentId: requireNullableSafeId(participant.legacyStudentId, "legacyStudentId"),
      legacyProjectId: requireNullableSafeId(participant.legacyProjectId, "legacyProjectId"),
      period: parsePeriodSelection(participant.period)
    };
  });
}

function parseUploadRequest(body) {
  requirePlainObject(body, "body");
  rejectUnexpectedFields(body, REQUEST_FIELDS, "body");

  return {
    documentDefinitionId: requireNullableSafeId(body.documentDefinitionId, "documentDefinitionId"),
    title: requireTrimmedText(body.title, "title", 300),
    activityOutcome: parseActivityOutcome(body.activityOutcome),
    originalFilename: sanitizeFilename(body.fileName),
    pdfBuffer: decodePdfDataUrl(body.fileDataUrl),
    participants: parseParticipants(body.participants)
  };
}

async function resolveDefinition(documentDefinitionId) {
  const result = await pool.query(
    `
    SELECT id, type_code, type_name, name, document_purpose, request_mode,
           activity_type, can_be_collective, requires_project, requires_period
    FROM dc_document_definitions
    WHERE id = $1
      AND is_active = TRUE
    LIMIT 1
    `,
    [documentDefinitionId]
  );
  if (result.rowCount === 0) throw createInputError("documentDefinitionId");
  return result.rows[0];
}

async function resolveParticipantSnapshots(participants, definition) {
  if (!definition.can_be_collective && participants.length !== 1) {
    throw createInputError("participants");
  }

  for (const participant of participants) {
    if (!participant.legacyStudentId) throw createInputError("legacyStudentId");
    if (definition.requires_project && !participant.legacyProjectId) {
      throw createInputError("legacyProjectId");
    }
  }

  const studentIds = [...new Set(participants.map((participant) => participant.legacyStudentId))];
  const studentResult = await pool.query(
    `
    SELECT s.id, s.user_id, s.nim, s.tipe AS student_activity_type, s.status,
           u.name, u.prodi
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ANY($1::text[])
    `,
    [studentIds]
  );
  const studentsById = new Map(studentResult.rows.map((row) => [row.id, row]));
  if (studentsById.size !== studentIds.length) throw createInputError("legacyStudentId");

  const periodsByStudentId = new Map(studentIds.map((studentId) => [studentId, []]));
  const periodResult = await pool.query(
    `
    SELECT id, student_id, tipe, mulai, selesai, keterangan
    FROM student_periods
    WHERE student_id = ANY($1::text[])
    ORDER BY student_id ASC, mulai ASC, id ASC
    `,
    [studentIds]
  );
  for (const row of periodResult.rows) {
    periodsByStudentId.get(row.student_id).push(row);
  }

  const requestedProjects = participants.filter((participant) => participant.legacyProjectId);
  const projectsByStudentAndId = new Map();
  if (requestedProjects.length > 0) {
    const projectResult = await pool.query(
      `
      WITH requested(student_id, project_id) AS (
        SELECT * FROM unnest($1::text[], $2::text[])
      )
      SELECT requested.student_id, rp.id, rp.title, rp.short_title, rp.period_text,
             rp.status AS project_status, rm.status AS membership_status, rm.peran,
             rm.bergabung, rm.selesai
      FROM requested
      JOIN students s ON s.id = requested.student_id
      JOIN research_memberships rm
        ON rm.user_id = s.user_id
       AND rm.project_id = requested.project_id
       AND rm.member_type = 'Mahasiswa'
      JOIN research_projects rp ON rp.id = rm.project_id
      `,
      [
        requestedProjects.map((participant) => participant.legacyStudentId),
        requestedProjects.map((participant) => participant.legacyProjectId)
      ]
    );
    for (const row of projectResult.rows) {
      projectsByStudentAndId.set(`${row.student_id}:${row.id}`, row);
    }
  }

  const resolved = participants.map((participant, displayOrder) => {
    const student = studentsById.get(participant.legacyStudentId);
    const legacyPeriods = periodsByStudentId.get(student.id) || [];
    let period = null;
    let periodSnapshotData = null;

    if (definition.requires_period || participant.period) {
      if (legacyPeriods.length === 1) {
        period = legacyPeriods[0];
        periodSnapshotData = {
          source: "legacy",
          legacyPeriodId: period.id,
          activityType: period.tipe,
          startDate: period.mulai,
          endDate: period.selesai || null,
          description: period.keterangan || null
        };
      } else if (legacyPeriods.length > 1) {
        if (!participant.period) throw createInputError("period");
        const matchingPeriods = legacyPeriods.filter(
          (candidate) =>
            candidate.tipe === participant.period.activityType &&
            candidate.mulai === participant.period.startDate &&
            (candidate.selesai || null) === participant.period.endDate
        );
        if (matchingPeriods.length !== 1) throw createInputError("period");
        period = matchingPeriods[0];
        periodSnapshotData = {
          source: "legacy",
          legacyPeriodId: period.id,
          activityType: period.tipe,
          startDate: period.mulai,
          endDate: period.selesai || null,
          description: period.keterangan || null
        };
      } else if (participant.period) {
        if (!participant.period.endDate) throw createInputError("period.endDate");
        periodSnapshotData = {
          source: "operator_manual",
          legacyPeriodId: null,
          activityType: participant.period.activityType,
          startDate: participant.period.startDate,
          endDate: participant.period.endDate,
          description: null
        };
      } else if (definition.requires_period) {
        throw createInputError("period");
      }
    }
    const project = participant.legacyProjectId
      ? projectsByStudentAndId.get(`${student.id}:${participant.legacyProjectId}`)
      : null;

    if (participant.legacyProjectId && !project) throw createInputError("legacyProjectId");
    if (definition.requires_period && !periodSnapshotData) throw createInputError("period");
    if (definition.requires_project && !project) throw createInputError("legacyProjectId");

    const studentKey = buildStudentKey(student.id);
    const projectKey = project ? `project:${project.id}` : null;
    const periodKey = period
      ? `period:${period.id}`
      : periodSnapshotData
        ? `period:${periodSnapshotData.activityType}:${periodSnapshotData.startDate}:${periodSnapshotData.endDate}`
        : null;
    return {
      studentKey,
      legacyStudentId: student.id,
      legacyProjectId: project ? project.id : null,
      legacyPeriodKey: periodKey,
      projectKey,
      nameSnapshot: student.name,
      nimSnapshot: student.nim,
      prodiSnapshot: student.prodi || "-",
      universitySnapshot: null,
      projectNameSnapshot: project ? project.title : null,
      periodSnapshot: periodSnapshotData
        ? `${periodSnapshotData.activityType}: ${periodSnapshotData.startDate}${periodSnapshotData.endDate ? ` s.d. ${periodSnapshotData.endDate}` : ""}`
        : null,
      participantRole: project?.peran || null,
      displayOrder,
      actualActivityType: periodSnapshotData?.activityType || null,
      studentActivityType: student.student_activity_type,
      projectSnapshot: project
        ? {
            legacyProjectId: project.id,
            title: project.title,
            shortTitle: project.short_title || null,
            periodText: project.period_text || null,
            status: project.project_status,
            membershipStatus: project.membership_status,
            role: project.peran || null,
            joinedAt: project.bergabung || null,
            endedAt: project.selesai || null
          }
        : null,
      periodSnapshotData
    };
  });

  const participantIdentities = new Set();
  for (const participant of resolved) {
    const identity = [
      participant.studentKey,
      participant.projectKey || "",
      participant.legacyPeriodKey || ""
    ].join("|");
    if (participantIdentities.has(identity)) throw createInputError("participants");
    participantIdentities.add(identity);
  }

  const activityTypes = new Set(resolved.map((participant) => participant.actualActivityType).filter(Boolean));
  if (activityTypes.size > 1) throw createInputError("participants");

  return {
    participants: resolved,
    actualActivityType: activityTypes.size === 1 ? [...activityTypes][0] : null
  };
}

function buildVersionSnapshot(definition, actualActivityType, participants) {
  return {
    definition: {
      id: definition.id,
      typeCode: definition.type_code,
      typeName: definition.type_name,
      name: definition.name,
      documentPurpose: definition.document_purpose,
      requestMode: definition.request_mode,
      activityType: definition.activity_type || null
    },
    actualActivityType,
    participants: participants.map((participant) => ({
      name: participant.nameSnapshot,
      nim: participant.nimSnapshot,
      prodi: participant.prodiSnapshot,
      university: participant.universitySnapshot,
      legacyStudentId: participant.legacyStudentId,
      studentActivityType: participant.studentActivityType,
      project: participant.projectSnapshot,
      period: participant.periodSnapshotData
    }))
  };
}

function buildDocumentSnapshot(definition, actualActivityType, participantCount, activityOutcome) {
  return {
    definitionId: definition.id,
    documentPurpose: definition.document_purpose,
    requestMode: definition.request_mode,
    definitionActivityType: definition.activity_type || null,
    actualActivityType,
    activityOutcome,
    participantCount
  };
}

async function removeIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function createDocumentCenterDraft({ body, authUser, ip, onDraftCreated, generatedFrom = "operator_manual" }) {
  const request = parseUploadRequest(body);
  const definition = await resolveDefinition(request.documentDefinitionId);
  validateOutcomeForDefinition(definition.request_mode, request.activityOutcome);
  const resolved = await resolveParticipantSnapshots(request.participants, definition);
  const versionSnapshot = buildVersionSnapshot(
    definition,
    resolved.actualActivityType,
    resolved.participants
  );
  const documentSnapshot = buildDocumentSnapshot(
    definition,
    resolved.actualActivityType,
    resolved.participants.length,
    request.activityOutcome
  );
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  const documentId = `DCDOC-${crypto.randomUUID()}`;
  const versionId = `DCVER-${crypto.randomUUID()}`;
  const auditId = `AUD-DC-${crypto.randomUUID()}`;
  const stagingPath = buildStagingFilePath(`${crypto.randomUUID()}.pdf`);
  const storageKey = buildVersionStorageKey(documentId, 1);
  const finalPath = buildVersionFilePath(documentId, 1);
  let client;
  let transactionStarted = false;
  let finalMoved = false;
  let committed = false;

  try {
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, request.pdfBuffer, { flag: "wx" });

    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      `
      INSERT INTO dc_official_documents (
        id, document_definition_id, source_request_id, generation_key,
        document_number, title, status, generated_from, activity_outcome,
        snapshot_data, current_version_number
      )
      VALUES ($1, $2, NULL, NULL, NULL, $3, 'draft', $4, $5, $6::jsonb, 1)
      `,
      [
        documentId,
        definition.id,
        request.title,
        generatedFrom,
        request.activityOutcome,
        JSON.stringify(documentSnapshot)
      ]
    );

    await client.query(
      `
      INSERT INTO dc_document_versions (
        id, document_id, version_number, storage_key, original_filename,
        download_filename, mime_type, file_size, checksum_sha256,
        signer_snapshot, snapshot_data, version_reason
      )
      VALUES ($1, $2, 1, $3, $4, $5, 'application/pdf', $6, $7, NULL, $8::jsonb, 'initial_issue')
      `,
      [
        versionId,
        documentId,
        storageKey,
        request.originalFilename,
        `${documentId}-v1.pdf`,
        request.pdfBuffer.length,
        crypto.createHash("sha256").update(request.pdfBuffer).digest("hex"),
        JSON.stringify(versionSnapshot)
      ]
    );

    const participantValues = [];
    const participantParams = [];
    for (const participant of resolved.participants) {
      const offset = participantParams.length;
      participantParams.push(
        `DCPART-${crypto.randomUUID()}`,
        documentId,
        participant.studentKey,
        participant.legacyStudentId,
        participant.legacyProjectId,
        participant.legacyPeriodKey,
        participant.projectKey,
        participant.nameSnapshot,
        participant.nimSnapshot,
        participant.prodiSnapshot,
        participant.universitySnapshot,
        participant.projectNameSnapshot,
        participant.periodSnapshot,
        participant.participantRole,
        participant.displayOrder
      );
      participantValues.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
        `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15})`
      );
    }
    await client.query(
      `
      INSERT INTO dc_official_document_students (
        id, document_id, student_key, legacy_student_id, legacy_project_id,
        legacy_period_key, project_key, name_snapshot, nim_snapshot,
        prodi_snapshot, university_snapshot, project_name_snapshot,
        period_snapshot, participant_role, display_order
      )
      VALUES ${participantValues.join(", ")}
      `,
      participantParams
    );

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, 'Operator', 'Create', 'document_center_document', $3, $4::jsonb)
      `,
      [
        auditId,
        operatorUserId,
        ip || null,
        JSON.stringify({
          module: "document_center",
          event: "document_draft_uploaded",
          documentId,
          definitionId: definition.id,
          participantCount: resolved.participants.length
        })
      ]
    );

    if (typeof onDraftCreated === "function") {
      await onDraftCreated({
        client,
        documentId,
        versionId,
        definition,
        request,
        resolved,
        operatorUserId
      });
    }

    await fs.mkdir(getVersionDirectory(documentId), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    finalMoved = true;
    await client.query("COMMIT");
    committed = true;

    return {
      id: documentId,
      title: request.title,
      status: "draft",
      documentNumber: null,
      currentVersionNumber: 1,
      documentDefinitionId: definition.id,
      participantCount: resolved.participants.length,
      canDownload: false
    };
  } catch (error) {
    if (transactionStarted && !committed) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // The original error remains the response; filesystem cleanup still runs.
      }
    }
    if (!committed && finalMoved) await removeIfExists(finalPath).catch(() => {});
    await removeIfExists(stagingPath).catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  createDocumentCenterDraft
};
