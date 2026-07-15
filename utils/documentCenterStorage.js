const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { requireSafeId } = require("./securityValidation");

const STORAGE_ROOT = path.resolve(__dirname, "..", "storage", "document-center");
const STAGING_ROOT = path.join(STORAGE_ROOT, "staging");
const VERSIONS_ROOT = path.join(STORAGE_ROOT, "versions");
const TEMPLATES_ROOT = path.join(STORAGE_ROOT, "templates");
const VERSION_STORAGE_KEY_PATTERN = /^versions\/([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\/v([1-9]\d*)\.pdf$/;
const TEMPLATE_STORAGE_KEY_PATTERN = /^templates\/([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\/v([1-9]\d*)\.pdf$/;

function createUnavailableError() {
  const error = new Error("File dokumen tidak tersedia.");
  error.code = "DOCUMENT_FILE_UNAVAILABLE";
  return error;
}

function ensurePathInsideRoot(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw createUnavailableError();
  }
  return relativePath;
}

function buildStagingFilePath(filename) {
  if (!/^[A-Za-z0-9-]+\.pdf$/.test(String(filename || ""))) {
    throw createUnavailableError();
  }
  return path.join(STAGING_ROOT, filename);
}

function buildVersionStorageKey(documentId, versionNumber) {
  const safeDocumentId = requireSafeId(documentId, "documentId");
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw createUnavailableError();
  }
  return `versions/${safeDocumentId}/v${versionNumber}.pdf`;
}

function parseVersionStorageKey(storageKey) {
  if (
    typeof storageKey !== "string" ||
    storageKey.includes("\0") ||
    storageKey.includes("\\") ||
    path.isAbsolute(storageKey)
  ) {
    throw createUnavailableError();
  }
  const match = VERSION_STORAGE_KEY_PATTERN.exec(storageKey);
  if (!match) throw createUnavailableError();
  return { documentId: match[1], versionNumber: Number(match[2]) };
}

function buildVersionFilePath(documentId, versionNumber) {
  const storageKey = buildVersionStorageKey(documentId, versionNumber);
  return path.resolve(STORAGE_ROOT, ...storageKey.split("/"));
}

function getVersionDirectory(documentId) {
  return path.dirname(buildVersionFilePath(documentId, 1));
}

function buildTemplateStorageKey(templateId, versionNumber) {
  const safeTemplateId = requireSafeId(templateId, "templateId");
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw createUnavailableError();
  }
  return `templates/${safeTemplateId}/v${versionNumber}.pdf`;
}

function parseTemplateStorageKey(storageKey) {
  if (
    typeof storageKey !== "string" ||
    storageKey.includes("\0") ||
    storageKey.includes("\\") ||
    path.isAbsolute(storageKey)
  ) {
    throw createUnavailableError();
  }
  const match = TEMPLATE_STORAGE_KEY_PATTERN.exec(storageKey);
  if (!match) throw createUnavailableError();
  return { templateId: match[1], versionNumber: Number(match[2]) };
}

function buildTemplateFilePath(templateId, versionNumber) {
  const storageKey = buildTemplateStorageKey(templateId, versionNumber);
  return path.resolve(STORAGE_ROOT, ...storageKey.split("/"));
}

function getTemplateDirectory(templateId) {
  return path.dirname(buildTemplateFilePath(templateId, 1));
}

async function openPrivateTemplateVersion({ storageKey, mimeType, fileSize }) {
  if (mimeType !== "application/pdf" || !Number.isSafeInteger(Number(fileSize)) || Number(fileSize) <= 0) {
    throw createUnavailableError();
  }

  parseTemplateStorageKey(storageKey);
  const candidatePath = path.resolve(STORAGE_ROOT, ...storageKey.split("/"));
  ensurePathInsideRoot(STORAGE_ROOT, candidatePath);

  let handle;
  try {
    const realStorageRoot = await fsPromises.realpath(STORAGE_ROOT);
    const rootStat = await fsPromises.lstat(realStorageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw createUnavailableError();

    const candidateStat = await fsPromises.lstat(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw createUnavailableError();

    const realFilePath = await fsPromises.realpath(candidatePath);
    ensurePathInsideRoot(realStorageRoot, realFilePath);

    handle = await fsPromises.open(realFilePath, fs.constants.O_RDONLY);
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.size <= 0 || handleStat.size !== Number(fileSize)) {
      await handle.close().catch(() => {});
      throw createUnavailableError();
    }

    return { handle, size: handleStat.size };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === "DOCUMENT_FILE_UNAVAILABLE") throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw createUnavailableError();
    throw error;
  }
}

async function openPrivateDocumentVersion({ storageKey, mimeType, fileSize }) {
  if (mimeType !== "application/pdf" || !Number.isSafeInteger(Number(fileSize)) || Number(fileSize) <= 0) {
    throw createUnavailableError();
  }

  parseVersionStorageKey(storageKey);
  const candidatePath = path.resolve(STORAGE_ROOT, ...storageKey.split("/"));
  ensurePathInsideRoot(STORAGE_ROOT, candidatePath);

  let handle;
  try {
    const realStorageRoot = await fsPromises.realpath(STORAGE_ROOT);
    const rootStat = await fsPromises.lstat(realStorageRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw createUnavailableError();

    const candidateStat = await fsPromises.lstat(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw createUnavailableError();

    const realFilePath = await fsPromises.realpath(candidatePath);
    ensurePathInsideRoot(realStorageRoot, realFilePath);

    handle = await fsPromises.open(realFilePath, fs.constants.O_RDONLY);
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.size <= 0 || handleStat.size !== Number(fileSize)) {
      await handle.close().catch(() => {});
      throw createUnavailableError();
    }

    return { handle, size: handleStat.size };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === "DOCUMENT_FILE_UNAVAILABLE") throw error;
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw createUnavailableError();
    throw error;
  }
}

function sanitizeDownloadFilename(value) {
  const basename = path.basename(String(value || "").replace(/\\/g, "/"));
  const cleaned = basename
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 160);
  if (!cleaned || !/\.pdf$/i.test(cleaned)) return "document.pdf";
  return cleaned;
}

module.exports = {
  STORAGE_ROOT,
  STAGING_ROOT,
  VERSIONS_ROOT,
  TEMPLATES_ROOT,
  buildStagingFilePath,
  buildVersionStorageKey,
  buildVersionFilePath,
  getVersionDirectory,
  buildTemplateStorageKey,
  buildTemplateFilePath,
  getTemplateDirectory,
  openPrivateTemplateVersion,
  openPrivateDocumentVersion,
  sanitizeDownloadFilename
};
