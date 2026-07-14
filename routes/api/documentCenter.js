const express = require("express");
const { pipeline } = require("stream/promises");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { requireRoleStrict } = require("../../utils/roleGuard");
const {
  parseBoundedLimit,
  parseBoundedOffset,
  requireEnum,
  requireSafeId
} = require("../../utils/securityValidation");
const {
  requireDocumentCenterKey,
  resolveDocumentCenterStudent
} = require("../../utils/documentCenterIdentity");
const { createDocumentCenterDraft } = require("../../utils/documentCenterDraftUpload");
const { publishDocument } = require("../../utils/documentCenterPublish");
const {
  getDefinitions: getStudentRequestDefinitions,
  getContext: getStudentRequestContext,
  submitRequest: submitStudentRequest,
  listRequests: listStudentRequests,
  detailRequest: detailStudentRequest,
  editRequest: editStudentRequest,
  cancelRequest: cancelStudentRequest
} = require("../../utils/documentCenterStudentRequests");
const {
  listRequests: listOperatorRequests,
  detailRequest: detailOperatorRequest,
  requestRevision,
  approveRequest,
  rejectRequest,
  listDocumentCandidates,
  linkDocument
} = require("../../utils/documentCenterOperatorRequests");
const { listStudents, listStudentPeriods, listStudentProjects } = require("../../utils/documentCenterLookups");
const {
  openPrivateDocumentVersion,
  sanitizeDownloadFilename
} = require("../../utils/documentCenterStorage");

const router = express.Router();

const DOCUMENT_STATUSES = [
  "draft",
  "sedang_dibuat",
  "perlu_dilengkapi",
  "gagal_dibuat",
  "terbit",
  "diarsipkan",
  "dicabut"
];
const STUDENT_DOCUMENT_STATUSES = ["terbit", "diarsipkan"];
const DOCUMENT_PURPOSES = [
  "introductory_letter",
  "acceptance_letter",
  "completion_letter",
  "certificate",
  "general"
];

function normalizeOptionalText(value, label, maxLength = 200) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength || /[\x00-\x1F\x7F]/.test(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = label;
    throw error;
  }
  return normalized;
}

function parseTypeCode(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^[0-9]{2}$/.test(normalized)) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = "typeCode";
    throw error;
  }
  return normalized;
}

function parseDocumentCenterLimit(value) {
  if (value == null || value === "") return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    const error = new Error("Input tidak valid.");
    error.statusCode = 400;
    error.field = "limit";
    throw error;
  }
  return parseBoundedLimit(parsed, 20, 100);
}

function parseListOptions(req, allowedStatuses) {
  return {
    status: requireEnum(req.query.status, allowedStatuses, "status"),
    documentPurpose: requireEnum(req.query.documentPurpose, DOCUMENT_PURPOSES, "documentPurpose"),
    projectKey: req.query.projectKey == null || req.query.projectKey === ""
      ? null
      : requireDocumentCenterKey(req.query.projectKey, "projectKey"),
    periodKey: normalizeOptionalText(req.query.periodKey, "periodKey", 160),
    limit: parseDocumentCenterLimit(req.query.limit),
    offset: parseBoundedOffset(req.query.offset, 0, 10000)
  };
}

function addFilter(predicates, params, value, buildSql) {
  if (value == null || value === "") return;
  params.push(value);
  predicates.push(buildSql(params.length));
}

function mapDocumentRow(row, includeParticipants = false, isStudent = false) {
  const hasCurrentVersion = Number.isInteger(Number(row.current_version_number)) && Number(row.current_version_number) > 0;
  const canDownload = isStudent
    ? hasCurrentVersion && ["terbit", "diarsipkan"].includes(row.status)
    : hasCurrentVersion;
  const result = {
    id: row.id,
    title: row.title,
    documentNumber: row.document_number || null,
    status: row.status,
    statusLabel: row.status === "dicabut" ? "Tidak Berlaku" : row.status === "terbit" || row.status === "diarsipkan" ? "Tersedia" : row.status,
    documentPurpose: row.document_purpose,
    typeCode: row.type_code,
    typeName: row.type_name,
    activityType: row.activity_type || null,
    generatedFrom: row.generated_from,
    activityOutcome: row.activity_outcome || null,
    currentVersionNumber: row.current_version_number || null,
    createdAt: row.created_at || null,
    issuedAt: row.issued_at || null,
    archivedAt: row.archived_at || null,
    canDownload
  };

  if (includeParticipants) {
    result.participants = row.participants || [];
  } else {
    result.participantContexts = row.participant_contexts || [];
  }

  return result;
}

