const crypto = require("crypto");
const fs = require("fs/promises");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { pool } = require("../db/pool");
const { requireSafeId, requireEnum, parseBoundedLimit, parseBoundedOffset } = require("./securityValidation");
const { buildStudentKey } = require("./documentCenterIdentity");
const {
  STAGING_ROOT,
  buildStagingFilePath,
  buildVersionStorageKey,
  buildVersionFilePath,
  getVersionDirectory,
  buildTemplateStorageKey,
  buildTemplateFilePath,
  getTemplateDirectory,
  openPrivateTemplateVersion
} = require("./documentCenterStorage");

const PAGE_WIDTH = 842.25;
const PAGE_HEIGHT = 595.5;
const MAX_TEMPLATE_PDF_BYTES = 8 * 1024 * 1024;
const TEMPLATE_KEYS = ["certificate_completed_internship", "certificate_completed_research"];
const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const CONTENT_CONFIG = {
  organizationLabel: "CoE STAS-RG",
  issuedCity: "Bandung",
  signerPosition: "Ketua CoE STAS-RG",
  signerName: "Giva Andriana Mutiara., S.T., M.T., Ph.D.",
  signerEmployeeNumber: "14760020"
};

const PRESETS = {
  certificate_completed_internship: {
    templateKey: "certificate_completed_internship",
    activityType: "Magang",
    activityOutcome: "completed",
    layout: {
      number: { x: 126, y: 278, width: 150, fontSize: 10 },
      name: { x: 315, y: 207, width: 430, fontSize: 23, minFontSize: 12 },
      paragraph: { x: 390, y: 325, width: 390, fontSize: 14, minFontSize: 11, lineHeight: 19, maxLines: 4 },
      date: { x: 150, y: 422, width: 260, fontSize: 11 },
      signerPosition: { x: 150, y: 444, width: 260, fontSize: 10 },
      signerName: { x: 150, y: 518, width: 300, fontSize: 9 },
      signerEmployeeNumber: { x: 150, y: 537, width: 260, fontSize: 10 }
    }
  },
  certificate_completed_research: {
    templateKey: "certificate_completed_research",
    activityType: "Riset",
    activityOutcome: "completed",
    layout: {
      number: { x: 126, y: 278, width: 150, fontSize: 10 },
      name: { x: 315, y: 207, width: 430, fontSize: 23, minFontSize: 12 },
      paragraph: { x: 390, y: 325, width: 390, fontSize: 14, minFontSize: 11, lineHeight: 19, maxLines: 4 },
      date: { x: 150, y: 422, width: 260, fontSize: 11 },
      signerPosition: { x: 150, y: 444, width: 260, fontSize: 10 },
      signerName: { x: 150, y: 518, width: 300, fontSize: 9 },
      signerEmployeeNumber: { x: 150, y: 537, width: 260, fontSize: 10 }
    }
  }
};

function httpError(statusCode, message, field = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  return error;
}

function requirePlainObject(value, label = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Input tidak valid.", label);
  return value;
}

function rejectUnexpectedFields(value, allowed, label = "body") {
  for (const key of Object.keys(value || {})) if (!allowed.has(key)) throw httpError(400, "Input tidak valid.", `${label}.${key}`);
}

function sanitizeFilename(value) {
  const name = String(value || "").replace(/\\/g, "/").split("/").pop().trim();
  const cleaned = name.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 160);
  if (!cleaned || !/\.pdf$/i.test(cleaned)) throw httpError(400, "File harus PDF.", "fileName");
  return cleaned;
}

function decodePdfDataUrl(value) {
  if (typeof value !== "string") throw httpError(400, "File harus PDF.", "fileDataUrl");
  const prefix = "data:application/pdf;base64,";
  if (!value.startsWith(prefix)) throw httpError(400, "File harus PDF.", "fileDataUrl");
  const payload = value.slice(prefix.length);
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > MAX_TEMPLATE_PDF_BYTES) throw httpError(400, "Ukuran PDF melebihi batas.", "fileDataUrl");
  if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  return buffer;
}

