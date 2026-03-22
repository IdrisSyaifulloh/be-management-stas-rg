const express = require("express");

const router = express.Router();

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

const jobs = [];

router.get("/templates", (req, res) => {
  res.json(QUICK_EXPORTS);
});

router.get("/queue", (req, res) => {
  res.json(jobs.slice().reverse());
});

router.post("/generate", (req, res) => {
  const id = `EXP-${Date.now()}`;
  const job = {
    id,
    status: "Selesai",
    format: req.body?.format || "XLSX",
    selectedData: req.body?.selectedData || [],
    createdAt: new Date().toISOString(),
    fileUrl: `/exports/${id}.${String(req.body?.format || "xlsx").toLowerCase()}`
  };
  jobs.push(job);
  res.status(201).json(job);
});

module.exports = router;