function sendUnavailableDocumentFile(res) {
  return res.status(410).json({ message: "File dokumen tidak tersedia." });
}

async function findDownloadDocumentForStudent(documentId, studentKey) {
  return query(
    `
    SELECT od.id, od.status, od.current_version_number,
           dv.id AS version_id, dv.storage_key, dv.download_filename,
           dv.mime_type, dv.file_size
    FROM dc_official_documents od
    LEFT JOIN dc_document_versions dv
      ON dv.document_id = od.id
     AND dv.version_number = od.current_version_number
    WHERE od.id = $1
      AND od.status IN ('terbit', 'diarsipkan')
      AND EXISTS (
        SELECT 1
        FROM dc_official_document_students ods
        WHERE ods.document_id = od.id
          AND ods.student_key = $2
      )
    LIMIT 1
    `,
    [documentId, studentKey]
  );
}

async function findDownloadDocumentForOperator(documentId) {
  return query(
    `
    SELECT od.id, od.status, od.current_version_number,
           dv.id AS version_id, dv.storage_key, dv.download_filename,
           dv.mime_type, dv.file_size
    FROM dc_official_documents od
    LEFT JOIN dc_document_versions dv
      ON dv.document_id = od.id
     AND dv.version_number = od.current_version_number
    WHERE od.id = $1
    LIMIT 1
    `,
    [documentId]
  );
}

async function resolveStudentOrThrow(req) {
  const student = await resolveDocumentCenterStudent(req.authUser?.id);
  if (!student) {
    const error = new Error("Data mahasiswa tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
  return student;
}

router.get("/my/request-definitions", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await getStudentRequestDefinitions());
}));

router.get("/my/request-context", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await getStudentRequestContext(req.authUser?.id, req.query));
}));

router.get("/my/requests", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await listStudentRequests(req.authUser?.id, req.query));
}));

router.get("/my/requests/:id", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await detailStudentRequest(req.authUser?.id, req.params.id));
}));

router.post("/my/requests", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.status(201).json(await submitStudentRequest({ authUser: req.authUser, body: req.body }));
}));

