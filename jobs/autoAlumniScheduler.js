const { query } = require("../db/pool");

const ONE_DAY = 24 * 60 * 60 * 1000;

async function ensureStudentPeriodsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS student_periods (
      id          TEXT PRIMARY KEY,
      student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      tipe        TEXT NOT NULL CHECK (tipe IN ('Riset', 'Magang')),
      mulai       DATE NOT NULL,
      selesai     DATE,
      keterangan  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_student_periods_student
      ON student_periods(student_id, mulai ASC);
  `);
}

async function promoteExpiredToAlumni() {
  await ensureStudentPeriodsTable();

  // Mahasiswa kandidat: status aktif/cuti, punya minimal 1 periode,
  // dan TIDAK ada periode yang masih berjalan (selesai NULL atau selesai > hari ini)
  const candidates = await query(`
    SELECT s.id, s.user_id, u.name, s.status
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.status IN ('Aktif', 'Cuti')
      AND EXISTS (
        SELECT 1 FROM student_periods sp
        WHERE sp.student_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM student_periods sp
        WHERE sp.student_id = s.id
          AND (sp.selesai IS NULL OR sp.selesai > CURRENT_DATE)
      )
  `);

  if (candidates.rowCount === 0) {
    console.log("[AlumniScheduler] No students to promote to alumni.");
    return { promoted: 0 };
  }

  console.log(`[AlumniScheduler] Found ${candidates.rowCount} student(s) to promote to alumni.`);

  const promoted = [];

  for (const student of candidates.rows) {
    await query("BEGIN");
    try {
      await query(
        `UPDATE students SET status = 'Alumni', updated_at = NOW() WHERE id = $1`,
        [student.id]
      );

      const auditId = `aud_alumni_${Date.now()}_${student.id}`;
      await query(
        `
        INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
        VALUES ($1, $2, 'Operator', 'Update', 'auto_alumni_promotion', $3)
        `,
        [
          auditId,
          null,
          JSON.stringify({
            student_id: student.id,
            user_id: student.user_id,
            name: student.name,
            previous_status: student.status,
            new_status: "Alumni",
            reason: "Semua periode keanggotaan telah selesai — otomatis dipromosikan ke Alumni",
            promoted_at: new Date().toISOString()
          })
        ]
      );

      await query("COMMIT");
      promoted.push({ id: student.id, name: student.name });
      console.log(`[AlumniScheduler] Promoted "${student.name}" to Alumni.`);
    } catch (err) {
      await query("ROLLBACK");
      console.error(`[AlumniScheduler] Failed to promote "${student.name}":`, err.message);
    }
  }

  return { promoted: promoted.length, students: promoted };
}

async function runCycle() {
  try {
    console.log("[AlumniScheduler] Running alumni promotion check...");
    const result = await promoteExpiredToAlumni();
    if (result.promoted > 0) {
      console.log(`[AlumniScheduler] Promoted ${result.promoted} student(s) to Alumni.`);
    }
    return result;
  } catch (err) {
    console.error("[AlumniScheduler] Cycle failed:", err.message);
    return { promoted: 0, error: err.message };
  }
}

function startMonitoring() {
  console.log("[AlumniScheduler] Starting alumni promotion scheduler (checks every 24 hours)...");
  runCycle().catch(() => {});
  setInterval(() => {
    runCycle().catch(() => {});
  }, ONE_DAY);
}

module.exports = { ensureStudentPeriodsTable, promoteExpiredToAlumni, runCycle, startMonitoring };

if (require.main === module) {
  runCycle()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
