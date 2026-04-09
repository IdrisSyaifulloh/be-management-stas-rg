const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");

const router = express.Router();

function resolveRequesterUserId(req) {
  return String(req?.authUser?.id || req.headers["x-user-id"] || req.query.userId || req.body?.userId || "").trim();
}

async function hasProjectAccess({ userId, role, projectId }) {
  if (!userId || !role) return false;
  if (role === "operator") return true;

  if (role === "dosen") {
    const result = await query(
      `
      SELECT 1
      FROM research_projects rp
      LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND rm.user_id = $1
      LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id AND l.user_id = $1
      WHERE rp.id = $2
        AND (rm.user_id IS NOT NULL OR l.user_id IS NOT NULL)
      LIMIT 1
      `,
      [userId, projectId]
    );
    return result.rowCount > 0;
  }

  const result = await query(
    `
    SELECT 1
    FROM research_projects rp
    LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND rm.user_id = $1
    LEFT JOIN board_access ba ON ba.project_id = rp.id AND ba.user_id = $1
    WHERE rp.id = $2
      AND (rm.user_id IS NOT NULL OR ba.user_id IS NOT NULL)
    LIMIT 1
    `,
    [userId, projectId]
  );
  return result.rowCount > 0;
}

router.get(
  "/assigned",
  asyncHandler(async (req, res) => {
    const roleFromToken = extractRole(req);
    const queryUserId = String(req.query.userId || "");
    const requesterUserId = resolveRequesterUserId(req);
    const userId = roleFromToken === "operator" ? queryUserId : (requesterUserId || queryUserId);
    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    const userRow = await query("SELECT role FROM users WHERE id = $1 LIMIT 1", [userId]);
    if (userRow.rowCount === 0) {
      return res.status(404).json({ message: "User tidak ditemukan." });
    }

    const role = userRow.rows[0].role;
    let result;

    if (role === "operator") {
      result = await query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text
        FROM research_projects rp
        ORDER BY rp.id ASC
        `
      );
    } else if (role === "dosen") {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text
        FROM research_projects rp
        LEFT JOIN research_memberships rm
          ON rm.project_id = rp.id AND rm.user_id = $1
        LEFT JOIN lecturers l
          ON l.id = rp.supervisor_lecturer_id AND l.user_id = $1
        WHERE rm.user_id IS NOT NULL OR l.user_id IS NOT NULL
        ORDER BY rp.id ASC
        `,
        [userId]
      );
    } else {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text
        FROM research_projects rp
        JOIN research_memberships rm ON rm.project_id = rp.id
        WHERE rm.user_id = $1
        ORDER BY rp.id ASC
        `,
        [userId]
      );
    }

    res.json(result.rows);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);
    let result;

    if (role === "operator") {
      result = await query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        ORDER BY rp.id ASC
        `
      );
    } else if (role === "dosen") {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN research_memberships rm ON rm.project_id = rp.id
        LEFT JOIN lecturers own_l ON own_l.id = rp.supervisor_lecturer_id
        WHERE rm.user_id = $1 OR own_l.user_id = $1
        ORDER BY rp.id ASC
        `,
        [userId]
      );
    } else {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN research_memberships rm ON rm.project_id = rp.id
        LEFT JOIN board_access ba ON ba.project_id = rp.id
        WHERE rm.user_id = $1 OR ba.user_id = $1
        ORDER BY rp.id ASC
        `,
        [userId]
      );
    }

    res.json(result.rows);
  })
);

router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat anggota riset ini." });
    }

    const result = await query(
      `
      SELECT rm.id, rm.project_id, rm.user_id, u.name, u.initials, rm.member_type,
             rm.peran, rm.status, rm.bergabung, u.role
      FROM research_memberships rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.project_id = $1
      ORDER BY rm.member_type ASC, u.name ASC
      `,
      [req.params.id]
    );

    console.log('[GET /research/:id/members] Result:', result.rows);

    res.json(result.rows);
  })
);