router.patch("/my/requests/:id", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await editStudentRequest({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.post("/my/requests/:id/cancel", requireRoleStrict(["mahasiswa"]), asyncHandler(async (req, res) => {
  res.json(await cancelStudentRequest({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.get(
  "/my/documents",
  requireRoleStrict(["mahasiswa"]),
  asyncHandler(async (req, res) => {
    const student = await resolveStudentOrThrow(req);
    const options = parseListOptions(req, STUDENT_DOCUMENT_STATUSES);
    const predicates = [
      "od.status IN ('terbit', 'diarsipkan')",
      "EXISTS (SELECT 1 FROM dc_official_document_students ods_access WHERE ods_access.document_id = od.id AND ods_access.student_key = $1)"
    ];
    const params = [student.studentKey];

    addFilter(predicates, params, options.status, (index) => `od.status = $${index}`);
    addFilter(predicates, params, options.documentPurpose, (index) => `dd.document_purpose = $${index}`);
    addFilter(predicates, params, options.projectKey, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_project WHERE ods_project.document_id = od.id AND ods_project.student_key = $1 AND ods_project.project_key = $${index})`);
    addFilter(predicates, params, options.periodKey, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_period WHERE ods_period.document_id = od.id AND ods_period.student_key = $1 AND ods_period.legacy_period_key = $${index})`);

    params.push(options.limit, options.offset);
    const result = await query(
      `
      WITH filtered AS (
        SELECT od.id, od.title, od.document_number, od.status, od.generated_from,
               od.activity_outcome, od.current_version_number, od.created_at, od.issued_at, od.archived_at,
               dd.document_purpose, dd.type_code, dd.type_name, dd.activity_type,
               COUNT(*) OVER() AS total_count
        FROM dc_official_documents od
        JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
        WHERE ${predicates.join(" AND ")}
        ORDER BY od.issued_at DESC NULLS LAST, od.created_at DESC, od.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      )
      SELECT filtered.*,
             COALESCE(contexts.participant_contexts, '[]'::jsonb) AS participant_contexts
      FROM filtered
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'projectKey', ods.project_key,
            'periodKey', ods.legacy_period_key,
            'projectName', ods.project_name_snapshot,
            'period', ods.period_snapshot,
            'participantRole', ods.participant_role
          ) ORDER BY ods.display_order, ods.id
        ) AS participant_contexts
        FROM dc_official_document_students ods
        WHERE ods.document_id = filtered.id
          AND ods.student_key = $1
      ) contexts ON TRUE
      ORDER BY filtered.issued_at DESC NULLS LAST, filtered.id DESC
      `,
      params
    );

    const total = result.rowCount > 0 ? Number(result.rows[0].total_count) : 0;
    res.json({
      items: result.rows.map((row) => mapDocumentRow(row, false, true)),
      pagination: { limit: options.limit, offset: options.offset, total }
    });
  })
);

router.get(
  "/documents/:id/download",
  requireRoleStrict(["mahasiswa", "operator"]),
  asyncHandler(async (req, res) => {
    const documentId = requireSafeId(req.params.id);
    const role = String(req.authUser?.role || "").trim().toLowerCase();
    let result;

    if (role === "mahasiswa") {
      const student = await resolveStudentOrThrow(req);
      result = await findDownloadDocumentForStudent(documentId, student.studentKey);
    } else {
      result = await findDownloadDocumentForOperator(documentId);
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Dokumen tidak ditemukan." });
    }

    const document = result.rows[0];
    if (!document.current_version_number || !document.version_id) {
      return sendUnavailableDocumentFile(res);
    }

    let openedFile;
    try {
      openedFile = await openPrivateDocumentVersion({
        storageKey: document.storage_key,
        mimeType: document.mime_type,
        fileSize: document.file_size
      });
    } catch (error) {
      if (error?.code === "DOCUMENT_FILE_UNAVAILABLE") {
        return sendUnavailableDocumentFile(res);
      }
      throw error;
    }

    const filename = sanitizeDownloadFilename(document.download_filename);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", openedFile.size);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const fileStream = openedFile.handle.createReadStream({ autoClose: true });
    try {
      await pipeline(fileStream, res);
    } catch (error) {
      if (!res.headersSent) {
        if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
          return sendUnavailableDocumentFile(res);
        }
        throw error;
      }
      res.destroy(error);
    } finally {
      await openedFile.handle.close().catch(() => {});
    }
  })
);

router.get(
  "/my/documents/:id",
  requireRoleStrict(["mahasiswa"]),
  asyncHandler(async (req, res) => {
    const student = await resolveStudentOrThrow(req);
    const documentId = requireSafeId(req.params.id);
    const result = await query(
      `
      SELECT od.id, od.title, od.document_number, od.status, od.generated_from,
             od.activity_outcome, od.current_version_number, od.created_at, od.issued_at, od.archived_at,
             dd.document_purpose, dd.type_code, dd.type_name, dd.activity_type,
             COALESCE(contexts.participant_contexts, '[]'::jsonb) AS participant_contexts
      FROM dc_official_documents od
      JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'projectKey', ods.project_key,
            'periodKey', ods.legacy_period_key,
            'projectName', ods.project_name_snapshot,
            'period', ods.period_snapshot,
            'participantRole', ods.participant_role
          ) ORDER BY ods.display_order, ods.id
        ) AS participant_contexts
        FROM dc_official_document_students ods
        WHERE ods.document_id = od.id
          AND ods.student_key = $1
      ) contexts ON TRUE
      WHERE od.id = $2
        AND od.status IN ('terbit', 'diarsipkan')
        AND EXISTS (
          SELECT 1
          FROM dc_official_document_students ods_access
          WHERE ods_access.document_id = od.id
            AND ods_access.student_key = $1
        )
      LIMIT 1
      `,
      [student.studentKey, documentId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Dokumen tidak ditemukan." });
    }

    res.json(mapDocumentRow(result.rows[0], false, true));
  })
);

router.get(
  "/operator/documents",
  requireRoleStrict(["operator"]),
  asyncHandler(async (req, res) => {
    const options = parseListOptions(req, DOCUMENT_STATUSES);
    const studentKey = req.query.studentKey == null || req.query.studentKey === ""
      ? null
      : requireDocumentCenterKey(req.query.studentKey, "studentKey");
    const studentQuery = normalizeOptionalText(req.query.studentQuery, "studentQuery", 120);
    const typeCode = parseTypeCode(req.query.typeCode);
    const documentNumber = normalizeOptionalText(req.query.documentNumber, "documentNumber", 128);
    const title = normalizeOptionalText(req.query.title, "title", 200);
    const predicates = [];
    const params = [];

    addFilter(predicates, params, options.status, (index) => `od.status = $${index}`);
    addFilter(predicates, params, options.documentPurpose, (index) => `dd.document_purpose = $${index}`);
    addFilter(predicates, params, typeCode, (index) => `dd.type_code = $${index}`);
    addFilter(predicates, params, options.projectKey, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_project WHERE ods_project.document_id = od.id AND ods_project.project_key = $${index})`);
    addFilter(predicates, params, options.periodKey, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_period WHERE ods_period.document_id = od.id AND ods_period.legacy_period_key = $${index})`);
    addFilter(predicates, params, studentKey, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_student WHERE ods_student.document_id = od.id AND ods_student.student_key = $${index})`);
    addFilter(predicates, params, studentQuery, (index) => `EXISTS (SELECT 1 FROM dc_official_document_students ods_search WHERE ods_search.document_id = od.id AND (ods_search.name_snapshot ILIKE '%' || $${index} || '%' OR ods_search.nim_snapshot ILIKE '%' || $${index} || '%'))`);
    addFilter(predicates, params, documentNumber, (index) => `od.document_number ILIKE '%' || $${index} || '%'`);
    addFilter(predicates, params, title, (index) => `od.title ILIKE '%' || $${index} || '%'`);

    const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    params.push(options.limit, options.offset);
    const result = await query(
      `
      WITH filtered AS (
        SELECT od.id, od.title, od.document_number, od.status, od.generated_from,
               od.activity_outcome, od.current_version_number, od.created_at, od.issued_at, od.archived_at,
               dd.document_purpose, dd.type_code, dd.type_name, dd.activity_type,
               COUNT(*) OVER() AS total_count
        FROM dc_official_documents od
        JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
        ${whereClause}
        ORDER BY od.issued_at DESC NULLS LAST, od.created_at DESC, od.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      )
      SELECT filtered.*,
             COALESCE(participant_rows.participants, '[]'::jsonb) AS participants
      FROM filtered
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', ods.name_snapshot,
            'nim', ods.nim_snapshot,
            'prodi', ods.prodi_snapshot,
            'university', ods.university_snapshot,
            'projectKey', ods.project_key,
            'projectName', ods.project_name_snapshot,
            'periodKey', ods.legacy_period_key,
            'period', ods.period_snapshot,
            'participantRole', ods.participant_role,
            'displayOrder', ods.display_order
          ) ORDER BY ods.display_order, ods.id
        ) AS participants
        FROM dc_official_document_students ods
        WHERE ods.document_id = filtered.id
      ) participant_rows ON TRUE
      ORDER BY filtered.issued_at DESC NULLS LAST, filtered.id DESC
      `,
      params
    );

    const total = result.rowCount > 0 ? Number(result.rows[0].total_count) : 0;
    res.json({
      items: result.rows.map((row) => mapDocumentRow(row, true)),
      pagination: { limit: options.limit, offset: options.offset, total }
    });
  })
);

router.post(
  "/operator/documents/upload",
  requireRoleStrict(["operator"]),
  asyncHandler(async (req, res) => {
    const document = await createDocumentCenterDraft({
      body: req.body,
      authUser: req.authUser,
      ip: req.ip
    });
    res.status(201).json(document);
  })
);

router.get("/operator/requests", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await listOperatorRequests(req.query));
}));

router.get("/operator/requests/:id", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await detailOperatorRequest(req.params.id));
}));

router.get("/operator/requests/:id/document-candidates", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await listDocumentCandidates(req.params.id));
}));

router.post("/operator/requests/:id/link-document", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await linkDocument({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.post("/operator/requests/:id/request-revision", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await requestRevision({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.post("/operator/requests/:id/approve", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await approveRequest({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.post("/operator/requests/:id/reject", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await rejectRequest({ authUser: req.authUser, id: req.params.id, body: req.body }));
}));

router.get("/operator/students", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await listStudents(req.query));
}));

router.get("/operator/students/:id/periods", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await listStudentPeriods(req.params.id));
}));

router.get("/operator/students/:id/projects", requireRoleStrict(["operator"]), asyncHandler(async (req, res) => {
  res.json(await listStudentProjects(req.params.id));
}));

router.post(
  "/operator/documents/:id/publish",
  requireRoleStrict(["operator"]),
  asyncHandler(async (req, res) => {
    const document = await publishDocument({
      documentId: req.params.id,
      authUser: req.authUser,
      ip: req.ip,
      body: req.body
    });
    res.status(200).json(document);
  })
);

router.get(
  "/operator/documents/:id",
  requireRoleStrict(["operator"]),
  asyncHandler(async (req, res) => {
    const documentId = requireSafeId(req.params.id);
    const result = await query(
      `
      SELECT od.id, od.title, od.document_number, od.status, od.generated_from,
             od.activity_outcome, od.current_version_number, od.created_at, od.issued_at, od.archived_at,
             dd.document_purpose, dd.type_code, dd.type_name, dd.activity_type,
             COALESCE(participant_rows.participants, '[]'::jsonb) AS participants
      FROM dc_official_documents od
      JOIN dc_document_definitions dd ON dd.id = od.document_definition_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', ods.name_snapshot,
            'nim', ods.nim_snapshot,
            'prodi', ods.prodi_snapshot,
            'university', ods.university_snapshot,
            'projectKey', ods.project_key,
            'projectName', ods.project_name_snapshot,
            'periodKey', ods.legacy_period_key,
            'period', ods.period_snapshot,
            'participantRole', ods.participant_role,
            'displayOrder', ods.display_order
          ) ORDER BY ods.display_order, ods.id
        ) AS participants
        FROM dc_official_document_students ods
        WHERE ods.document_id = od.id
      ) participant_rows ON TRUE
      WHERE od.id = $1
      LIMIT 1
      `,
      [documentId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Dokumen tidak ditemukan." });
    }

    res.json(mapDocumentRow(result.rows[0], true));
  })
);

router.get(
  "/operator/definitions",
  requireRoleStrict(["operator"]),
  asyncHandler(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || "").trim().toLowerCase() === "true";
    const result = await query(
      `
      SELECT id, type_code, type_name, name, document_purpose, request_mode,
             activity_type, can_be_collective, requires_project, requires_period, is_active
      FROM dc_document_definitions
      WHERE ($1::boolean = TRUE OR is_active = TRUE)
      ORDER BY type_code ASC, name ASC, id ASC
      `,
      [includeInactive]
    );

    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        typeCode: row.type_code,
        typeName: row.type_name,
        name: row.name,
        documentPurpose: row.document_purpose,
        requestMode: row.request_mode,
        activityType: row.activity_type || null,
        canBeCollective: row.can_be_collective,
        requiresProject: row.requires_project,
        requiresPeriod: row.requires_period,
        isActive: row.is_active
      }))
    });
  })
);

module.exports = router;
