const crypto = require("crypto");
const fs = require("fs/promises");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
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

const TEMPLATE_KEY = "completion_letter_completed_internship";
const TEMPLATE_ID = "DCTPL-COMPLETE-MAGANG-01";
const DEFINITION_ID = "DCDEF-COMPLETE-NORMAL-01";
const PAGE_WIDTH = 595.32;
const PAGE_HEIGHT = 841.92;
const MAX_TEMPLATE_PDF_BYTES = 8 * 1024 * 1024;
const OVERFLOW_MESSAGE = "Data proyek atau identitas terlalu panjang untuk dimuat pada template. Periksa data lalu coba kembali.";
const MONTHS_ID = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const CONTENT_CONFIG = Object.freeze({
  issuedCity: "Bandung",
  organizationLabel: "CoE STAS-RG",
  universityName: "Universitas Telkom",
  employeeNumberLabel: "NIP",
  signerName: "Giva Andriana Mutiara, S.T., M.T., Ph.D.",
  signerEmployeeNumber: "14760020",
  signerPositionLong: "Ketua Center of Excellence Smart Technology and Applied Sciences - The Rapid Research Generator (CoE STAS-RG)",
  signerPositionShort: "Ketua CoE STAS-RG"
});

const LAYOUT_CONFIG = Object.freeze({
  page: { width: PAGE_WIDTH, height: PAGE_HEIGHT, orientation: "portrait", pageSize: "A4" },
  number: { x: 241, y: 126, width: 285, fontSize: 10.5, minFontSize: 8 },
  studentName: { x: 135, y: 302, width: 390, fontSize: 10.5, minFontSize: 8 },
  studentNim: { x: 135, y: 319, width: 390, fontSize: 10.5, minFontSize: 8 },
  studyProgram: { x: 135, y: 336, width: 390, fontSize: 10.5, minFontSize: 8 },
  activityParagraph: { x: 57, y: 383, width: 482, fontSize: 10.5, minFontSize: 8.5, lineHeight: 15, maxLines: 5 },
  closingCover: { x: 54, y: 445, width: 490, height: 45 },
  closing: { x: 57, y: 450, width: 482, fontSize: 10.5, minFontSize: 9, lineHeight: 15, maxLines: 2 },
  issuedDate: { x: 57, y: 508, width: 300, fontSize: 10.5, minFontSize: 8.5 },
  protectedSignatureFooter: { top: 527, bottom: 842 },
  maximumPageHeight: PAGE_HEIGHT,
  placeholderAllowlist: [
    "document_number", "student_name", "student_nim", "study_program",
    "university_name", "project_title", "project_role", "period_start",
    "period_end", "issued_city", "issued_date"
  ]
});

function httpError(statusCode, message, field = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  return error;
}

function overflowError() {
  return httpError(422, OVERFLOW_MESSAGE);
}

function requirePlainObject(value, label = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "Input tidak valid.", label);
  return value;
}

function rejectUnexpectedFields(value, allowed, label = "body") {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw httpError(400, "Input tidak valid.", `${label}.${key}`);
  }
}

function ensureEmptyBody(body) {
  if (body == null) return;
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
    throw httpError(400, "Input tidak valid.");
  }
}

function requiredText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) throw httpError(409, "Data dokumen akhir belum lengkap.");
  return normalized;
}

function requireIsoDate(value) {
  const normalized = requiredText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw httpError(409, "Data periode belum lengkap atau tidak valid.");
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw httpError(409, "Data periode belum lengkap atau tidak valid.");
  }
  return normalized;
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
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  }
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.length > MAX_TEMPLATE_PDF_BYTES) throw httpError(400, "Ukuran PDF melebihi batas.", "fileDataUrl");
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  return buffer;
}

async function validatePortraitPdf(buffer) {
  let pdf;
  try {
    pdf = await PDFDocument.load(buffer);
  } catch (_) {
    throw httpError(400, "File PDF tidak valid.", "fileDataUrl");
  }
  if (pdf.getPageCount() !== 1) throw httpError(400, "Template harus satu halaman.", "fileDataUrl");
  const { width, height } = pdf.getPage(0).getSize();
  if (Math.abs(width - PAGE_WIDTH) > 0.2 || Math.abs(height - PAGE_HEIGHT) > 0.2) {
    throw httpError(400, "Template harus A4 portrait.", "fileDataUrl");
  }
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT };
}