router.get(
  "/:id/board-access",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat board access riset ini." });
    }

    const result = await query(
      `
      SELECT ba.user_id, u.name, u.initials
      FROM board_access ba
      JOIN users u ON u.id = ba.user_id
      WHERE ba.project_id = $1
      ORDER BY u.name ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  "/:id/board",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat board riset ini." });
    }

    const result = await query(
      `
      SELECT le.id, le.title, le.date, le.output, COALESCE(lc.comment_count, 0) AS comments_count
      FROM logbook_entries le
      LEFT JOIN (
        SELECT logbook_entry_id, COUNT(*)::int AS comment_count
        FROM logbook_comments
        GROUP BY logbook_entry_id
      ) lc ON lc.logbook_entry_id = le.id
      WHERE le.project_id = $1
      ORDER BY date DESC
      LIMIT 16
      `,
      [req.params.id]
    );

    const columns = {
      todo: [],
      doing: [],
      review: [],
      done: []
    };

    result.rows.forEach((item, index) => {
      const row = {
        id: item.id,
        title: item.title,
        deadline: new Date(item.date).toLocaleDateString("id-ID"),
        statusText: item.output || "",
        commentsCount: Number(item.comments_count) || 0
      };

      if (index % 4 === 0) columns.todo.push(row);
      else if (index % 4 === 1) columns.doing.push({ ...row, progress: 45 });
      else if (index % 4 === 2) columns.review.push(row);
      else columns.done.push(row);
    });

    res.json({
      projectId: req.params.id,
      columns,
      counts: {
        todo: columns.todo.length,
        doing: columns.doing.length,
        review: columns.review.length,
        done: columns.done.length
      }
    });
  })
);

router.get(
  "/:id/milestones",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat milestone riset ini." });
    }

    const result = await query(
      `
      SELECT id, project_id, label, done, target_date, sort_order
      FROM research_milestones
      WHERE project_id = $1
      ORDER BY sort_order ASC, id ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat membuat riset." });
    }

    const {
      id,
      title,
      shortTitle,
      supervisorLecturerId,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body;

    if (!id || !title || !status) {
      return res.status(400).json({ message: "id, title, status wajib diisi." });
    }

    await query(
      `
      INSERT INTO research_projects (
        id, title, short_title, supervisor_lecturer_id, period_text,
        mitra, status, progress, category, description, funding, repositori, attachment_link
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        id,
        title,
        shortTitle || null,
        supervisorLecturerId || null,
        periodText || null,
        mitra || null,
        status,
        progress ?? 0,
        category || null,
        description || null,
        funding || null,
        repositori || null,
        attachmentLink || null
      ]
    );

    res.status(201).json({ message: "Riset berhasil ditambahkan." });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah data riset." });
    }

    const { id } = req.params;
    const {
      title,
      shortTitle,
      supervisorLecturerId,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body;

    const result = await query(
      `
      UPDATE research_projects
      SET title = COALESCE($2, title),
          short_title = COALESCE($3, short_title),
          supervisor_lecturer_id = COALESCE($4, supervisor_lecturer_id),
          period_text = COALESCE($5, period_text),
          mitra = COALESCE($6, mitra),
          status = COALESCE($7, status),
          progress = COALESCE($8, progress),
          category = COALESCE($9, category),
          description = COALESCE($10, description),
          funding = COALESCE($11, funding),
          repositori = COALESCE($12, repositori),
          attachment_link = COALESCE($13, attachment_link),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [
        id,
        title,
        shortTitle,
        supervisorLecturerId,
        periodText,
        mitra,
        status,
        progress,
        category,
        description,
        funding,
        repositori,
        attachmentLink !== undefined ? attachmentLink : null
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    res.json({ message: "Data riset berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus riset." });
    }

    const result = await query("DELETE FROM research_projects WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    res.json({ message: "Riset berhasil dihapus." });
  })
);

router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan menambah anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah anggota di riset ini." });
    }

    const { userId, memberType, peran, status = "Aktif", bergabung } = req.body;

    if (!userId || !memberType) {
      return res.status(400).json({ message: "userId dan memberType wajib diisi." });
    }

    // Validate that only one "Ketua" is allowed per project AND must be Dosen
    if (peran && peran.toLowerCase().includes("ketua")) {
      const existingKetua = await query(
        `SELECT user_id, peran, member_type FROM research_memberships WHERE project_id = $1 AND LOWER(peran) LIKE '%ketua%'`,
        [req.params.id]
      );
      if (existingKetua.rowCount > 0) {
        return res.status(400).json({
          message: `Hanya boleh ada 1 Ketua per riset. Ketua saat ini: ${existingKetua.rows[0].peran}`
        });
      }
      // Ketua must be Dosen, not Mahasiswa
      if (memberType !== "Dosen") {
        return res.status(400).json({
          message: "Ketua tim wajib Dosen. Mahasiswa tidak bisa menjadi Ketua."
        });
      }
    }

    console.log('[POST /research/:id/members] Payload:', {
      projectId: req.params.id,
      userId,
      memberType,
      peran,
      status,
      bergabung
    });

    const insertResult = await query(
      `
      INSERT INTO research_memberships (project_id, user_id, member_type, peran, status, bergabung)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET member_type = EXCLUDED.member_type,
                    peran = EXCLUDED.peran,
                    status = EXCLUDED.status,
                    bergabung = EXCLUDED.bergabung
      RETURNING project_id, user_id, member_type, peran, status
      `,
      [req.params.id, userId, memberType, peran || null, status, bergabung || null]
    );

    console.log('[POST /research/:id/members] Insert Result:', insertResult.rows[0]);

    res.status(201).json({ message: "Anggota riset berhasil disimpan." });
  })
);

