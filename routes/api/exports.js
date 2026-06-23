const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { buildAttendanceHistory, resolveAttendanceRange } = require("../../utils/attendanceHistory");
const { resolveStudentRecord } = require("../../utils/studentResolver");
const {
  buildCsvBuffer,
  buildPdfBuffer,
  buildXlsxBuffer,
  CSV_MIME,
  PDF_MIME,
  XLSX_MIME
} = require("../../utils/exportFiles");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
const SUPPORTED_FORMATS = ["xlsx", "csv", "pdf"];
const PDF_MAX_ROWS = 500;
let ensureLecturerExportColumnsPromise = null;
let ensureResearchExportColumnsPromise = null;

async function ensureLecturerExportColumns() {
  if (!ensureLecturerExportColumnsPromise) {
    ensureLecturerExportColumnsPromise = (async () => {
      await query(`
        ALTER TABLE lecturers
        ADD COLUMN IF NOT EXISTS kode_dosen TEXT,
        ADD COLUMN IF NOT EXISTS nidn TEXT,
        ADD COLUMN IF NOT EXISTS asal_kampus TEXT,
        ADD COLUMN IF NOT EXISTS pendidikan_terakhir TEXT,
        ADD COLUMN IF NOT EXISTS kategori_dosen TEXT,
        ADD COLUMN IF NOT EXISTS jfa TEXT,
        ADD COLUMN IF NOT EXISTS tanggal_persetujuan_anggota DATE
      `);

      await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS phone TEXT
      `);

      await query(`
        UPDATE lecturers
        SET jfa = jabatan
        WHERE jfa IS NULL
          AND jabatan IS NOT NULL
      `);
    })();
  }

  await ensureLecturerExportColumnsPromise;
}

async function ensureResearchExportColumns() {
  if (!ensureResearchExportColumnsPromise) {
    ensureResearchExportColumnsPromise = query(`
      ALTER TABLE research_projects
      ADD COLUMN IF NOT EXISTS research_type TEXT CHECK (research_type IN ('Internal', 'Eksternal')),
      ADD COLUMN IF NOT EXISTS agreement_type TEXT CHECK (agreement_type IN ('PKS', 'MoU', 'MoA')),
      ADD COLUMN IF NOT EXISTS agreement_start_date DATE,
      ADD COLUMN IF NOT EXISTS agreement_end_date DATE,
      ADD COLUMN IF NOT EXISTS agreement_file_url TEXT,
      ADD COLUMN IF NOT EXISTS proposal_file_url TEXT,
      ADD COLUMN IF NOT EXISTS rab_file_url TEXT
    `).catch((error) => {
      ensureResearchExportColumnsPromise = null;
      throw error;
    });
  }

  await ensureResearchExportColumnsPromise;
}


function createHttpError(status, message, expose = status < 500) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  return error;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function pickValue(...values) {
  return values.map((value) => normalizeText(value)).find(Boolean) || "";
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "export";
}

function parseDateInput(value, label) {
  const raw = normalizeText(value);
  if (!raw) return null;

  let year;
  let month;
  let day;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    [year, month, day] = raw.split("-").map(Number);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
    [day, month, year] = raw.split("/").map(Number);
  } else {
    throw createHttpError(400, `${label} harus berformat YYYY-MM-DD atau DD/MM/YYYY.`);
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw createHttpError(400, `${label} tidak valid.`);
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatDateLabel(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

function buildDateRangeLabel(startDate, endDate) {
  if (startDate && endDate) return `${formatDateLabel(startDate)} - ${formatDateLabel(endDate)}`;
  if (startDate) return `mulai ${formatDateLabel(startDate)}`;
  if (endDate) return `sampai ${formatDateLabel(endDate)}`;
  return "";
}

function appendDateBounds(clauses, params, column, startDate, endDate) {
  if (startDate) {
    params.push(startDate);
    clauses.push(`${column} >= $${params.length}`);
  }
  if (endDate) {
    params.push(endDate);
    clauses.push(`${column} <= $${params.length}`);
  }
}

function appendDateOverlap(clauses, params, startColumn, endColumn, startDate, endDate) {
  if (startDate && endDate) {
    params.push(startDate);
    const startIndex = params.length;
    params.push(endDate);
    const endIndex = params.length;
    clauses.push(`NOT (${endColumn} < $${startIndex} OR ${startColumn} > $${endIndex})`);
    return;
  }

  if (startDate) {
    params.push(startDate);
    clauses.push(`${endColumn} >= $${params.length}`);
  }

  if (endDate) {
    params.push(endDate);
    clauses.push(`${startColumn} <= $${params.length}`);
  }
}

function buildWhereSql(clauses) {
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

async function resolveFilterContext({ studentId, projectId }) {
  const context = { student: null, project: null };

  if (studentId) {
    const student = await resolveStudentRecord(studentId);
    if (!student) {
      throw createHttpError(404, "Mahasiswa yang dipilih tidak ditemukan.");
    }

    context.student = student;
  }

  if (projectId) {
    const projectResult = await query(
      `
      SELECT id, title, COALESCE(short_title, title) AS project_name
      FROM research_projects
      WHERE id = $1
      LIMIT 1
      `,
      [projectId]
    );

    if (projectResult.rowCount === 0) {
      throw createHttpError(404, "Riset yang dipilih tidak ditemukan.");
    }

    context.project = projectResult.rows[0];
  }

  return context;
}

function parseExportRequest(req, typeOverride) {
  const type = normalizeText(typeOverride || req.query.type || req.body?.type).toLowerCase();
  const format = normalizeText(req.query.format || req.body?.format || "csv").toLowerCase();
  const studentId = pickValue(req.query.studentId, req.query.mahasiswaId, req.body?.studentId, req.body?.mahasiswaId);
  const projectId = pickValue(req.query.projectId, req.query.risetId, req.body?.projectId, req.body?.risetId);
  const startDate = parseDateInput(
    pickValue(req.query.startDate, req.query.dateFrom, req.query.tanggalDari, req.body?.startDate, req.body?.dateFrom, req.body?.tanggalDari),
    "Tanggal dari"
  );
  const endDate = parseDateInput(
    pickValue(req.query.endDate, req.query.dateTo, req.query.tanggalSampai, req.body?.endDate, req.body?.dateTo, req.body?.tanggalSampai),
    "Tanggal sampai"
  );

  if (!type) {
    throw createHttpError(400, "Jenis export wajib diisi.");
  }

  if (!SUPPORTED_FORMATS.includes(format)) {
    throw createHttpError(400, `Format export "${format}" tidak didukung. Pilihan: ${SUPPORTED_FORMATS.join(", ")}.`);
  }

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, "Tanggal dari tidak boleh lebih besar dari tanggal sampai.");
  }

  const angkatan = normalizeText(req.query.angkatan || req.body?.angkatan || "");
  if (studentId) requireSafeId(studentId, "studentId");
  if (projectId) requireSafeId(projectId, "projectId");
  if (angkatan && !/^[A-Za-z0-9 _.-]{1,40}$/.test(angkatan)) {
    throw createHttpError(400, "Input tidak valid.");
  }

  return { type, format, studentId, projectId, startDate, endDate, angkatan };
}

function assertSupportedFilters(definition, request) {
  if (request.studentId && !definition.filters.student) {
    throw createHttpError(400, `Filter mahasiswa tidak didukung untuk export ${definition.title}.`);
  }

  if (request.projectId && !definition.filters.project) {
    throw createHttpError(400, `Filter riset tidak didukung untuk export ${definition.title}.`);
  }

  if ((request.startDate || request.endDate) && !definition.filters.dateRange) {
    throw createHttpError(400, `Filter tanggal tidak didukung untuk export ${definition.title}.`);
  }
}

function buildFilterSummary(definition, request, context) {
  const summary = [`Jenis data: ${definition.title}`];

  if (context.student) {
    summary.push(`Mahasiswa: ${context.student.name} (${context.student.nim})`);
  }

  if (context.project) {
    summary.push(`Riset: ${context.project.project_name}`);
  }

  if (request.angkatan) {
    summary.push(`Angkatan: ${request.angkatan}`);
  }

  const dateRange = buildDateRangeLabel(request.startDate, request.endDate);
  if (dateRange) {
    summary.push(`Rentang tanggal: ${dateRange}`);
  }

  return summary;
}

function buildNoDataMessage(definition, request, context) {
  const scopes = [];

  if (context.student) {
    scopes.push(`mahasiswa ${context.student.name} (${context.student.nim})`);
  }

  if (context.project) {
    scopes.push(`riset ${context.project.project_name}`);
  }

  if (request.angkatan) {
    scopes.push(`angkatan ${request.angkatan}`);
  }

  const dateRange = buildDateRangeLabel(request.startDate, request.endDate);
  if (dateRange) {
    scopes.push(`rentang tanggal ${dateRange}`);
  }

  if (!scopes.length) {
    return `Tidak ada data ${definition.title} yang dapat diekspor.`;
  }

  return `Tidak ada data ${definition.title} untuk ${scopes.join(", ")}.`;
}

function buildCommonPdfMetadata(request, context) {
  const metadata = [];

  if (context.student) {
    metadata.push(`Nama Mahasiswa: ${context.student.name}`);
    metadata.push(`NIM: ${context.student.nim}`);
  }

  if (context.project) {
    metadata.push(`Riset: ${context.project.project_name}`);
  }

  const dateRange = buildDateRangeLabel(request.startDate, request.endDate);
  if (dateRange) {
    metadata.push(`Rentang Tanggal: ${dateRange}`);
  }

  return metadata;
}

function parseIsoDateUtc(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDateUtc(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getAttendanceSheetDates(startDate, endDate) {
  const dates = [];
  let cursor = parseIsoDateUtc(startDate);
  const last = parseIsoDateUtc(endDate);

  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day >= 1 && day <= 5) {
      dates.push(formatIsoDateUtc(cursor));
    }
    cursor = addUtcDays(cursor, 1);
  }

  return dates;
}

function getAttendanceSheetWeeks(startDate, endDate) {
  const weeks = [];
  let currentWeek = [];
  let cursor = parseIsoDateUtc(startDate);
  const last = parseIsoDateUtc(endDate);

  while (cursor <= last) {
    const day = cursor.getUTCDay();
    if (day === 1 && currentWeek.length) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    if (day >= 1 && day <= 5) {
      currentWeek.push(formatIsoDateUtc(cursor));
    }
    cursor = addUtcDays(cursor, 1);
  }

  if (currentWeek.length) weeks.push(currentWeek);
  return weeks;
}

function formatAttendanceSheetTime(value) {
  return value && value !== "-" ? String(value).replace(":", ".") : "";
}

function getAttendanceSheetTimePair(item) {
  if (!item || ["Belum Aktif", "Akan Aktif", "Libur"].includes(item.status)) {
    return { checkIn: "", checkOut: "", present: false };
  }

  return {
    checkIn: formatAttendanceSheetTime(item.in),
    checkOut: formatAttendanceSheetTime(item.out),
    present: ["Hadir", "WFH"].includes(item.status)
  };
}

function buildAttendanceSheetHeaders() {
  const headers = ["NAMA"];
  for (let day = 1; day <= 5; day += 1) {
    headers.push(`${day} Masuk`, `${day} Keluar`);
  }
  headers.push("TOTAL");
  return headers;
}

function formatAttendanceSheetHeaderDate(isoDate, fallbackIndex) {
  if (!isoDate) return String(fallbackIndex);
  const [, month, day] = String(isoDate).split("-");
  return `${day}/${month}`;
}

function buildAttendanceSheetHeaderRowsForDates(sheetDates) {
  const dateRow = ["NAMA"];
  const timeRow = [""];

  for (let index = 0; index < 5; index += 1) {
    const isoDate = sheetDates[index];
    dateRow.push(formatAttendanceSheetHeaderDate(isoDate, index + 1), "");
    timeRow.push("Masuk", "Keluar");
  }

  dateRow.push("TOTAL");
  timeRow.push("");

  return [dateRow, timeRow];
}

function buildAttendanceSheetHeadersFromRows(headerRows) {
  const [dateRow, timeRow] = headerRows;
  return dateRow.map((value, index) => {
    if (index === 0 || index === dateRow.length - 1) return value;
    return [value, timeRow[index]].filter(Boolean).join(" ");
  });
}

function buildAttendanceSheetMerges(sheetDates) {
  const merges = ["A1:A2"];
  for (let index = 0; index < 5; index += 1) {
    const startColumnIndex = 1 + index * 2;
    const start = columnLetterForExport(startColumnIndex);
    const end = columnLetterForExport(startColumnIndex + 1);
    merges.push(`${start}1:${end}1`);
  }
  const totalColumn = columnLetterForExport(11);
  merges.push(`${totalColumn}1:${totalColumn}2`);
  return merges;
}

function columnLetterForExport(index) {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function getAttendanceWeekOfMonth(startDate) {
  const date = parseIsoDateUtc(startDate);
  return Math.max(1, Math.ceil(date.getUTCDate() / 7));
}

function getIndonesianMonthName(startDate) {
  return parseIsoDateUtc(startDate).toLocaleDateString("id-ID", {
    month: "long",
    timeZone: "UTC"
  });
}

function buildAttendanceSheetMetadata(request, context) {
  const metadata = ["ABSENSI MINGGUAN"];
  const date = parseIsoDateUtc(request.startDate);
  const week = getAttendanceWeekOfMonth(request.startDate);
  const monthName = getIndonesianMonthName(request.startDate);
  metadata.push(`Periode: Minggu ${week} Bulan ${monthName} Tahun ${date.getUTCFullYear()}`);

  if (context.project) {
    metadata.push(`Riset: ${context.project.project_name}`);
  }

  if (context.student) {
    metadata.push(`Mahasiswa: ${context.student.name} (${context.student.nim})`);
  }

  return metadata;
}

function buildAttendanceWeekMetadata(request, context, weekDates, weekIndex) {
  const metadata = ["ABSENSI MINGGUAN"];
  const firstDate = weekDates[0] || request.startDate;
  const lastDate = weekDates[weekDates.length - 1] || request.endDate;
  const date = parseIsoDateUtc(firstDate);
  const monthName = getIndonesianMonthName(firstDate);
  metadata.push(`Periode: Minggu ${weekIndex + 1} (${formatAttendanceSheetHeaderDate(firstDate, weekIndex + 1)} - ${formatAttendanceSheetHeaderDate(lastDate, weekIndex + 1)}) Bulan ${monthName} Tahun ${date.getUTCFullYear()}`);

  if (context.project) {
    metadata.push(`Riset: ${context.project.project_name}`);
  }

  return metadata;
}

function sendFile(res, payload) {
  res.setHeader("Content-Type", payload.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Content-Length", payload.buffer.length);
  res.send(payload.buffer);
}

function buildFilePayload({ definition, format, headers, rows, filtersSummary, pdfOptions = {}, headerRows = null, xlsxMerges = [], pdfSections = null }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filenameBase = `${slugify(definition.fileBaseName || definition.title)}-${stamp}`;

  if (format === "csv") {
    return {
      filename: `${filenameBase}.csv`,
      mimeType: CSV_MIME,
      buffer: buildCsvBuffer(headers, rows, headerRows)
    };
  }

  if (format === "xlsx") {
    return {
      filename: `${filenameBase}.xlsx`,
      mimeType: XLSX_MIME,
      buffer: buildXlsxBuffer({
        title: definition.title,
        sheetName: definition.sheetName || definition.title,
        headers,
        rows,
        headerRows,
        merges: xlsxMerges
      })
    };
  }

  const pdfRowCount = Array.isArray(pdfSections) && pdfSections.length
    ? pdfSections.reduce((sum, section) => sum + (section.rows?.length || 0), 0)
    : rows.length;

  if (pdfRowCount > PDF_MAX_ROWS) {
    throw createHttpError(422, `Export PDF ${definition.title} dibatasi maksimal ${PDF_MAX_ROWS} baris. Gunakan CSV atau XLSX untuk data besar.`);
  }

  return {
    filename: `${filenameBase}.pdf`,
    mimeType: PDF_MIME,
    buffer: buildPdfBuffer({
      title: definition.title,
      headers,
      rows,
      filtersSummary,
      metadata: pdfOptions.metadata,
      columnWeights: pdfOptions.columnWeights,
      headerRows,
      sections: pdfSections
    })
  };
}

const EXPORT_DEFINITIONS = {
  kehadiran: {
    title: "ABSENSI RISET COE STAS-RG 2025/2026",
    description: "Absensi mingguan mahasiswa riset dengan waktu masuk dan waktu keluar.",
    fileBaseName: "kehadiran",
    sheetName: "Absensi Mingguan",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      if (context.student) {
        return {
          metadata: buildCommonPdfMetadata(request, context),
          columnWeights: [1.4, 1.05, 1.1, 1.2, 0.95, 0.95]
        };
      }

      return {
        metadata: buildAttendanceSheetMetadata(request, context),
        columnWeights: [
          2.2,
          ...getAttendanceSheetDates(request.startDate, request.endDate).flatMap(() => [0.72, 0.72]),
          0.75
        ]
      };
    },
    normalizeRequest(request) {
      const range = resolveAttendanceRange(request.startDate, request.endDate);
      return { ...request, ...range };
    },
    async getDataset(request, context) {
      const studentClauses = [];
      const params = [];
      const singleStudentMode = Boolean(context?.student || request.studentId);

      if (request.studentId) {
        params.push(request.studentId);
        studentClauses.push(`s.id = $${params.length}`);
      }

      if (request.projectId) {
        params.push(request.projectId);
        studentClauses.push(`
          EXISTS (
            SELECT 1
            FROM research_memberships rm
            WHERE rm.user_id = u.id
              AND rm.project_id = $${params.length}
              AND rm.status = 'Aktif'
          )
        `);
      }

      const studentsResult = await query(
        `
        SELECT s.id, s.user_id, s.nim, u.name,
               TO_CHAR(s.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS active_start_date
        FROM students s
        JOIN users u ON u.id = s.user_id
        ${buildWhereSql(studentClauses)}
        ORDER BY u.name ASC
        `,
        params
      );

      if (studentsResult.rowCount === 0) {
        return {
          headers: singleStudentMode
            ? ["Nama", "NIM", "Tanggal", "Status", "Check-in", "Check-out"]
            : buildAttendanceSheetHeaders(),
          rows: []
        };
      }

      const studentIds = studentsResult.rows.map((row) => row.id);
      const attendanceResult = await query(
        `
        SELECT
          ar.student_id,
          TO_CHAR(ar.attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
          ar.status,
          ar.check_in_at,
          ar.check_out_at
        FROM attendance_records ar
        WHERE ar.student_id = ANY($1::text[])
          AND ar.attendance_date >= $2
          AND ar.attendance_date <= $3
        ORDER BY ar.attendance_date DESC, ar.student_id ASC
        `,
        [studentIds, request.startDate, request.endDate]
      );

      const leaveResult = await query(
        `
        SELECT
          lr.student_id,
          TO_CHAR(lr.periode_start, 'YYYY-MM-DD') AS periode_start,
          TO_CHAR(lr.periode_end, 'YYYY-MM-DD') AS periode_end,
          COALESCE(lr.jenis_pengajuan, 'cuti') AS jenis_pengajuan
        FROM leave_requests lr
        WHERE lr.student_id = ANY($1::text[])
          AND lr.status = 'Disetujui'
          AND NOT (lr.periode_end < $2::date OR lr.periode_start > $3::date)
        `,
        [studentIds, request.startDate, request.endDate]
      );

      const attendanceByStudentId = new Map();
      for (const row of attendanceResult.rows) {
        const items = attendanceByStudentId.get(row.student_id) || [];
        items.push(row);
        attendanceByStudentId.set(row.student_id, items);
      }

      const leaveByStudentId = new Map();
      for (const row of leaveResult.rows) {
        const items = leaveByStudentId.get(row.student_id) || [];
        items.push(row);
        leaveByStudentId.set(row.student_id, items);
      }

      const settings = await getSettingsAsync();
      const attendanceRules = settings?.attendanceRules || {};
      const rows = [];
      const studentHistories = new Map();

      for (const student of studentsResult.rows) {
        const { history } = buildAttendanceHistory({
          startDate: request.startDate,
          endDate: request.endDate,
          attendanceRows: attendanceByStudentId.get(student.id) || [],
          leaveRows: leaveByStudentId.get(student.id) || [],
          activeStartDate: student.active_start_date,
          holidays: attendanceRules.holidays,
          excludeHolidaysFromWorkdays: attendanceRules.excludeHolidaysFromWorkdays !== false
        });
        studentHistories.set(student.id, history);

        if (singleStudentMode) {
          history.forEach((item) => {
            rows.push([
              student.name,
              student.nim,
              item.isoDate,
              item.status,
              item.in,
              item.out
            ]);
          });
          continue;
        }
      }

      if (singleStudentMode) {
        rows.sort((left, right) => {
          const dateCompare = String(right[2]).localeCompare(String(left[2]));
          if (dateCompare !== 0) return dateCompare;
          return String(left[0]).localeCompare(String(right[0]), "id");
        });

        return {
          title: "Rekap Kehadiran",
          sheetName: "Kehadiran",
          headers: ["Nama", "NIM", "Tanggal", "Status", "Check-in", "Check-out"],
          rows
        };
      }

      const weekSections = getAttendanceSheetWeeks(request.startDate, request.endDate);
      const pdfSections = [];
      let attendanceSheetHeaders = buildAttendanceSheetHeaders();
      let attendanceHeaderRows = [attendanceSheetHeaders];
      let attendanceSheetMerges = [];

      weekSections.forEach((weekDates, weekIndex) => {
        const headerRows = buildAttendanceSheetHeaderRowsForDates(weekDates);
        const headers = buildAttendanceSheetHeadersFromRows(headerRows);
        const sectionRows = [];

        studentsResult.rows.forEach((student) => {
          const history = studentHistories.get(student.id) || [];
          const historyByDate = new Map(history.map((item) => [item.isoDate, item]));
          const row = [student.name];
          let total = 0;

          weekDates.forEach((isoDate) => {
            const { checkIn, checkOut, present } = getAttendanceSheetTimePair(historyByDate.get(isoDate));
            if (present) total += 1;
            row.push(checkIn, checkOut);
          });

          while (row.length < 11) {
            row.push("", "");
          }

          row.push(total);
          sectionRows.push(row);
        });

        sectionRows.sort((left, right) => String(left[0]).localeCompare(String(right[0]), "id"));

        if (weekIndex === 0) {
          attendanceSheetHeaders = headers;
          attendanceHeaderRows = headerRows;
          attendanceSheetMerges = buildAttendanceSheetMerges(weekDates);
        }

        rows.push([`Minggu ${weekIndex + 1}`, ...Array(Math.max(0, headers.length - 1)).fill("")]);
        rows.push(...sectionRows);

        pdfSections.push({
          title: "ABSENSI RISET COE STAS-RG 2025/2026",
          metadata: buildAttendanceWeekMetadata(request, context, weekDates, weekIndex),
          headers,
          headerRows,
          rows: sectionRows,
          columnWeights: [2.2, ...weekDates.flatMap(() => [0.72, 0.72]), 0.75]
        });
      });

      return {
        headers: attendanceSheetHeaders,
        headerRows: attendanceHeaderRows,
        xlsxMerges: attendanceSheetMerges,
        pdfSections,
        rows
      };
    }
  },
  logbook: {
    title: "Logbook Mahasiswa",
    description: "Semua entri logbook mahasiswa dalam periode yang dipilih.",
    fileBaseName: "logbook",
    sheetName: "Logbook",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        // 6 kolom: Tanggal, Riset, Judul, Deskripsi, Output, Foto
        columnWeights: [0.7, 1.0, 1.1, 1.8, 1.6, 1.0]
      };
    },
    async getDataset(request) {
      const clauses = [];
      const params = [];

      if (request.studentId) {
        params.push(request.studentId);
        clauses.push(`s.id = $${params.length}`);
      }

      if (request.projectId) {
        params.push(request.projectId);
        clauses.push(`le.project_id = $${params.length}`);
      }

      appendDateBounds(clauses, params, "le.date", request.startDate, request.endDate);

      const result = await query(
        `
        SELECT
          TO_CHAR(le.date, 'YYYY-MM-DD') AS entry_date,
          COALESCE(rp.short_title, rp.title, '-') AS riset,
          le.title,
          le.description,
          COALESCE(le.output, '-') AS output,
          CASE
            WHEN le.has_attachment AND le.file_url IS NOT NULL
            THEN COALESCE(le.file_name, le.file_url)
            ELSE '-'
          END AS foto
        FROM logbook_entries le
        JOIN students s ON s.id = le.student_id
        LEFT JOIN research_projects rp ON rp.id = le.project_id
        ${buildWhereSql(clauses)}
        ORDER BY le.date DESC, le.id DESC
        `,
        params
      );

      return {
        headers: ["Tanggal", "Riset", "Judul", "Deskripsi", "Output", "Foto"],
        rows: result.rows.map((row) => [
          row.entry_date,
          row.riset,
          row.title,
          row.description,
          row.output,
          row.foto
        ])
      };
    }
  },
  riset: {
    title: "Data Riset",
    description: "Ringkasan proyek riset, PIC, milestone, dan progres.",
    fileBaseName: "riset",
    sheetName: "Riset",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        columnWeights: [0.85, 1.5, 1.05, 0.8, 0.8, 0.95, 1.0, 0.95, 1.1, 0.8, 0.85, 0.95, 1.0]
      };
    },
    async getDataset(request, context) {
      await ensureResearchExportColumns();

      const clauses = [];
      const params = [];

      if (request.projectId) {
        params.push(request.projectId);
        clauses.push(`rp.id = $${params.length}`);
      }

      if (context.student) {
        params.push(context.student.user_id);
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM research_memberships rm
            WHERE rm.project_id = rp.id
              AND rm.user_id = $${params.length}
          )
        `);
      }

      appendDateBounds(clauses, params, `(rp.created_at AT TIME ZONE 'Asia/Jakarta')::date`, request.startDate, request.endDate);

      const result = await query(
        `
        SELECT
          rp.id,
          rp.title,
          COALESCE(rp.short_title, '-') AS short_title,
          rp.status,
          rp.progress,
          COALESCE(rp.period_text, '-') AS period_text,
          COALESCE(rp.mitra, '-') AS mitra,
          COALESCE(rp.category, '-') AS category,
          COALESCE(rp.research_type, '-') AS research_type,
          COALESCE(rp.agreement_type, '-') AS agreement_type,
          COALESCE(TO_CHAR(rp.agreement_start_date, 'YYYY-MM-DD'), '-') AS agreement_start_date,
          COALESCE(TO_CHAR(rp.agreement_end_date, 'YYYY-MM-DD'), '-') AS agreement_end_date,
          COALESCE(rp.agreement_file_url, '-') AS agreement_file_url,
          COALESCE(rp.proposal_file_url, '-') AS proposal_file_url,
          COALESCE(rp.rab_file_url, '-') AS rab_file_url,
          COALESCE(supervisor_u.name, '-') AS supervisor_name,
          COALESCE(member_stats.member_count, 0) AS member_count,
          COALESCE(milestone_stats.total_milestones, 0) AS total_milestones,
          COALESCE(milestone_stats.completed_milestones, 0) AS completed_milestones,
          TO_CHAR((rp.created_at AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') AS created_date
        FROM research_projects rp
        LEFT JOIN lecturers supervisor_l ON supervisor_l.id = rp.supervisor_lecturer_id
        LEFT JOIN users supervisor_u ON supervisor_u.id = supervisor_l.user_id
        LEFT JOIN (
          SELECT project_id, COUNT(*)::int AS member_count
          FROM research_memberships
          GROUP BY project_id
        ) member_stats ON member_stats.project_id = rp.id
        LEFT JOIN (
          SELECT
            project_id,
            COUNT(*)::int AS total_milestones,
            COUNT(*) FILTER (WHERE done)::int AS completed_milestones
          FROM research_milestones
          GROUP BY project_id
        ) milestone_stats ON milestone_stats.project_id = rp.id
        ${buildWhereSql(clauses)}
        ORDER BY rp.id DESC
        `,
        params
      );

      return {
        headers: [
          "ID Riset",
          "Judul",
          "Short Title",
          "Status",
          "Progress",
          "Periode",
          "Mitra",
          "Kategori",
          "Jenis Riset",
          "Jenis PKS/MoU/MoA",
          "Tanggal Mulai PKS/MoU/MoA",
          "Tanggal Selesai PKS/MoU/MoA",
          "File PKS/MoU/MoA",
          "File Proposal",
          "File RAB",
          "Pembimbing",
          "Jumlah Anggota",
          "Total Milestone",
          "Milestone Selesai",
          "Tanggal Dibuat"
        ],
        rows: result.rows.map((row) => [
          row.id,
          row.title,
          row.short_title,
          row.status,
          row.progress,
          row.period_text,
          row.mitra,
          row.category,
          row.research_type,
          row.agreement_type,
          row.agreement_start_date,
          row.agreement_end_date,
          row.agreement_file_url,
          row.proposal_file_url,
          row.rab_file_url,
          row.supervisor_name,
          row.member_count,
          row.total_milestones,
          row.completed_milestones,
          row.created_date
        ])
      };
    }
  },
  cuti: {
    title: "Ringkasan Cuti",
    description: "Histori cuti mahasiswa dan status persetujuannya.",
    fileBaseName: "cuti",
    sheetName: "Cuti",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        columnWeights: [1.15, 0.9, 1.05, 0.95, 0.95, 0.95, 0.8, 0.9, 1.35, 1.2]
      };
    },
    async getDataset(request) {
      const clauses = [];
      const params = [];

      if (request.studentId) {
        params.push(request.studentId);
        clauses.push(`s.id = $${params.length}`);
      }

      if (request.projectId) {
        params.push(request.projectId);
        clauses.push(`lr.project_id = $${params.length}`);
      }

      appendDateOverlap(clauses, params, "lr.periode_start", "lr.periode_end", request.startDate, request.endDate);

      const result = await query(
        `
        SELECT
          u.name,
          s.nim,
          COALESCE(rp.short_title, rp.title, '-') AS riset,
          TO_CHAR(lr.tanggal_pengajuan, 'YYYY-MM-DD') AS submission_date,
          TO_CHAR(lr.periode_start, 'YYYY-MM-DD') AS periode_start,
          TO_CHAR(lr.periode_end, 'YYYY-MM-DD') AS periode_end,
          lr.durasi,
          lr.status,
          lr.alasan,
          COALESCE(lr.catatan, '-') AS catatan
        FROM leave_requests lr
        JOIN students s ON s.id = lr.student_id
        JOIN users u ON u.id = s.user_id
        LEFT JOIN research_projects rp ON rp.id = lr.project_id
        ${buildWhereSql(clauses)}
        ORDER BY lr.periode_start DESC, u.name ASC
        `,
        params
      );

      return {
        headers: ["Nama", "NIM", "Riset", "Tanggal Pengajuan", "Mulai Cuti", "Selesai Cuti", "Durasi", "Status", "Alasan", "Catatan"],
        rows: result.rows.map((row) => [
          row.name,
          row.nim,
          row.riset,
          row.submission_date,
          row.periode_start,
          row.periode_end,
          row.durasi,
          row.status,
          row.alasan,
          row.catatan
        ])
      };
    }
  },
  "database-mahasiswa": {
    title: "Database Mahasiswa",
    description: "Master data mahasiswa beserta prodi, status, angkatan, dan keterlibatan riset.",
    fileBaseName: "database-mahasiswa",
    sheetName: "Mahasiswa",
    // Filter angkatan menggantikan dateRange. startDate/endDate diterima tapi diabaikan.
    filters: { student: false, project: false, dateRange: false, angkatan: true },
    // Strip date params agar assertSupportedFilters tidak lempar 400 jika frontend lama kirim tanggal
    normalizeRequest(request) {
      return { ...request, startDate: null, endDate: null };
    },
    buildPdfOptions(request) {
      const meta = [];
      if (request.angkatan) meta.push(`Angkatan: ${request.angkatan}`);
      return {
        metadata: meta,
        // Lebar kolom proporsional: Riset Aktif lebih lebar karena bisa panjang
        columnWeights: [1.3, 0.8, 1.3, 1.1, 0.55, 0.65, 0.75, 0.9, 1.65]
      };
    },
    async getDataset(request) {
      const clauses = [`s.status != 'Mengundurkan Diri'`];
      const params = [];

      // Filter utama: angkatan (opsional)
      if (request.angkatan) {
        params.push(request.angkatan);
        clauses.push(`s.angkatan = $${params.length}`);
      }

      // startDate / endDate sengaja TIDAK dipakai di sini (diabaikan sesuai kontrak baru)

      const result = await query(
        `
        SELECT
          u.name,
          s.nim,
          COALESCE(u.email, '-') AS email,
          COALESCE(u.prodi, '-') AS prodi,
          COALESCE(s.angkatan, '-') AS angkatan,
          s.tipe,
          s.status,
          COALESCE(TO_CHAR(s.bergabung, 'YYYY-MM-DD'), '-') AS bergabung,
          COALESCE(projects.project_names, '-') AS projects
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN LATERAL (
          SELECT STRING_AGG(
            DISTINCT COALESCE(rp.short_title, rp.title),
            '; '
            ORDER BY COALESCE(rp.short_title, rp.title)
          ) AS project_names
          FROM research_memberships rm
          JOIN research_projects rp ON rp.id = rm.project_id
          WHERE rm.user_id = u.id
            AND rm.status = 'Aktif'
        ) projects ON TRUE
        ${buildWhereSql(clauses)}
        ORDER BY s.angkatan DESC, u.name ASC
        `,
        params
      );

      return {
        headers: ["Nama", "NIM", "Email", "Prodi", "Angkatan", "Tipe", "Status", "Tgl Bergabung", "Riset Aktif"],
        rows: result.rows.map((row) => [
          row.name,
          row.nim,
          row.email,
          row.prodi,
          row.angkatan,
          row.tipe,
          row.status,
          row.bergabung,
          row.projects
        ])
      };
    }
  },
  "database-dosen": {
    title: "Database Dosen",
    description: "Master data dosen beserta kode dosen, kampus asal, kategori, JFA, dan keterlibatan riset.",
    fileBaseName: "database-dosen",
    sheetName: "Dosen",
    filters: { student: false, project: false, dateRange: false },
    normalizeRequest(request) {
      return { ...request, startDate: null, endDate: null };
    },
    buildPdfOptions() {
      return {
        metadata: [],
        columnWeights: [0.85, 1.25, 1.0, 0.9, 1.1, 0.95, 1.0, 0.95, 0.95, 0.95, 0.95, 0.95, 1.2, 0.7, 0.7, 0.75, 0.9, 0.8]
      };
    },
    async getDataset() {
      await ensureLecturerExportColumns();

      const result = await query(
        `
        SELECT
          COALESCE(l.kode_dosen, l.id, '-') AS kode_dosen,
          u.name,
          COALESCE(l.nip, '-') AS nip,
          COALESCE(l.nidn, '-') AS nidn,
          COALESCE(u.email, '-') AS email,
          COALESCE(u.phone, '-') AS phone,
          COALESCE(l.asal_kampus, '-') AS asal_kampus,
          COALESCE(TO_CHAR(l.tanggal_persetujuan_anggota, 'YYYY-MM-DD'), '-') AS tanggal_persetujuan_anggota,
          COALESCE(l.pendidikan_terakhir, '-') AS pendidikan_terakhir,
          COALESCE(l.kategori_dosen, '-') AS kategori_dosen,
          COALESCE(l.jfa, l.jabatan, '-') AS jfa,
          COALESCE(l.departemen, '-') AS departemen,
          COALESCE(NULLIF(array_to_string(COALESCE(l.keahlian, '{}'::text[]), '; '), ''), '-') AS keahlian,
          COALESCE(l.riset_dipimpin, 0) AS riset_dipimpin,
          COALESCE(l.riset_diikuti, 0) AS riset_diikuti,
          COALESCE(l.status, '-') AS status,
          COALESCE(TO_CHAR(l.bergabung, 'YYYY-MM-DD'), '-') AS bergabung,
          COALESCE(l.mahasiswa_count, 0) AS mahasiswa_count
        FROM lecturers l
        JOIN users u ON u.id = l.user_id
        ORDER BY u.name ASC
        `
      );

      return {
        headers: [
          "Kode Dosen",
          "Nama",
          "NIP",
          "NIDN",
          "Email",
          "Kontak HP",
          "Asal Kampus",
          "Tgl Persetujuan Anggota",
          "Pendidikan Terakhir",
          "Kategori Dosen",
          "JFA",
          "Departemen",
          "Keahlian",
          "Riset Dipimpin",
          "Riset Diikuti",
          "Status",
          "Tgl Bergabung",
          "Jumlah Mahasiswa"
        ],
        rows: result.rows.map((row) => [
          row.kode_dosen,
          row.name,
          row.nip,
          row.nidn,
          row.email,
          row.phone,
          row.asal_kampus,
          row.tanggal_persetujuan_anggota,
          row.pendidikan_terakhir,
          row.kategori_dosen,
          row.jfa,
          row.departemen,
          row.keahlian,
          row.riset_dipimpin,
          row.riset_diikuti,
          row.status,
          row.bergabung,
          row.mahasiswa_count
        ])
      };
    }
  },
  "layanan-surat": {
    title: "Layanan Surat",
    description: "Riwayat pengajuan layanan surat mahasiswa.",
    fileBaseName: "layanan-surat",
    sheetName: "Layanan Surat",
    filters: { student: true, project: false, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        columnWeights: [1.15, 0.9, 1.0, 0.9, 1.45, 0.9, 1.0, 1.1]
      };
    },
    async getDataset(request) {
      const clauses = [];
      const params = [];

      if (request.studentId) {
        params.push(request.studentId);
        clauses.push(`s.id = $${params.length}`);
      }

      appendDateBounds(clauses, params, "lr.tanggal", request.startDate, request.endDate);

      const result = await query(
        `
        SELECT
          u.name,
          s.nim,
          lr.jenis,
          TO_CHAR(lr.tanggal, 'YYYY-MM-DD') AS letter_date,
          lr.tujuan,
          lr.status,
          COALESCE(TO_CHAR(lr.estimasi, 'YYYY-MM-DD'), '-') AS estimasi,
          COALESCE(lr.nomor_surat, '-') AS nomor_surat
        FROM letter_requests lr
        JOIN students s ON s.id = lr.student_id
        JOIN users u ON u.id = s.user_id
        ${buildWhereSql(clauses)}
        ORDER BY lr.tanggal DESC, u.name ASC
        `,
        params
      );

      return {
        headers: ["Nama", "NIM", "Jenis Surat", "Tanggal", "Tujuan", "Status", "Estimasi Selesai", "Nomor Surat"],
        rows: result.rows.map((row) => [
          row.name,
          row.nim,
          row.jenis,
          row.letter_date,
          row.tujuan,
          row.status,
          row.estimasi,
          row.nomor_surat
        ])
      };
    }
  },
  "rekap-data": {
    title: "Rekap Data Mahasiswa",
    description: "Ringkasan kehadiran, logbook, dan keterlibatan riset per mahasiswa.",
    fileBaseName: "rekap-data",
    sheetName: "Rekap",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        columnWeights: [1.15, 0.9, 1.0, 0.9, 0.9, 0.95, 0.95, 1.0, 1.3]
      };
    },
    async getDataset(request) {
      const clauses = [`s.status != 'Mengundurkan Diri'`];
      const params = [];

      if (request.studentId) {
        params.push(request.studentId);
        clauses.push(`s.id = $${params.length}`);
      }

      if (request.projectId) {
        params.push(request.projectId);
        clauses.push(`
          EXISTS (
            SELECT 1
            FROM research_memberships rm_filter
            WHERE rm_filter.user_id = u.id
              AND rm_filter.project_id = $${params.length}
              AND rm_filter.status = 'Aktif'
          )
        `);
      }

      const attendanceClauses = [`ar.student_id = s.id`, `ar.status = 'Hadir'`];
      appendDateBounds(attendanceClauses, params, "ar.attendance_date", request.startDate, request.endDate);
      if (request.projectId) {
        params.push(request.projectId);
        attendanceClauses.push(`
          EXISTS (
            SELECT 1
            FROM research_memberships rm_att
            WHERE rm_att.user_id = u.id
              AND rm_att.project_id = $${params.length}
              AND rm_att.status = 'Aktif'
          )
        `);
      }
      const attendanceWhere = attendanceClauses.join(" AND ");

      const logbookClauses = [`le.student_id = s.id`];
      appendDateBounds(logbookClauses, params, "le.date", request.startDate, request.endDate);
      if (request.projectId) {
        params.push(request.projectId);
        logbookClauses.push(`le.project_id = $${params.length}`);
      }
      const logbookWhere = logbookClauses.join(" AND ");

      const projectClauses = [`rm.user_id = u.id`, `rm.status = 'Aktif'`];
      if (request.projectId) {
        params.push(request.projectId);
        projectClauses.push(`rm.project_id = $${params.length}`);
      }
      const projectWhere = projectClauses.join(" AND ");

      const result = await query(
        `
        SELECT
          u.name,
          s.nim,
          COALESCE(u.prodi, '-') AS prodi,
          s.status,
          COALESCE(attendance_stats.total_hadir, 0) AS total_hadir,
          COALESCE(s.jam_minggu_ini, 0) AS jam_minggu_ini,
          COALESCE(s.jam_minggu_target, 0) AS jam_target,
          COALESCE(logbook_stats.total_logbook, 0) AS total_logbook,
          COALESCE(project_stats.projects, '-') AS riset
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS total_hadir
          FROM attendance_records ar
          WHERE ${attendanceWhere}
        ) attendance_stats ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS total_logbook
          FROM logbook_entries le
          WHERE ${logbookWhere}
        ) logbook_stats ON TRUE
        LEFT JOIN LATERAL (
          SELECT STRING_AGG(DISTINCT rp.title, '; ' ORDER BY rp.title) AS projects
          FROM research_memberships rm
          JOIN research_projects rp ON rp.id = rm.project_id
          WHERE ${projectWhere}
        ) project_stats ON TRUE
        ${buildWhereSql(clauses)}
        ORDER BY u.name ASC
        `,
        params
      );

      return {
        headers: ["Nama", "NIM", "Prodi", "Status", "Total Hadir", "Jam Minggu Ini", "Target Jam", "Total Logbook", "Riset Diikuti"],
        rows: result.rows.map((row) => [
          row.name,
          row.nim,
          row.prodi,
          row.status,
          row.total_hadir,
          row.jam_minggu_ini,
          row.jam_target,
          row.total_logbook,
          row.riset
        ])
      };
    }
  },
  "kegiatan-stas": {
    title: "Kegiatan STAS-RG",
    description: "Rekap kegiatan harian CoE STAS-RG (riset, abdimas, internal) beserta peserta, output, dan berkas dokumentasi.",
    fileBaseName: "kegiatan-stas-rg",
    sheetName: "Kegiatan STAS-RG",
    filters: { student: false, project: false, dateRange: true },
    async getDataset(request) {
      const clauses = [];
      const params = [];

      if (request.startDate) {
        params.push(request.startDate);
        clauses.push(`activity_date >= $${params.length}::date`);
      }
      if (request.endDate) {
        params.push(request.endDate);
        clauses.push(`activity_date <= $${params.length}::date`);
      }

      const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const FORM_LABELS = {
        meeting: "Rapat",
        visit_internal: "Kunjungan Internal/Lab Visit",
        visit_external: "Kunjungan Eksternal",
        lab_test: "Pengujian Lab",
        lab: "Lab",
        visit: "Visit",
        other: "Lainnya"
      };

      const TYPE_LABELS = {
        riset: "Riset/Penelitian/Proyek",
        abdimas: "Pengabdian Masyarakat",
        internal: "Internal CoE STAS-RG"
      };

      const result = await query(
        `
        SELECT
          TO_CHAR(activity_date, 'DD/MM/YYYY') AS tanggal,
          activity_type,
          activity_form,
          activity_name,
          COALESCE(goal, '-') AS tujuan,
          COALESCE(description_summary, '-') AS deskripsi,
          COALESCE(activity_time::text, '-') AS waktu,
          COALESCE(location, '-') AS lokasi,
          COALESCE(participants_count::text, '-') AS jumlah_peserta,
          COALESCE(participants_list, '-') AS daftar_peserta,
          COALESCE(output, '-') AS output,
          COALESCE(folder_bergkas_url, '-') AS link_folder,
          COALESCE(pic_name, '-') AS pic,
          CASE WHEN notulensi_url IS NOT NULL THEN 'Ada' ELSE '-' END AS notulensi,
          CASE WHEN surat_url IS NOT NULL THEN 'Ada' ELSE '-' END AS surat,
          CASE WHEN photo_url IS NOT NULL THEN 'Ada' ELSE '-' END AS foto
        FROM stas_activities
        ${whereClause}
        ORDER BY activity_date DESC, created_at DESC
        `,
        params
      );

      return {
        headers: [
          "Tanggal", "Jenis Kegiatan", "Bentuk Kegiatan", "Nama Kegiatan",
          "Tujuan", "Deskripsi", "Waktu", "Lokasi",
          "Jml Peserta", "Daftar Peserta", "Output/Hasil",
          "Link Folder", "PIC", "Notulensi", "Surat", "Foto"
        ],
        rows: result.rows.map((row) => [
          row.tanggal,
          TYPE_LABELS[row.activity_type] || row.activity_type,
          FORM_LABELS[row.activity_form] || row.activity_form,
          row.activity_name,
          row.tujuan,
          row.deskripsi,
          row.waktu,
          row.lokasi,
          row.jumlah_peserta,
          row.daftar_peserta,
          row.output,
          row.link_folder,
          row.pic,
          row.notulensi,
          row.surat,
          row.foto
        ])
      };
    }
  }
};