async function validateLandscapePdf(buffer) {
  let pdf;
  try {
    pdf = await PDFDocument.load(buffer);
  } catch (_) {
    throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  }
  if (pdf.getPageCount() !== 1) throw httpError(400, "Template harus satu halaman.", "fileDataUrl");
  const page = pdf.getPage(0);
  const { width, height } = page.getSize();
  if (Math.abs(width - PAGE_WIDTH) > 0.1 || Math.abs(height - PAGE_HEIGHT) > 0.1) {
    throw httpError(400, "Template harus A4 landscape.", "fileDataUrl");
  }
  return { width, height };
}

function mapTemplateRow(row) {
  return {
    id: row.id,
    documentDefinitionId: row.document_definition_id,
    templateKey: row.template_key,
    name: row.name,
    activityType: row.activity_type,
    activityOutcome: row.activity_outcome,
    status: row.status,
    activeVersionId: row.active_version_id,
    activeVersionNumber: row.active_version_number == null ? null : Number(row.active_version_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTemplateVersion(row) {
  return {
    id: row.id,
    versionNumber: Number(row.version_number),
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    checksumSha256: row.checksum_sha256,
    pageWidth: Number(row.page_width),
    pageHeight: Number(row.page_height),
    createdAt: row.created_at
  };
}

async function listTemplates(query = {}) {
  const limit = parseBoundedLimit(query.limit, 50, 100);
  const offset = parseBoundedOffset(query.offset, 0, 10000);
  const params = [];
  const predicates = [];
  const templateKey = requireEnum(query.templateKey, TEMPLATE_KEYS, "templateKey");
  if (templateKey) {
    params.push(templateKey);
    predicates.push(`t.template_key = $${params.length}`);
  }
  const status = requireEnum(query.status, ["draft", "active", "inactive"], "status");
  if (status) {
    params.push(status);
    predicates.push(`t.status = $${params.length}`);
  }
  const activityType = requireEnum(query.activityType, ["Magang", "Riset"], "activityType");
  if (activityType) {
    params.push(activityType);
    predicates.push(`t.activity_type = $${params.length}`);
  }
  const activityOutcome = requireEnum(query.activityOutcome, ["completed"], "activityOutcome");
  if (activityOutcome) {
    params.push(activityOutcome);
    predicates.push(`t.activity_outcome = $${params.length}`);
  }
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  params.push(limit, offset);
  const result = await pool.query(
    `
    SELECT COUNT(*) OVER()::int AS total_count,
           t.*, v.version_number AS active_version_number
    FROM dc_document_templates t
    LEFT JOIN dc_document_template_versions v ON v.id = t.active_version_id
    ${where}
    ORDER BY t.template_key ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );
  return {
    items: result.rows.map(mapTemplateRow),
    pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 }
  };
}

async function detailTemplate(id) {
  const templateId = requireSafeId(id, "id");
  const result = await pool.query(
    `
    SELECT t.*, av.version_number AS active_version_number
    FROM dc_document_templates t
    LEFT JOIN dc_document_template_versions av ON av.id = t.active_version_id
    WHERE t.id = $1
    LIMIT 1
    `,
    [templateId]
  );
  if (!result.rowCount) throw httpError(404, "Template tidak ditemukan.");
  const versions = await pool.query(
    `
    SELECT id, version_number, original_filename, mime_type, file_size,
           checksum_sha256, page_width, page_height, created_at
    FROM dc_document_template_versions
    WHERE document_template_id = $1
    ORDER BY version_number DESC
    `,
    [templateId]
  );
  return { ...mapTemplateRow(result.rows[0]), versions: versions.rows.map(mapTemplateVersion) };
}

async function insertAudit(client, { authUser, ip, event, target = "document_center_template", detail }) {
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
     VALUES ($1, $2, 'Operator', 'Create', $3, $4, $5::jsonb)`,
    [`AUD-DC-${crypto.randomUUID()}`, authUser?.id || null, target, ip || null, JSON.stringify({ module: "document_center", event, ...detail })]
  );
}

async function uploadTemplateVersion({ id, body, authUser, ip }) {
  const templateId = requireSafeId(id, "id");
  const payload = requirePlainObject(body);
  rejectUnexpectedFields(payload, new Set(["fileName", "fileDataUrl"]));
  const originalFilename = sanitizeFilename(payload.fileName);
  const buffer = decodePdfDataUrl(payload.fileDataUrl);
  await validateLandscapePdf(buffer);
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  const stagingPath = buildStagingFilePath(`${crypto.randomUUID()}.pdf`);
  let finalPath = null;
  let client;
  let committed = false;
  let moved = false;
  try {
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, buffer, { flag: "wx" });
    client = await pool.connect();
    await client.query("BEGIN");
    const templateResult = await client.query("SELECT * FROM dc_document_templates WHERE id=$1 FOR UPDATE", [templateId]);
    if (!templateResult.rowCount) throw httpError(404, "Template tidak ditemukan.");
    const template = templateResult.rows[0];
    const preset = PRESETS[template.template_key];
    if (!preset) throw httpError(409, "Template tidak didukung.");
    const versionResult = await client.query("SELECT COALESCE(MAX(version_number), 0)::int + 1 AS next_version FROM dc_document_template_versions WHERE document_template_id=$1", [templateId]);
    const versionNumber = Number(versionResult.rows[0].next_version);
    const versionId = `DCTPLVER-${crypto.randomUUID()}`;
    const storageKey = buildTemplateStorageKey(templateId, versionNumber);
    finalPath = buildTemplateFilePath(templateId, versionNumber);
    await client.query(
      `
      INSERT INTO dc_document_template_versions (
        id, document_template_id, version_number, storage_key, original_filename,
        mime_type, file_size, checksum_sha256, page_width, page_height,
        layout_config, content_config, created_by_user_id
      )
      VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
      `,
      [
        versionId, templateId, versionNumber, storageKey, originalFilename,
        buffer.length, checksum, PAGE_WIDTH, PAGE_HEIGHT,
        JSON.stringify(preset.layout), JSON.stringify(CONTENT_CONFIG), operatorUserId
      ]
    );
    await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "document_template_version_uploaded", detail: { templateId, versionId, versionNumber } });
    await fs.mkdir(getTemplateDirectory(templateId), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    moved = true;
    await client.query("COMMIT");
    committed = true;
    return await detailTemplate(templateId);
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (!committed && moved && finalPath) await fs.unlink(finalPath).catch(() => {});
    await fs.unlink(stagingPath).catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function activateTemplateVersion({ id, body, authUser, ip }) {
  const templateId = requireSafeId(id, "id");
  const payload = requirePlainObject(body);
  rejectUnexpectedFields(payload, new Set(["versionId"]));
  const versionId = requireSafeId(payload.versionId, "versionId");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const template = await client.query("SELECT * FROM dc_document_templates WHERE id=$1 FOR UPDATE", [templateId]);
    if (!template.rowCount) throw httpError(404, "Template tidak ditemukan.");
    const version = await client.query("SELECT * FROM dc_document_template_versions WHERE id=$1 AND document_template_id=$2", [versionId, templateId]);
    if (!version.rowCount) throw httpError(404, "Versi template tidak ditemukan.");
    await client.query("UPDATE dc_document_templates SET active_version_id=$2, status='active', updated_at=NOW() WHERE id=$1", [templateId, versionId]);
    await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "document_template_version_activated", detail: { templateId, versionId, versionNumber: version.rows[0].version_number } });
    await client.query("COMMIT");
    return await detailTemplate(templateId);
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

function topY(y, fontSize) {
  return PAGE_HEIGHT - y - fontSize;
}

function drawCenteredText(page, text, box, font, fontSize) {
  const value = String(text || "");
  const width = font.widthOfTextAtSize(value, fontSize);
  page.drawText(value, {
    x: box.x + Math.max(0, (box.width - width) / 2),
    y: topY(box.y, fontSize),
    size: fontSize,
    font,
    color: rgb(0, 0, 0)
  });
}

function measureSegments(segments, fonts, size) {
  return segments.reduce((sum, segment) => sum + fonts[segment.bold ? "bold" : "regular"].widthOfTextAtSize(segment.text, size), 0);
}

function wrapRichSegments(segments, fonts, size, maxWidth) {
  const words = [];
  for (const segment of segments) {
    const parts = String(segment.text || "").split(/(\s+)/).filter(Boolean);
    for (const part of parts) words.push({ text: part, bold: segment.bold });
  }
  const lines = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word];
    if (current.length && measureSegments(candidate, fonts, size) > maxWidth) {
      lines.push(current);
      current = [word.text.trim() ? word : { ...word, text: word.text.trimStart() }];
    } else {
      current = candidate;
    }
  }
  if (current.length) lines.push(current);
  return lines.map((line) => {
    const trimmed = [...line];
    while (trimmed.length && !trimmed[0].text.trim()) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1].text.trim()) trimmed.pop();
    return trimmed;
  }).filter((line) => line.length);
}