router.patch(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mengubah anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah anggota riset ini." });
    }

    const { memberType, peran, status, bergabung } = req.body;

    // Validate that only one "Ketua" is allowed per project AND must be Dosen
    if (peran && peran.toLowerCase().includes("ketua")) {
      const existingKetua = await query(
        `SELECT user_id, peran, member_type FROM research_memberships WHERE project_id = $1 AND LOWER(peran) LIKE '%ketua%' AND user_id != $2`,
        [req.params.id, req.params.userId]
      );
      if (existingKetua.rowCount > 0) {
        return res.status(400).json({
          message: `Hanya boleh ada 1 Ketua per riset. Ketua saat ini: ${existingKetua.rows[0].peran}`
        });
      }
      // Ketua must be Dosen, not Mahasiswa
      if (memberType !== "Dosen") {
        return res.status(400).json({
          message: "Ketua tim wajib Dosen. Mahasiswa tidak bisa menjadi Ketua."
        });
      }
    }

    const result = await query(
      `
      UPDATE research_memberships
      SET member_type = COALESCE($3, member_type),
          peran = COALESCE($4, peran),
          status = COALESCE($5, status),
          bergabung = COALESCE($6, bergabung)
      WHERE project_id = $1 AND user_id = $2
      RETURNING id
      `,
      [req.params.id, req.params.userId, memberType, peran, status, bergabung]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Anggota riset tidak ditemukan." });
    }

    res.json({ message: "Anggota riset berhasil diperbarui." });
  })
);

router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan menghapus anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus anggota riset ini." });
    }

    const result = await query(
      "DELETE FROM research_memberships WHERE project_id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.params.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Anggota riset tidak ditemukan." });
    }

    res.json({ message: "Anggota riset berhasil dihapus." });
  })
);

router.post(
  "/:id/board-access",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan memberi board access." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak memberi board access di riset ini." });
    }

    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    await query(
      `
      INSERT INTO board_access (project_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (project_id, user_id) DO NOTHING
      `,
      [req.params.id, userId]
    );

    res.status(201).json({ message: "Akses board berhasil diberikan." });
  })
);

router.delete(
  "/:id/board-access/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mencabut board access." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mencabut board access di riset ini." });
    }

    const result = await query(
      "DELETE FROM board_access WHERE project_id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.params.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Akses board tidak ditemukan." });
    }

    res.json({ message: "Akses board berhasil dicabut." });
  })
);

router.post(
  "/:id/milestones",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah milestone di riset ini." });
    }

    const { label, done = false, targetDate, sortOrder = 0 } = req.body;

    if (!label) {
      return res.status(400).json({ message: "label milestone wajib diisi." });
    }

    const result = await query(
      `
      INSERT INTO research_milestones (project_id, label, done, target_date, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [req.params.id, label, done, targetDate || null, sortOrder]
    );

    res.status(201).json({ message: "Milestone berhasil ditambahkan.", id: result.rows[0].id });
  })
);

router.patch(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak memperbarui milestone di riset ini." });
    }

    const { label, done, targetDate, sortOrder } = req.body;
    const result = await query(
      `
      UPDATE research_milestones
      SET label = COALESCE($3, label),
          done = COALESCE($4, done),
          target_date = COALESCE($5, target_date),
          sort_order = COALESCE($6, sort_order)
      WHERE project_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.id, req.params.milestoneId, label, done, targetDate, sortOrder]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Milestone tidak ditemukan." });
    }

    res.json({ message: "Milestone berhasil diperbarui." });
  })
);

router.delete(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus milestone di riset ini." });
    }

    const result = await query(
      "DELETE FROM research_milestones WHERE project_id = $1 AND id = $2 RETURNING id",
      [req.params.id, req.params.milestoneId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Milestone tidak ditemukan." });
    }

    res.json({ message: "Milestone berhasil dihapus." });
  })
);

module.exports = router;