const TEMPLATE_TYPES = [
  "kehadiran",
  "logbook",
  "riset",
  "cuti",
  "database-mahasiswa",
  "database-dosen",
  "layanan-surat",
  "rekap-data",
  "kegiatan-stas"
];

router.get("/templates", (req, res) => {
  res.json(
    TEMPLATE_TYPES.map((type) => {
      const definition = EXPORT_DEFINITIONS[type];
      return {
        id: type,
        title: definition.title,
        desc: definition.description,
        period: "Kustom",
        formats: SUPPORTED_FORMATS,
        filters: definition.filters,
        endpoint: `/api/v1/exports/custom?type=${type}`
      };
    })
  );
});

async function handleExport(req, res, typeOverride) {
  let request;

  try {
    request = parseExportRequest(req, typeOverride);
    const definition = EXPORT_DEFINITIONS[request.type];

    if (!definition) {
      throw createHttpError(400, `Jenis export "${request.type}" tidak didukung.`);
    }

    const normalizedRequest = definition.normalizeRequest
      ? definition.normalizeRequest(request)
      : request;
    assertSupportedFilters(definition, normalizedRequest);

    const context = await resolveFilterContext(normalizedRequest);
    const resolvedRequest = context.student
      ? { ...normalizedRequest, studentId: context.student.id }
      : normalizedRequest;
    const dataset = await definition.getDataset(resolvedRequest, context);

    if (!dataset.rows.length) {
      throw createHttpError(404, buildNoDataMessage(definition, resolvedRequest, context));
    }

    const outputDefinition = {
      ...definition,
      title: dataset.title || definition.title,
      sheetName: dataset.sheetName || definition.sheetName
    };

    const payload = buildFilePayload({
      definition: outputDefinition,
      format: resolvedRequest.format,
      headers: dataset.headers,
      rows: dataset.rows,
      filtersSummary: buildFilterSummary(outputDefinition, resolvedRequest, context),
      pdfOptions: outputDefinition.buildPdfOptions
        ? outputDefinition.buildPdfOptions(resolvedRequest, context)
        : {},
      headerRows: dataset.headerRows || null,
      xlsxMerges: dataset.xlsxMerges || [],
      pdfSections: dataset.pdfSections || null
    });

    sendFile(res, payload);
  } catch (error) {
    if (!error.status && !error.statusCode) {
      const format = request?.format || normalizeText(req.query.format || req.body?.format || "csv").toLowerCase();
      const formatLabel = SUPPORTED_FORMATS.includes(format) ? format.toUpperCase() : "file";
      throw createHttpError(500, `Gagal generate export ${formatLabel}`, true);
    }

    throw error;
  }
}

router.get(
  "/custom",
  asyncHandler(async (req, res) => {
    await handleExport(req, res);
  })
);

[
  "kehadiran",
  "logbook",
  "riset",
  "cuti",
  "database-mahasiswa",
  "database-dosen",
  "layanan-surat",
  "rekap-data"
].forEach((type) => {
  router.get(
    `/${type}`,
    asyncHandler(async (req, res) => {
      await handleExport(req, res, type);
    })
  );
});

module.exports = router;
