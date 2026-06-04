const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { query } = require("../db/pool");

const STUDENT_DOCUMENT_UPLOAD_DIR = path.join(__dirname, "../public/uploads/student-documents");
const MAX_STUDENT_DOCUMENT_BYTES = 10 * 1024 * 1024;

const STUDENT_DOCUMENT_TYPES = Object.freeze({
  surat_pengantar: {
    type: "surat_pengantar",
    label: "Surat pengantar mahasiswa riset dan magang CoE STAS-RG",
    requiresAlumni: false,
    order: 1
  },
  surat_penerimaan: {
    type: "surat_penerimaan",
    label: "Surat Penerimaan mahasiswa riset dan magang CoE STAS-RG",
    requiresAlumni: false,
    order: 2
  },
  surat_keterangan_selesai: {
    type: "surat_keterangan_selesai",
    label: "Surat Keterangan Selesai mahasiswa riset dan magang CoE STAS-RG",
    requiresAlumni: true,
    order: 3
  },
  sertifikat: {
    type: "sertifikat",
    label: "Sertifikat",
    requiresAlumni: true,
    order: 4
  }
});

const STUDENT_DOCUMENT_ALIASES = Object.freeze({
  pengantar: "surat_pengantar",
  suratPengantar: "surat_pengantar",
  surat_pengantar: "surat_pengantar",
  penerimaan: "surat_penerimaan",
  suratPenerimaan: "surat_penerimaan",
  surat_penerimaan: "surat_penerimaan",
  selesai: "surat_keterangan_selesai",
  suratSelesai: "surat_keterangan_selesai",
  surat_keterangan_selesai: "surat_keterangan_selesai",
  keterangan_selesai: "surat_keterangan_selesai",
  sertifikat: "sertifikat",
  certificate: "sertifikat"
});

const ALLOWED_STUDENT_DOCUMENT_TYPES = Object.freeze({
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png"
});

let ensureStudentDocumentsTablePromise = null;

async function ensureStudentDocumentsTable() {
  if (!ensureStudentDocumentsTablePromise) {
    const allowedTypes = Object.keys(STUDENT_DOCUMENT_TYPES).map((type) => `'${type}'`).join(", ");

    ensureStudentDocumentsTablePromise = query(`
      CREATE TABLE IF NOT EXISTS student_documents (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL CHECK (document_type IN (${allowedTypes})),
        file_url TEXT NOT NULL,
        file_name TEXT,
        file_size BIGINT,
        mime_type TEXT,
        uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (student_id, document_type)
      );
      CREATE INDEX IF NOT EXISTS idx_student_documents_student
        ON student_documents(student_id, document_type);
    `).catch((error) => {
      ensureStudentDocumentsTablePromise = null;
      throw error;
    });
  }

  await ensureStudentDocumentsTablePromise;
}

function normalizeStudentDocumentType(value) {
  const normalized = String(value || "").trim();
  return STUDENT_DOCUMENT_ALIASES[normalized] || null;
}

function getStudentDocumentDefinition(type) {
  const normalized = normalizeStudentDocumentType(type);
  return normalized ? STUDENT_DOCUMENT_TYPES[normalized] : null;
}

function listStudentDocumentDefinitions() {
  return Object.values(STUDENT_DOCUMENT_TYPES).sort((a, b) => a.order - b.order);
}

function sanitizeFilenameBase(name) {
  return (
    String(name || "dokumen-mahasiswa")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "dokumen-mahasiswa"
  );
}

function resolveStudentDocumentPath(fileUrl) {
  const normalized = String(fileUrl || "").trim();
  if (!normalized.startsWith("/uploads/student-documents/")) return null;
  return path.join(STUDENT_DOCUMENT_UPLOAD_DIR, path.basename(normalized));
}