async function getTemplateKey(templateId) {
  const result = await pool.query("SELECT template_key FROM dc_document_templates WHERE id=$1 LIMIT 1", [templateId]);
  if (!result.rowCount) throw httpError(404, "Template tidak ditemukan.");
  return result.rows[0].template_key;
}

async function insertAudit(client, { authUser, ip, event, target = "document_center_template", detail }) {
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
     VALUES ($1, $2, 'Operator', 'Create', $3, $4, $5::jsonb)`,
    [`AUD-DC-${crypto.randomUUID()}`, authUser?.id || null, target, ip || null, JSON.stringify({ module: "document_center", event, ...detail })]
  );
}

async function uploadCompletionTemplateVersion({ id, body, authUser, ip }) {
  const templateId = requireSafeId(id, "id");
  const payload = requirePlainObject(body);
  rejectUnexpectedFields(payload, new Set(["fileName", "fileDataUrl"]));
  const originalFilename = sanitizeFilename(payload.fileName);
  const buffer = decodePdfDataUrl(payload.fileDataUrl);
  await validatePortraitPdf(buffer);
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
    if (templateResult.rows[0].template_key !== TEMPLATE_KEY) throw httpError(409, "Template tidak didukung.");
    const next = await client.query(
      "SELECT COALESCE(MAX(version_number), 0)::int + 1 AS value FROM dc_document_template_versions WHERE document_template_id=$1",
      [templateId]
    );
    const versionNumber = Number(next.rows[0].value);
    const versionId = `DCTPLVER-${crypto.randomUUID()}`;
    const storageKey = buildTemplateStorageKey(templateId, versionNumber);
    finalPath = buildTemplateFilePath(templateId, versionNumber);
    await client.query(
      `INSERT INTO dc_document_template_versions (
         id, document_template_id, version_number, storage_key, original_filename,
         mime_type, file_size, checksum_sha256, page_width, page_height,
         layout_config, content_config, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [
        versionId, templateId, versionNumber, storageKey, originalFilename,
        buffer.length, crypto.createHash("sha256").update(buffer).digest("hex"),
        PAGE_WIDTH, PAGE_HEIGHT, JSON.stringify(LAYOUT_CONFIG), JSON.stringify(CONTENT_CONFIG), operatorUserId
      ]
    );
    await insertAudit(client, {
      authUser: { id: operatorUserId }, ip, event: "document_template_version_uploaded",
      detail: { templateId, versionId, versionNumber, templateKey: TEMPLATE_KEY }
    });
    await fs.mkdir(getTemplateDirectory(templateId), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    moved = true;
    await client.query("COMMIT");
    committed = true;
    const { detailTemplate } = require("./documentCenterCertificateTemplates");
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

async function uploadDocumentTemplateVersion(args) {
  const templateId = requireSafeId(args.id, "id");
  const key = await getTemplateKey(templateId);
  if (key === TEMPLATE_KEY) return uploadCompletionTemplateVersion({ ...args, id: templateId });
  const { uploadTemplateVersion } = require("./documentCenterCertificateTemplates");
  return uploadTemplateVersion({ ...args, id: templateId });
}

function topToPdfY(top, fontSize) {
  return PAGE_HEIGHT - top - fontSize;
}

function formatDateId(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(409, "Tanggal dokumen tidak valid.");
  return `${date.getUTCDate()} ${MONTHS_ID[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function formatPeriodLabel(periodSnapshot) {
  const activityType = requiredText(periodSnapshot?.activityType);
  const startDate = formatDateId(`${requireIsoDate(periodSnapshot?.startDate)}T00:00:00Z`);
  const endDate = formatDateId(`${requireIsoDate(periodSnapshot?.endDate)}T00:00:00Z`);
  return `${activityType} | ${startDate} - ${endDate}`;
}

function wrapText(text, font, size, maxWidth) {
  const paragraphs = String(text || "").split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function fitSingleLine(text, font, box) {
  let size = box.fontSize;
  while (size > box.minFontSize && font.widthOfTextAtSize(text, size) > box.width) size -= 0.5;
  if (font.widthOfTextAtSize(text, size) > box.width) throw overflowError();
  return size;
}

function fitWrappedText(text, font, box) {
  let size = box.fontSize;
  let lines = wrapText(text, font, size, box.width);
  while (size > box.minFontSize && (lines.length > box.maxLines || lines.some((line) => font.widthOfTextAtSize(line, size) > box.width))) {
    size -= 0.5;
    lines = wrapText(text, font, size, box.width);
  }
  if (lines.length > box.maxLines || lines.some((line) => font.widthOfTextAtSize(line, size) > box.width)) throw overflowError();
  return { size, lines };
}

function drawSingleLine(page, text, font, box) {
  const value = requiredText(text);
  const size = fitSingleLine(value, font, box);
  page.drawText(value, { x: box.x, y: topToPdfY(box.y, size), size, font, color: rgb(0, 0, 0) });
}

function drawWrapped(page, text, font, box) {
  const { size, lines } = fitWrappedText(requiredText(text), font, box);
  const endTop = box.y + ((lines.length - 1) * box.lineHeight) + size;
  if (endTop >= LAYOUT_CONFIG.protectedSignatureFooter.top) throw overflowError();
  lines.forEach((line, index) => {
    page.drawText(line, {
      x: box.x,
      y: topToPdfY(box.y + index * box.lineHeight, size),
      size,
      font,
      color: rgb(0, 0, 0)
    });
  });
}

function buildLetterData({ studentSnapshot, periodSnapshot, projectSnapshot }) {
  const studentName = requiredText(studentSnapshot?.name);
  const studentNim = requiredText(studentSnapshot?.nim);
  const studyProgram = requiredText(studentSnapshot?.prodi);
  const periodStart = requireIsoDate(periodSnapshot?.startDate);
  const periodEnd = requireIsoDate(periodSnapshot?.endDate);
  if (periodStart > periodEnd) throw httpError(409, "Data periode belum lengkap atau tidak valid.");
  const projectTitle = requiredText(projectSnapshot?.title);
  const projectRole = requiredText(projectSnapshot?.role);
  return {
    studentName,
    studentNim,
    studyProgram,
    universityName: CONTENT_CONFIG.universityName,
    projectTitle,
    projectRole,
    periodStart,
    periodEnd
  };
}

function buildActivityParagraph(data) {
  return `Berdasarkan Surat Penerimaan Magang, yang bersangkutan telah melaksanakan kegiatan magang di ${CONTENT_CONFIG.organizationLabel} sebagai bagian dari proyek "${data.projectTitle}" dengan peran sebagai ${data.projectRole}, terhitung sejak ${formatDateId(`${data.periodStart}T00:00:00Z`)} sampai dengan ${formatDateId(`${data.periodEnd}T00:00:00Z`)}.`;
}

function signerSnapshot() {
  return {
    position: CONTENT_CONFIG.signerPositionShort,
    positionLong: CONTENT_CONFIG.signerPositionLong,
    name: CONTENT_CONFIG.signerName,
    employeeNumberLabel: CONTENT_CONFIG.employeeNumberLabel,
    employeeNumber: CONTENT_CONFIG.signerEmployeeNumber
  };
}

async function renderCompletionLetterPdf({ backgroundBytes, data, documentNumber = null, issuedAt = null, preview = false }) {
  let pdf;
  try {
    pdf = await PDFDocument.load(backgroundBytes);
  } catch (_) {
    throw httpError(409, "Template dokumen tidak tersedia.");
  }
  if (pdf.getPageCount() !== 1) throw httpError(409, "Template dokumen tidak tersedia.");
  const page = pdf.getPage(0);
  const { width, height } = page.getSize();
  if (Math.abs(width - PAGE_WIDTH) > 0.2 || Math.abs(height - PAGE_HEIGHT) > 0.2) throw httpError(409, "Template dokumen tidak tersedia.");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const numberText = documentNumber || "Nomor diterbitkan saat dokumen dipublikasikan";
  drawSingleLine(page, numberText, regular, LAYOUT_CONFIG.number);
  drawSingleLine(page, data.studentName, regular, LAYOUT_CONFIG.studentName);
  drawSingleLine(page, data.studentNim, regular, LAYOUT_CONFIG.studentNim);
  drawSingleLine(page, data.studyProgram, regular, LAYOUT_CONFIG.studyProgram);
  drawWrapped(page, buildActivityParagraph(data), regular, LAYOUT_CONFIG.activityParagraph);

  const cover = LAYOUT_CONFIG.closingCover;
  page.drawRectangle({
    x: cover.x,
    y: PAGE_HEIGHT - cover.y - cover.height,
    width: cover.width,
    height: cover.height,
    color: rgb(1, 1, 1)
  });
  drawWrapped(page, "Demikian surat keterangan ini dibuat untuk dipergunakan sebagaimana mestinya.", regular, LAYOUT_CONFIG.closing);

  const issuedText = issuedAt
    ? `${CONTENT_CONFIG.issuedCity}, ${formatDateId(issuedAt)}`
    : `${CONTENT_CONFIG.issuedCity}, Tanggal diterbitkan saat publikasi`;
  drawSingleLine(page, issuedText, preview ? regular : bold, LAYOUT_CONFIG.issuedDate);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function loadUploadedTemplateVersion(clientOrPool, { templateId = TEMPLATE_ID, versionId = null, activeOnly = false }) {
  const params = [templateId];
  let versionPredicate;
  if (versionId) {
    params.push(versionId);
    versionPredicate = "v.id=$2";
  } else if (activeOnly) {
    versionPredicate = "v.id=t.active_version_id AND t.status='active'";
  } else {
    versionPredicate = "v.id=t.active_version_id";
  }
  const result = await clientOrPool.query(
    `SELECT t.id AS template_id, t.template_key, t.document_definition_id,
            t.activity_type, t.activity_outcome, t.status,
            v.id AS version_id, v.version_number, v.storage_key, v.mime_type,
            v.file_size, v.original_filename, v.page_width, v.page_height
     FROM dc_document_templates t
     JOIN dc_document_template_versions v ON ${versionPredicate}
     WHERE t.id=$1 AND t.template_key='completion_letter_completed_internship'
     LIMIT 1`,
    params
  );
  if (!result.rowCount) throw httpError(activeOnly ? 409 : 404, activeOnly ? "Template surat aktif belum tersedia." : "Versi template tidak ditemukan.");
  return result.rows[0];
}

async function openTemplateBytes(version) {
  const opened = await openPrivateTemplateVersion({
    storageKey: version.storage_key,
    mimeType: version.mime_type,
    fileSize: Number(version.file_size)
  });
  return {
    bytes: await opened.handle.readFile(),
    close: () => opened.handle.close().catch(() => {})
  };
}

async function previewCompletionTemplate({ id, body }) {
  const templateId = requireSafeId(id, "id");
  let versionId = null;
  if (body && Object.keys(body).length) {
    const payload = requirePlainObject(body);
    rejectUnexpectedFields(payload, new Set(["versionId"]));
    versionId = payload.versionId ? requireSafeId(payload.versionId, "versionId") : null;
  }
  const version = await loadUploadedTemplateVersion(pool, { templateId, versionId });
  const opened = await openTemplateBytes(version);
  try {
    const data = buildLetterData({
      studentSnapshot: { name: "Muhammad Ramadhan Al Bukhori Putra Nusantara", nim: "123456789012", prodi: "Program Studi Teknologi Rekayasa Multimedia dan Sistem Cerdas" },
      periodSnapshot: { startDate: "2025-09-15", endDate: "2026-01-15" },
      projectSnapshot: { title: "Platform Smart Technology and Applied Sciences untuk Transformasi Industri Berkelanjutan", role: "Embedded System Engineer dan Pengembang Integrasi Perangkat" }
    });
    return await renderCompletionLetterPdf({ backgroundBytes: opened.bytes, data, preview: true });
  } finally {
    await opened.close();
  }
}

async function previewDocumentTemplate(args) {
  const templateId = requireSafeId(args.id, "id");
  const key = await getTemplateKey(templateId);
  if (key === TEMPLATE_KEY) return previewCompletionTemplate({ ...args, id: templateId });
  const { previewTemplate } = require("./documentCenterCertificateTemplates");
  return previewTemplate({ ...args, id: templateId });
}

async function generateCompletionLetterDraft({ id, body, authUser, ip }) {
  ensureEmptyBody(body);
  const caseId = requireSafeId(id, "id");
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
    const caseResult = await client.query("SELECT * FROM dc_final_activity_cases WHERE id=$1 FOR UPDATE", [caseId]);
    if (!caseResult.rowCount) throw httpError(404, "Case tidak ditemukan.");
    const caseRow = caseResult.rows[0];
    if (
      caseRow.activity_type !== "Magang" ||
      caseRow.outcome !== "completed" ||
      caseRow.completion_document_definition_id !== DEFINITION_ID ||
      caseRow.case_status !== "pending" ||
      caseRow.completion_document_id
    ) {
      throw httpError(409, "Case tidak dapat dibuatkan draft surat generator.");
    }
    const projectResult = await client.query(
      "SELECT * FROM dc_final_activity_case_projects WHERE final_activity_case_id=$1 ORDER BY display_order, id FOR SHARE",
      [caseId]
    );
    if (projectResult.rowCount !== 1) throw httpError(409, "Surat hanya dapat dibuat untuk case dengan tepat satu project.");
    const projectRow = projectResult.rows[0];
    const data = buildLetterData({
      studentSnapshot: caseRow.student_snapshot,
      periodSnapshot: caseRow.period_snapshot,
      projectSnapshot: projectRow.project_snapshot
    });
    const template = await loadUploadedTemplateVersion(client, { activeOnly: true });
    if (
      template.document_definition_id !== DEFINITION_ID ||
      template.activity_type !== "Magang" ||
      template.activity_outcome !== "completed"
    ) {
      throw httpError(409, "Template surat aktif belum tersedia.");
    }
    const opened = await openTemplateBytes(template);
    let pdfBuffer;
    try {
      pdfBuffer = await renderCompletionLetterPdf({ backgroundBytes: opened.bytes, data });
    } finally {
      await opened.close();
    }
    const templateSnapshot = {
      id: template.template_id,
      key: TEMPLATE_KEY,
      versionId: template.version_id,
      versionNumber: Number(template.version_number),
      orientation: "portrait",
      pageSize: "A4"
    };
    const versionSnapshot = {
      generator: "completion_letter_template_v1",
      template: templateSnapshot,
      student: caseRow.student_snapshot,
      period: caseRow.period_snapshot,
      project: projectRow.project_snapshot,
      letterData: data,
      content: CONTENT_CONFIG
    };
    const documentSnapshot = {
      generator: "completion_letter_template_v1",
      definitionId: DEFINITION_ID,
      activityType: "Magang",
      activityOutcome: "completed",
      caseId,
      caseProjectId: projectRow.id
    };
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, pdfBuffer, { flag: "wx" });
    await client.query(
      `INSERT INTO dc_official_documents (
         id, document_definition_id, source_request_id, generation_key,
         document_number, title, status, generated_from, activity_outcome,
         snapshot_data, current_version_number
       ) VALUES ($1,$2,NULL,$3,NULL,$4,'draft','alumni_sync','completed',$5::jsonb,1)`,
      [
        documentId, DEFINITION_ID,
        `SKS:${caseRow.student_key}:${caseId}:completed`,
        `Surat Keterangan Selesai Magang - ${data.studentName}`,
        JSON.stringify(documentSnapshot)
      ]
    );
    await client.query(
      `INSERT INTO dc_document_versions (
         id, document_id, version_number, storage_key, original_filename,
         download_filename, mime_type, file_size, checksum_sha256,
         signer_snapshot, snapshot_data, version_reason, template_version_id
       ) VALUES ($1,$2,1,$3,$4,$5,'application/pdf',$6,$7,$8::jsonb,$9::jsonb,'initial_issue',$10)`,
      [
        versionId, documentId, storageKey, `${documentId}-draft.pdf`, `${documentId}-v1.pdf`,
        pdfBuffer.length, crypto.createHash("sha256").update(pdfBuffer).digest("hex"),
        JSON.stringify(signerSnapshot()), JSON.stringify(versionSnapshot), template.version_id
      ]
    );
    await client.query(
      `INSERT INTO dc_official_document_students (
         id, document_id, student_key, legacy_student_id, legacy_project_id,
         legacy_period_key, project_key, name_snapshot, nim_snapshot,
         prodi_snapshot, university_snapshot, project_name_snapshot,
         period_snapshot, participant_role, display_order
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Mahasiswa',0)`,
      [
        `DCPART-${crypto.randomUUID()}`, documentId,
        caseRow.student_key || buildStudentKey(caseRow.legacy_student_id),
        caseRow.legacy_student_id, projectRow.legacy_project_id,
        caseRow.period_key, projectRow.project_key,
        data.studentName, data.studentNim, data.studyProgram,
        data.universityName, data.projectTitle, formatPeriodLabel(caseRow.period_snapshot)
      ]
    );
    const linked = await client.query(
      `UPDATE dc_final_activity_cases
       SET completion_document_id=$2, case_status='draft_created', updated_at=NOW()
       WHERE id=$1 AND case_status='pending' AND completion_document_id IS NULL
       RETURNING id`,
      [caseId, documentId]
    );
    if (!linked.rowCount) throw httpError(409, "Case tidak dapat dibuatkan draft surat generator.");
    await insertAudit(client, {
      authUser: { id: operatorUserId }, ip,
      event: "final_activity_completion_letter_generated_draft",
      target: "document_center_final_activity",
      detail: { caseId, caseProjectId: projectRow.id, documentId, templateVersionId: template.version_id }
    });
    await fs.mkdir(getVersionDirectory(documentId), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    moved = true;
    await client.query("COMMIT");
    committed = true;
    return {
      document: { id: documentId, status: "draft", currentVersionNumber: 1, canDownload: false },
      caseId
    };
  } catch (error) {
    if (client && !committed) await client.query("ROLLBACK").catch(() => {});
    if (!committed && moved) await fs.unlink(finalPath).catch(() => {});
    await fs.unlink(stagingPath).catch(() => {});
    if (error?.code === "23505") throw httpError(409, "Draft surat sudah tersedia.");
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function renderPublishedCompletionLetterVersion({ client, document, documentNumber, issuedAt }) {
  const snapshot = document.version_snapshot_data || {};
  if (snapshot.generator !== "completion_letter_template_v1") return null;
  if (!document.template_version_id || !snapshot.letterData) throw httpError(409, "Template dokumen tidak tersedia.");
  const template = await loadUploadedTemplateVersion(client, { templateId: snapshot.template?.id || TEMPLATE_ID, versionId: document.template_version_id });
  if (template.template_key !== TEMPLATE_KEY) throw httpError(409, "Template dokumen tidak tersedia.");
  const opened = await openTemplateBytes(template);
  try {
    const pdfBuffer = await renderCompletionLetterPdf({
      backgroundBytes: opened.bytes,
      data: snapshot.letterData,
      documentNumber,
      issuedAt
    });
    return {
      kind: "completion_letter",
      auditEvent: "final_activity_completion_letter_generated_final",
      pdfBuffer,
      templateVersionId: template.version_id,
      signer: document.signer_snapshot || signerSnapshot(),
      snapshotData: { ...snapshot, publishedDocumentNumber: documentNumber, publishedAt: issuedAt }
    };
  } finally {
    await opened.close();
  }
}

module.exports = {
  TEMPLATE_KEY,
  TEMPLATE_ID,
  PAGE_WIDTH,
  PAGE_HEIGHT,
  CONTENT_CONFIG,
  LAYOUT_CONFIG,
  validatePortraitPdf,
  uploadCompletionTemplateVersion,
  uploadDocumentTemplateVersion,
  previewCompletionTemplate,
  previewDocumentTemplate,
  generateCompletionLetterDraft,
  renderPublishedCompletionLetterVersion,
  renderCompletionLetterPdf,
  buildLetterData
};