function buildParagraphSegments(data) {
  const projectTitle = data.projectTitle || "proyek/kegiatan";
  const role = data.projectRole || (data.activityType === "Riset" ? "anggota riset" : "peserta magang");
  return [
    { text: "Telah menyelesaikan kegiatan pada ", bold: false },
    { text: CONTENT_CONFIG.organizationLabel, bold: true },
    { text: " sebagai ", bold: false },
    { text: role, bold: true },
    { text: " dalam proyek ", bold: false },
    { text: projectTitle, bold: true },
    { text: ` periode ${data.periodLabel}.`, bold: false }
  ];
}

function formatDateId(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getDate()} ${MONTHS_ID[date.getMonth()]} ${date.getFullYear()}`;
}

async function renderCertificatePdf({ backgroundBytes, templateKey, data, documentNumber = null, issuedAt = null }) {
  const preset = PRESETS[templateKey];
  if (!preset) throw httpError(409, "Template tidak didukung.");
  const pdf = await PDFDocument.load(backgroundBytes);
  const page = pdf.getPage(0);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fonts = { regular, bold };
  const layout = preset.layout;
  drawCenteredText(page, documentNumber || "NOMOR DOKUMEN SAAT PUBLISH", layout.number, regular, layout.number.fontSize);
  const name = String(data.studentName || "").toUpperCase();
  let nameSize = layout.name.fontSize;
  while (nameSize > layout.name.minFontSize && bold.widthOfTextAtSize(name, nameSize) > layout.name.width) nameSize -= 1;
  if (bold.widthOfTextAtSize(name, nameSize) > layout.name.width) throw httpError(409, "Nama peserta terlalu panjang untuk template.");
  drawCenteredText(page, name, layout.name, bold, nameSize);

  const paragraph = layout.paragraph;
  let paragraphSize = paragraph.fontSize;
  let lines = wrapRichSegments(buildParagraphSegments(data), fonts, paragraphSize, paragraph.width);
  while ((lines.length > paragraph.maxLines || lines.some((line) => measureSegments(line, fonts, paragraphSize) > paragraph.width)) && paragraphSize > paragraph.minFontSize) {
    paragraphSize -= 1;
    lines = wrapRichSegments(buildParagraphSegments(data), fonts, paragraphSize, paragraph.width);
  }
  if (lines.length > paragraph.maxLines || lines.some((line) => measureSegments(line, fonts, paragraphSize) > paragraph.width)) {
    throw httpError(409, "Paragraf sertifikat melebihi ruang template.");
  }
  lines.forEach((line, index) => {
    const lineWidth = measureSegments(line, fonts, paragraphSize);
    let x = paragraph.x + Math.max(0, (paragraph.width - lineWidth) / 2);
    const y = topY(paragraph.y + index * paragraph.lineHeight, paragraphSize);
    for (const segment of line) {
      const font = segment.bold ? bold : regular;
      page.drawText(segment.text, { x, y, size: paragraphSize, font, color: rgb(0, 0, 0) });
      x += font.widthOfTextAtSize(segment.text, paragraphSize);
    }
  });

  const dateText = issuedAt ? `${CONTENT_CONFIG.issuedCity}, ${formatDateId(issuedAt)}` : `${CONTENT_CONFIG.issuedCity}, TANGGAL TERBIT`;
  drawCenteredText(page, dateText, layout.date, regular, layout.date.fontSize);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function loadTemplateVersionForPreview(templateId, versionId = null) {
  const params = [templateId];
  const versionPredicate = versionId ? "AND v.id = $2" : "AND v.id = t.active_version_id";
  if (versionId) params.push(versionId);
  const result = await pool.query(
    `
    SELECT t.*, v.id AS version_id, v.version_number, v.storage_key, v.mime_type, v.file_size
    FROM dc_document_templates t
    JOIN dc_document_template_versions v ON v.document_template_id = t.id
    WHERE t.id = $1 ${versionPredicate}
    LIMIT 1
    `,
    params
  );
  if (!result.rowCount) throw httpError(404, "Versi template tidak ditemukan.");
  return result.rows[0];
}

async function previewTemplate({ id, body }) {
  const templateId = requireSafeId(id, "id");
  let versionId = null;
  if (body && Object.keys(body).length) {
    const payload = requirePlainObject(body);
    rejectUnexpectedFields(payload, new Set(["versionId"]));
    versionId = payload.versionId ? requireSafeId(payload.versionId, "versionId") : null;
  }
  const version = await loadTemplateVersionForPreview(templateId, versionId);
  const opened = await openPrivateTemplateVersion({ storageKey: version.storage_key, mimeType: version.mime_type, fileSize: Number(version.file_size) });
  try {
    const bytes = await opened.handle.readFile();
    return await renderCertificatePdf({
      backgroundBytes: bytes,
      templateKey: version.template_key,
      data: {
        studentName: "Nama Mahasiswa",
        activityType: version.activity_type,
        periodLabel: "1 Januari 2026 sampai 30 Juni 2026",
        projectTitle: "Judul Proyek Contoh",
        projectRole: version.activity_type === "Riset" ? "anggota riset" : "peserta magang"
      },
      documentNumber: "13.001/STASRG/I/2026",
      issuedAt: new Date("2026-01-15T00:00:00Z")
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function loadActiveTemplateForCertificate(client, { definitionId, activityType, outcome }) {
  const templateKey = activityType === "Magang" ? "certificate_completed_internship" : "certificate_completed_research";
  const result = await client.query(
    `
    SELECT t.*, v.id AS version_id, v.version_number, v.storage_key, v.mime_type, v.file_size
    FROM dc_document_templates t
    JOIN dc_document_template_versions v ON v.id = t.active_version_id
    WHERE t.document_definition_id = $1
      AND t.template_key = $2
      AND t.activity_type = $3
      AND t.activity_outcome = $4
      AND t.status = 'active'
    LIMIT 1
    `,
    [definitionId, templateKey, activityType, outcome]
  );
  if (!result.rowCount) throw httpError(409, "Template sertifikat aktif belum tersedia.");
  return result.rows[0];
}

function periodLabel(period) {
  if (!period) return "-";
  return `${formatDateId(period.startDate)} sampai ${formatDateId(period.endDate)}`;
}

function buildCertificateData(caseRow, projectRow) {
  return {
    studentName: caseRow.student_snapshot?.name || caseRow.legacy_student_id,
    activityType: caseRow.activity_type,
    periodLabel: periodLabel(caseRow.period_snapshot),
    projectTitle: projectRow.project_snapshot?.title || projectRow.project_snapshot?.name || projectRow.legacy_project_id,
    projectRole: caseRow.activity_type === "Riset" ? "anggota riset" : "peserta magang"
  };
}

function signerSnapshot() {
  return {
    position: CONTENT_CONFIG.signerPosition,
    name: CONTENT_CONFIG.signerName,
    employeeNumber: CONTENT_CONFIG.signerEmployeeNumber
  };
}

async function generateCertificateDraft({ id, authUser, ip }) {
  const caseProjectId = requireSafeId(id, "id");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  const documentId = `DCDOC-${crypto.randomUUID()}`;
  const versionId = `DCVER-${crypto.randomUUID()}`;
  const stagingPath = buildStagingFilePath(`${crypto.randomUUID()}.pdf`);
  const finalPath = buildVersionFilePath(documentId, 1);
  const storageKey = buildVersionStorageKey(documentId, 1);
  let client;
  let moved = false;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const projectResult = await client.query(
      `
      SELECT cp.*, c.legacy_student_id, c.student_key, c.student_snapshot, c.activity_type,
             c.period_key, c.period_snapshot, c.outcome, c.case_status
      FROM dc_final_activity_case_projects cp
      JOIN dc_final_activity_cases c ON c.id = cp.final_activity_case_id
      WHERE cp.id=$1
      FOR UPDATE OF cp, c
      `,
      [caseProjectId]
    );
    if (!projectResult.rowCount) throw httpError(404, "Project case tidak ditemukan.");
    const row = projectResult.rows[0];
    if (row.outcome !== "completed" || !["Magang", "Riset"].includes(row.activity_type) || row.certificate_required !== true || row.certificate_status !== "pending" || row.certificate_document_id || row.case_status === "revoked") {
      throw httpError(409, "Sertifikat tidak dapat dibuatkan draft generator.");
    }
    const template = await loadActiveTemplateForCertificate(client, { definitionId: row.certificate_document_definition_id, activityType: row.activity_type, outcome: row.outcome });
    const opened = await openPrivateTemplateVersion({ storageKey: template.storage_key, mimeType: template.mime_type, fileSize: Number(template.file_size) });
    let pdfBuffer;
    try {
      const background = await opened.handle.readFile();
      pdfBuffer = await renderCertificatePdf({ backgroundBytes: background, templateKey: template.template_key, data: buildCertificateData(row, row) });
    } finally {
      await opened.handle.close().catch(() => {});
    }
    const versionSnapshot = {
      generator: "certificate_template_v1",
      template: { id: template.id, key: template.template_key, versionId: template.version_id, versionNumber: template.version_number },
      student: row.student_snapshot,
      period: row.period_snapshot,
      project: row.project_snapshot,
      certificateData: buildCertificateData(row, row)
    };
    const documentSnapshot = {
      generator: "certificate_template_v1",
      definitionId: row.certificate_document_definition_id,
      activityType: row.activity_type,
      activityOutcome: row.outcome,
      caseId: row.final_activity_case_id,
      caseProjectId
    };
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, pdfBuffer, { flag: "wx" });
    await client.query(
      `
      INSERT INTO dc_official_documents (
        id, document_definition_id, source_request_id, generation_key,
        document_number, title, status, generated_from, activity_outcome,
        snapshot_data, current_version_number
      )
      VALUES ($1,$2,NULL,$3,NULL,$4,'draft','alumni_sync',$5,$6::jsonb,1)
      `,
      [
        documentId,
        row.certificate_document_definition_id,
        `CERT:${row.student_key}:${row.project_key}:${row.final_activity_case_id}:${row.outcome}`,
        `Sertifikat - ${row.student_snapshot?.name || row.legacy_student_id}`,
        row.outcome,
        JSON.stringify(documentSnapshot)
      ]
    );
    await client.query(
      `
      INSERT INTO dc_document_versions (
        id, document_id, version_number, storage_key, original_filename,
        download_filename, mime_type, file_size, checksum_sha256,
        signer_snapshot, snapshot_data, version_reason, template_version_id
      )
      VALUES ($1,$2,1,$3,$4,$5,'application/pdf',$6,$7,$8::jsonb,$9::jsonb,'initial_issue',$10)
      `,
      [
        versionId, documentId, storageKey, `${documentId}-draft.pdf`, `${documentId}-v1.pdf`,
        pdfBuffer.length, crypto.createHash("sha256").update(pdfBuffer).digest("hex"),
        JSON.stringify(signerSnapshot()), JSON.stringify(versionSnapshot), template.version_id
      ]
    );
    await client.query(
      `
      INSERT INTO dc_official_document_students (
        id, document_id, student_key, legacy_student_id, legacy_project_id,
        legacy_period_key, project_key, name_snapshot, nim_snapshot,
        prodi_snapshot, university_snapshot, project_name_snapshot,
        period_snapshot, participant_role, display_order
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Peserta',0)
      `,
      [
        `DCPART-${crypto.randomUUID()}`, documentId, row.student_key || buildStudentKey(row.legacy_student_id),
        row.legacy_student_id, row.legacy_project_id, row.period_key, row.project_key,
        row.student_snapshot?.name || null, row.student_snapshot?.nim || null,
        row.student_snapshot?.prodi || null, row.student_snapshot?.university || null,
        row.project_snapshot?.title || row.project_snapshot?.name || null,
        row.period_snapshot
      ]
    );
    await client.query("UPDATE dc_final_activity_case_projects SET certificate_document_id=$2, certificate_status='draft_created', updated_at=NOW() WHERE id=$1", [caseProjectId, documentId]);
    await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "final_activity_certificate_generated_draft", target: "document_center_final_activity", detail: { caseProjectId, caseId: row.final_activity_case_id, documentId, templateVersionId: template.version_id } });
    await fs.mkdir(getVersionDirectory(documentId), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    moved = true;
    await client.query("COMMIT");
    committed = true;
    return { document: { id: documentId, status: "draft", currentVersionNumber: 1, canDownload: false }, caseProjectId };
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (!committed && moved) await fs.unlink(finalPath).catch(() => {});
    await fs.unlink(stagingPath).catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function renderPublishedCertificateVersion({ client, document, documentNumber, issuedAt }) {
  if (!document.template_version_id) return null;
  const templateResult = await client.query(
    `
    SELECT t.template_key, v.id AS version_id, v.storage_key, v.mime_type, v.file_size
    FROM dc_document_template_versions v
    JOIN dc_document_templates t ON t.id = v.document_template_id
    WHERE v.id=$1
    LIMIT 1
    `,
    [document.template_version_id]
  );
  if (!templateResult.rowCount) throw httpError(409, "Template dokumen tidak tersedia.");
  const template = templateResult.rows[0];
  const opened = await openPrivateTemplateVersion({ storageKey: template.storage_key, mimeType: template.mime_type, fileSize: Number(template.file_size) });
  try {
    const background = await opened.handle.readFile();
    const snapshot = document.version_snapshot_data || {};
    const pdfBuffer = await renderCertificatePdf({
      backgroundBytes: background,
      templateKey: template.template_key,
      data: snapshot.certificateData || {},
      documentNumber,
      issuedAt
    });
    return { pdfBuffer, templateVersionId: template.version_id, signer: signerSnapshot(), snapshotData: { ...snapshot, publishedDocumentNumber: documentNumber, publishedAt: issuedAt } };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

module.exports = {
  listTemplates,
  detailTemplate,
  uploadTemplateVersion,
  activateTemplateVersion,
  previewTemplate,
  generateCertificateDraft,
  renderPublishedCertificateVersion
};
