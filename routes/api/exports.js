const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

// CSV Escape Helper
const csvEscape = (val) => {
  if (val === null || val === undefined) return "";
  const str = String(val);
  return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
};

const sendCsvResponse = (res, filename, rows, headers) => {
  // headers: array of keys that match the SQL query result keys
  const csvRows = rows.map(row => 
    headers.map(h => csvEscape(row[h])).join(",")
  );
  const csvContent = [headers.join(","), ...csvRows].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\ufeff" + csvContent);
};

// Data Template for Frontend
const QUICK_EXPORTS = [
  {
    id: "kehadiran",
    title: "Rekap Kehadiran",
    desc: "Data kehadiran seluruh mahasiswa aktif beserta durasi harian.",
    period: "Bulan Berjalan"
  },
  {
    id: "logbook",
    title: "Logbook Mahasiswa",
    desc: "Semua entri logbook dari seluruh mahasiswa dalam periode berjalan.",
    period: "Bulan Berjalan"
  },
  {
    id: "riset",
    title: "Data Riset",
    desc: "Ringkasan progres, milestone, dan anggota semua proyek riset.",
    period: "Semua Waktu"
  },
  {
    id: "cuti",
    title: "Ringkasan Cuti",
    desc: "Histori pengajuan cuti, status persetujuan, dan sisa jatah.",
    period: "Bulan Berjalan"
  }
];

router.get("/templates", (req, res) => {
  res.json(QUICK_EXPORTS);
});

/**
 * GET /exports/kehadiran
 */
router.get(
  "/kehadiran",
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT u.name, s.nim, ar.attendance_date, ar.status, 
             ar.check_in_at, ar.check_out_at
      FROM attendance_records ar
      JOIN students s ON s.id = ar.student_id
      JOIN users u ON u.id = s.user_id
      ORDER BY ar.attendance_date DESC
    `);
    sendCsvResponse(res, `kehadiran-${new Date().toISOString().slice(0, 10)}.csv`, result.rows, [
      "name", "nim", "attendance_date", "status", "check_in_at", "check_out_at"
    ]);
  })
);

/**
 * GET /exports/logbook
 */
router.get(
  "/logbook",
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT u.name, s.nim, rp.short_title AS riset, le.date, le.title, le.description
      FROM logbook_entries le
      JOIN students s ON s.id = le.student_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = le.project_id
      ORDER BY le.date DESC
    `);
    sendCsvResponse(res, `logbook-${new Date().toISOString().slice(0, 10)}.csv`, result.rows, [
      "name", "nim", "riset", "date", "title", "description"
    ]);
  })
);

/**
 * GET /exports/riset
 */
router.get(
  "/riset",
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT rp.title, rp.short_title, rp.status, rp.progress, 
             rp.period_text, rp.mitra, rp.category
      FROM research_projects rp
      ORDER BY rp.id DESC
    `);
    sendCsvResponse(res, `riset-${new Date().toISOString().slice(0, 10)}.csv`, result.rows, [
      "title", "short_title", "status", "progress", "period_text", "mitra", "category"
    ]);
  })
);

/**
 * GET /exports/cuti
 */
router.get(
  "/cuti",
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT u.name, s.nim, lr.status, lr.periode_start, 
             lr.periode_end, lr.durasi, lr.alasan, lr.catatan
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users u ON u.id = s.user_id
      ORDER BY lr.periode_start DESC
    `);
    sendCsvResponse(res, `cuti-${new Date().toISOString().slice(0, 10)}.csv`, result.rows, [
      "name", "nim", "status", "periode_start", "periode_end", "durasi", "alasan", "catatan"
    ]);
  })
);

/**
 * GET /exports/rekap-data
 */
router.get(
  "/rekap-data",
  asyncHandler(async (req, res) => {
    const result = await query(`
      SELECT
        u.name,
        s.nim,
        u.prodi,
        s.status,
        COUNT(CASE WHEN ar.status = 'Hadir' THEN 1 END) as total_hadir,
        s.jam_minggu_ini as jam_minggu_ini,
        s.jam_minggu_target as jam_target,
        COUNT(DISTINCT le.id) as total_logbook,
        STRING_AGG(DISTINCT rp.title, '; ') as riset
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN attendance_records ar ON ar.student_id = s.id
      LEFT JOIN logbook_entries le ON le.student_id = s.id
      LEFT JOIN research_memberships rm ON rm.user_id = u.id AND rm.status = 'Aktif'
      LEFT JOIN research_projects rp ON rp.id = rm.project_id
      WHERE s.status != 'Mengundurkan Diri'
      GROUP BY u.name, s.nim, u.prodi, s.status, s.jam_minggu_ini, s.jam_minggu_target
      ORDER BY u.name ASC
    `);

    const headers = [
      "Nama", "NIM", "Prodi", "Status", 
      "Total Hadir", "Jam Minggu Ini", "Target Jam", "Total Logbook", "Riset Diikuti"
    ];

    const rows = result.rows.map(r => [
      r.name, r.nim, r.prodi, r.status,
      r.total_hadir, r.jam_minggu_ini, r.jam_target, r.total_logbook, r.riset
    ]);

    sendCsvResponse(res, `rekap-data-${new Date().toISOString().slice(0, 10)}.csv`, rows, headers);
  })
);

module.exports = router;