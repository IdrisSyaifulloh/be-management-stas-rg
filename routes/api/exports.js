const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
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

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
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

function sendFile(res, payload) {
  res.setHeader("Content-Type", payload.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
  res.send(payload.buffer);
}

function buildFilePayload({ definition, format, headers, rows, filtersSummary, pdfOptions = {} }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filenameBase = `${slugify(definition.fileBaseName || definition.title)}-${stamp}`;

  if (format === "csv") {
    return {
      filename: `${filenameBase}.csv`,
      mimeType: CSV_MIME,
      buffer: buildCsvBuffer(headers, rows)
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
        rows
      })
    };
  }

  if (rows.length > PDF_MAX_ROWS) {
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
      columnWeights: pdfOptions.columnWeights
    })
  };
}

const EXPORT_DEFINITIONS = {
  kehadiran: {
    title: "Rekap Kehadiran",
    description: "Data kehadiran mahasiswa beserta status check-in dan check-out.",
    fileBaseName: "kehadiran",
    sheetName: "Kehadiran",
    filters: { student: true, project: true, dateRange: true },
    buildPdfOptions(request, context) {
      return {
        metadata: buildCommonPdfMetadata(request, context),
        columnWeights: context.student
          ? [1.4, 1.05, 1.1, 1.2, 0.95, 0.95]
          : [1.8, 1.15, 1.1, 1.2, 0.95, 0.95]
      };
    },
    normalizeRequest(request) {
      const range = resolveAttendanceRange(request.startDate, request.endDate);
      return { ...request, ...range };
    },
    async getDataset(request) {
      const studentClauses = [];
      const params = [];

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
          headers: ["Nama", "NIM", "Tanggal", "Status", "Check-in", "Check-out"],
          rows: []
        };
      }

      const studentIds = studentsResult.rows.map((row) => row.id);
      const attendanceResult = await query(
        `
        SELECT
          ar.student_id,
          TO_CHAR(ar.attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
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
          TO_CHAR(lr.periode_end, 'YYYY-MM-DD') AS periode_end
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

      const rows = [];
      for (const student of studentsResult.rows) {
        const { history } = buildAttendanceHistory({
          startDate: request.startDate,
          endDate: request.endDate,
          attendanceRows: attendanceByStudentId.get(student.id) || [],
          leaveRows: leaveByStudentId.get(student.id) || [],
          activeStartDate: student.active_start_date
        });

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
      }

      rows.sort((left, right) => {
        const dateCompare = String(right[2]).localeCompare(String(left[2]));
        if (dateCompare !== 0) return dateCompare;
        return String(left[0]).localeCompare(String(right[0]), "id");
      });

      return {
        headers: ["Nama", "NIM", "Tanggal", "Status", "Check-in", "Check-out"],
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
        headers: ["ID Riset", "Judul", "Short Title", "Status", "Progress", "Periode", "Mitra", "Kategori", "Pembimbing", "Jumlah Anggota", "Total Milestone", "Milestone Selesai", "Tanggal Dibuat"],
        rows: result.rows.map((row) => [
          row.id,
          row.title,
          row.short_title,
          row.status,
          row.progress,
          row.period_text,
          row.mitra,
          row.category,
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
  }
};

const TEMPLATE_TYPES = ["kehadiran", "logbook", "riset", "cuti", "database-mahasiswa", "layanan-surat"];

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
  const request = parseExportRequest(req, typeOverride);
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

  const payload = buildFilePayload({
    definition,
    format: resolvedRequest.format,
    headers: dataset.headers,
    rows: dataset.rows,
    filtersSummary: buildFilterSummary(definition, resolvedRequest, context),
    pdfOptions: definition.buildPdfOptions
      ? definition.buildPdfOptions(resolvedRequest, context)
      : {}
  });

  sendFile(res, payload);
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