async function removeStudentDocumentFile(fileUrl) {
  const targetPath = resolveStudentDocumentPath(fileUrl);
  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function saveStudentDocumentFile(fileDataUrl, fileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    const error = new Error("Format file tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2].replace(/\s/g, "");
  const extension = ALLOWED_STUDENT_DOCUMENT_TYPES[mimeType];

  if (!extension) {
    const error = new Error("Tipe file harus PDF, DOC, DOCX, JPG, JPEG, atau PNG.");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload) || base64Payload.length % 4 !== 0) {
    const error = new Error("Payload file base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(base64Payload, "base64");

  if (!buffer || buffer.length === 0) {
    const error = new Error("File kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_STUDENT_DOCUMENT_BYTES) {
    const error = new Error("Ukuran file maksimal 10 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(STUDENT_DOCUMENT_UPLOAD_DIR, { recursive: true });

  const safeBaseName = sanitizeFilenameBase(fileName);
  const finalFileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeBaseName}${extension}`;
  const finalPath = path.join(STUDENT_DOCUMENT_UPLOAD_DIR, finalFileName);

  await fs.writeFile(finalPath, buffer);

  return {
    fileUrl: `/uploads/student-documents/${finalFileName}`,
    fileName: String(fileName || finalFileName).trim() || finalFileName,
    fileSize: buffer.length,
    mimeType
  };
}

function mapStudentDocumentRow(row) {
  const definition = STUDENT_DOCUMENT_TYPES[row.document_type] || {
    type: row.document_type,
    label: row.document_type,
    requiresAlumni: false,
    order: 99
  };

  return {
    id: row.id || null,
    type: definition.type,
    document_type: definition.type,
    documentType: definition.type,
    label: definition.label,
    requires_alumni: Boolean(definition.requiresAlumni),
    requiresAlumni: Boolean(definition.requiresAlumni),
    file_url: row.file_url || null,
    fileUrl: row.file_url || null,
    file_name: row.file_name || null,
    fileName: row.file_name || null,
    file_size: row.file_size ? Number(row.file_size) : null,
    fileSize: row.file_size ? Number(row.file_size) : null,
    mime_type: row.mime_type || null,
    mimeType: row.mime_type || null,
    uploaded_by: row.uploaded_by || null,
    uploadedBy: row.uploaded_by || null,
    uploaded_at: row.uploaded_at || null,
    uploadedAt: row.uploaded_at || null,
    updated_at: row.updated_at || null,
    updatedAt: row.updated_at || null
  };
}

function buildStudentDocumentList(rows = [], studentStatus = null) {
  const byType = new Map(rows.map((row) => [row.document_type, mapStudentDocumentRow(row)]));
  const isAlumni = String(studentStatus || "").toLowerCase() === "alumni";

  return listStudentDocumentDefinitions().map((definition) => {
    const existing = byType.get(definition.type) || {
      id: null,
      type: definition.type,
      document_type: definition.type,
      documentType: definition.type,
      label: definition.label,
      requires_alumni: Boolean(definition.requiresAlumni),
      requiresAlumni: Boolean(definition.requiresAlumni),
      file_url: null,
      fileUrl: null,
      file_name: null,
      fileName: null,
      file_size: null,
      fileSize: null,
      mime_type: null,
      mimeType: null,
      uploaded_by: null,
      uploadedBy: null,
      uploaded_at: null,
      uploadedAt: null,
      updated_at: null,
      updatedAt: null
    };

    const locked = Boolean(definition.requiresAlumni && !isAlumni);

    return {
      ...existing,
      locked,
      can_upload: !locked,
      canUpload: !locked,
      lock_reason: locked ? "Dokumen ini baru bisa diunggah setelah mahasiswa berstatus Alumni." : null,
      lockReason: locked ? "Dokumen ini baru bisa diunggah setelah mahasiswa berstatus Alumni." : null
    };
  });
}

async function fetchStudentDocumentRows(studentIds) {
  const ids = Array.isArray(studentIds)
    ? studentIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [String(studentIds || "").trim()].filter(Boolean);

  if (ids.length === 0) return [];

  await ensureStudentDocumentsTable();

  const result = await query(
    `
    SELECT id, student_id, document_type, file_url, file_name, file_size, mime_type, uploaded_by, uploaded_at, updated_at
    FROM student_documents
    WHERE student_id = ANY($1::text[])
    ORDER BY student_id ASC, document_type ASC
    `,
    [ids]
  );

  return result.rows;
}

async function fetchStudentDocuments(studentId, studentStatus = null) {
  const rows = await fetchStudentDocumentRows([studentId]);
  return buildStudentDocumentList(rows, studentStatus);
}

async function fetchStudentDocumentsMap(students = []) {
  const list = Array.isArray(students) ? students : [];
  const ids = list.map((student) => String(student?.id || student?.student_id || student || "").trim()).filter(Boolean);
  const rows = await fetchStudentDocumentRows(ids);
  const rowsByStudent = new Map();

  rows.forEach((row) => {
    if (!rowsByStudent.has(row.student_id)) rowsByStudent.set(row.student_id, []);
    rowsByStudent.get(row.student_id).push(row);
  });

  const docsByStudent = new Map();
  list.forEach((student) => {
    const id = String(student?.id || student?.student_id || student || "").trim();
    const status = student?.status || student?.student_status || null;
    docsByStudent.set(id, buildStudentDocumentList(rowsByStudent.get(id) || [], status));
  });

  return docsByStudent;
}

module.exports = {
  STUDENT_DOCUMENT_TYPES,
  ensureStudentDocumentsTable,
  fetchStudentDocuments,
  fetchStudentDocumentsMap,
  getStudentDocumentDefinition,
  normalizeStudentDocumentType,
  removeStudentDocumentFile,
  saveStudentDocumentFile
};
