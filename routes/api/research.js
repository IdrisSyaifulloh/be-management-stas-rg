const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const {
  ensureResearchBoardTables,
  fetchBoardSnapshot,
  fetchTaskDetail,
  getNextTaskSortOrder,
  normalizeBoardTaskStatus,
  removeBoardAttachmentFile,
  saveBoardAttachmentFile,
  setTaskAssignees
} = require("../../utils/researchBoardStore");
const { createNotification } = require("../../utils/notificationService");

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

function buildEntityId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function toNullableText(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function normalizeAssigneeIds(assigneeIds) {
  return Array.from(
    new Set(
      (Array.isArray(assigneeIds) ? assigneeIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeProgress(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

async function ensureTaskExists(projectId, taskId) {
  await ensureResearchBoardTables();
  const result = await query(
    `
    SELECT id, project_id, status
    FROM research_board_tasks
    WHERE project_id = $1 AND id = $2
    LIMIT 1
    `,
    [projectId, taskId]
  );

  return result.rows[0] || null;
}

async function validateAssigneeIds(assigneeIds) {
  const normalizedIds = normalizeAssigneeIds(assigneeIds);
  if (normalizedIds.length === 0) return [];

  const result = await query("SELECT id FROM users WHERE id = ANY($1::text[])", [normalizedIds]);
  const existingIds = new Set(result.rows.map((row) => row.id));
  const missingIds = normalizedIds.filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    const error = new Error(`Assignee tidak ditemukan: ${missingIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedIds;
}

async function notifyMilestoneUpdate(projectId, actorUserId, actionLabel, milestoneLabel) {
  const projectResult = await query(
    `
    SELECT id, COALESCE(short_title, title) AS project_name, supervisor_lecturer_id
    FROM research_projects
    WHERE id = $1
    LIMIT 1
    `,
    [projectId]
  );

  if (projectResult.rowCount === 0) return;

  const project = projectResult.rows[0];
  const recipientsResult = await query(
    `
    SELECT DISTINCT user_id
    FROM (
      SELECT rm.user_id
      FROM research_memberships rm
      WHERE rm.project_id = $1
      UNION
      SELECT l.user_id
      FROM lecturers l
      WHERE l.id = $2
    ) recipients
    WHERE user_id IS NOT NULL
      AND ($3::text IS NULL OR user_id <> $3)
    `,
    [projectId, project.supervisor_lecturer_id, actorUserId || null]
  );

  if (recipientsResult.rowCount === 0) return;

  await Promise.all(
    recipientsResult.rows.map((row) =>
      createNotification({
        recipientUserId: row.user_id,
        senderUserId: actorUserId || null,
        type: "milestone",
        eventId: "milestone_update",
        title: "Update Milestone Riset",
        body: `${actionLabel} milestone "${milestoneLabel}" pada riset ${project.project_name}.`
      })
    )
  );
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
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat board riset ini." });
    }

    const snapshot = await fetchBoardSnapshot(req.params.id);
    res.json(snapshot);
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

// ─── Board Cards (Logbook Entries) CRUD ──────────────────────────────────────

router.post(
  "/:id/board/cards",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk menambah card di board ini." });
    }

    const { title, date, description, output, kendala, studentId } = req.body;

    if (!title || !date) {
      return res.status(400).json({ message: "title dan date wajib diisi." });
    }

    // Generate a unique ID for the logbook entry
    const entryId = `LE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Resolve student_id if provided, otherwise use a default
    let resolvedStudentId = null;
    if (studentId) {
      const studentCheck = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentId]);
      if (studentCheck.rowCount > 0) {
        resolvedStudentId = studentCheck.rows[0].id;
      }
    }

    // If no studentId provided, find any student from the project
    if (!resolvedStudentId) {
      const anyStudent = await query(
        `SELECT rm.user_id, s.id FROM research_memberships rm
         JOIN students s ON s.user_id = rm.user_id
         WHERE rm.project_id = $1 LIMIT 1`,
        [req.params.id]
      );
      if (anyStudent.rowCount > 0) {
        resolvedStudentId = anyStudent.rows[0].id;
      }
    }

    // If still no student, we need to handle this — use a placeholder
    if (!resolvedStudentId) {
      return res.status(400).json({ message: "Tidak ada mahasiswa di proyek ini. Tambahkan anggota mahasiswa terlebih dahulu." });
    }

    await query(
      `
      INSERT INTO logbook_entries (id, student_id, project_id, date, title, description, output, kendala, has_attachment)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [entryId, resolvedStudentId, req.params.id, date, title, description || null, output || null, kendala || null, false]
    );

    const newEntry = await query(
      `SELECT id, title, date, description, output FROM logbook_entries WHERE id = $1`,
      [entryId]
    );

    res.status(201).json({ message: "Card berhasil ditambahkan.", card: newEntry.rows[0] });
  })
);

router.put(
  "/:id/board/cards/:cardId",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk mengedit card di board ini." });
    }

    const { title, date, description, output, kendala } = req.body;

    const result = await query(
      `
      UPDATE logbook_entries
      SET title = COALESCE($3, title),
          date = COALESCE($4, date),
          description = COALESCE($5, description),
          output = COALESCE($6, output),
          kendala = COALESCE($7, kendala),
          updated_at = NOW()
      WHERE id = $2 AND project_id = $1
      RETURNING id, title, date, description, output
      `,
      [req.params.id, req.params.cardId, title, date, description, output, kendala]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Card tidak ditemukan." });
    }

    res.json({ message: "Card berhasil diperbarui.", card: result.rows[0] });
  })
);

router.patch(
  "/:id/board/header",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mengubah header board riset." });
    }

    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah header board riset ini." });
    }

    const {
      title,
      shortTitle,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body || {};

    const result = await query(
      `
      UPDATE research_projects
      SET title = COALESCE($2, title),
          short_title = COALESCE($3, short_title),
          period_text = COALESCE($4, period_text),
          mitra = COALESCE($5, mitra),
          status = COALESCE($6, status),
          progress = COALESCE($7, progress),
          category = COALESCE($8, category),
          description = COALESCE($9, description),
          funding = COALESCE($10, funding),
          repositori = COALESCE($11, repositori),
          attachment_link = CASE
            WHEN $12::text = '' THEN NULL
            ELSE COALESCE($12, attachment_link)
          END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [
        req.params.id,
        title,
        shortTitle,
        periodText,
        mitra,
        status,
        progress,
        category,
        description,
        funding,
        repositori,
        attachmentLink
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    const snapshot = await fetchBoardSnapshot(req.params.id);
    res.json({ message: "Header board riset berhasil diperbarui.", project: snapshot.project });
  })
);

router.post(
  "/:id/board/tasks",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah task di board riset ini." });
    }

    const {
      id,
      title,
      description,
      status,
      deadline,
      priority,
      tag,
      assignee_ids,
      assigneeIds,
      progress,
      sortOrder
    } = req.body || {};

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "title task wajib diisi." });
    }

    const nextStatus = normalizeBoardTaskStatus(status);
    const nextSortOrder = Number.isFinite(Number(sortOrder))
      ? Number(sortOrder)
      : await getNextTaskSortOrder(req.params.id, nextStatus);
    const taskId = String(id || buildEntityId("TASK")).trim();
    const nextAssigneeIds = await validateAssigneeIds(assignee_ids ?? assigneeIds);

    await query(
      `
      INSERT INTO research_board_tasks (
        id, project_id, title, description, status, deadline, priority, tag, progress, sort_order, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        taskId,
        req.params.id,
        String(title).trim(),
        toNullableText(description),
        nextStatus,
        deadline || null,
        toNullableText(priority),
        toNullableText(tag),
        normalizeProgress(progress, 0),
        nextSortOrder,
        resolveRequesterUserId(req) || null
      ]
    );

    await setTaskAssignees(taskId, nextAssigneeIds);

    const task = await fetchTaskDetail(req.params.id, taskId);
    res.status(201).json({ message: "Task board berhasil ditambahkan.", task });
  })
);

router.get(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat detail task board." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    res.json(task);
  })
);

router.patch(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah task board." });
    }

    const existingTask = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!existingTask) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const detail = await fetchTaskDetail(req.params.id, req.params.taskId);
    const {
      title,
      description,
      status,
      deadline,
      priority,
      tag,
      assignee_ids,
      assigneeIds,
      progress,
      sortOrder
    } = req.body || {};

    const nextStatus = status !== undefined
      ? normalizeBoardTaskStatus(status, detail.status)
      : detail.status;
    const nextSortOrder = sortOrder !== undefined
      ? Number(sortOrder)
      : (nextStatus !== detail.status ? await getNextTaskSortOrder(req.params.id, nextStatus) : detail.sortOrder);
    const nextAssigneeIds = (assignee_ids !== undefined || assigneeIds !== undefined)
      ? await validateAssigneeIds(assignee_ids ?? assigneeIds)
      : detail.assignee_ids;

    await query(
      `
      UPDATE research_board_tasks
      SET title = $3,
          description = $4,
          status = $5,
          deadline = $6,
          priority = $7,
          tag = $8,
          progress = $9,
          sort_order = $10,
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      `,
      [
        req.params.id,
        req.params.taskId,
        title !== undefined ? String(title).trim() || detail.title : detail.title,
        description !== undefined ? toNullableText(description) : (detail.description || null),
        nextStatus,
        deadline !== undefined ? (deadline || null) : detail.deadline,
        priority !== undefined ? toNullableText(priority) : detail.priority,
        tag !== undefined ? toNullableText(tag) : detail.tag,
        progress !== undefined ? normalizeProgress(progress, detail.progress) : detail.progress,
        Number.isFinite(nextSortOrder) ? nextSortOrder : detail.sortOrder
      ]
    );

    await setTaskAssignees(req.params.taskId, nextAssigneeIds);

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Task board berhasil diperbarui.", task });
  })
);

router.patch(
  "/:id/board/tasks/:taskId/status",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak memindahkan status task board." });
    }

    const existingTask = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!existingTask) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const nextStatus = normalizeBoardTaskStatus(req.body?.status, existingTask.status);
    const nextSortOrder = Number.isFinite(Number(req.body?.sortOrder))
      ? Number(req.body.sortOrder)
      : await getNextTaskSortOrder(req.params.id, nextStatus);

    await query(
      `
      UPDATE research_board_tasks
      SET status = $3,
          sort_order = $4,
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      `,
      [req.params.id, req.params.taskId, nextStatus, nextSortOrder]
    );

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Status task board berhasil diperbarui.", task });

  })
);

router.delete(

  "/:id/board/cards/:cardId",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk menghapus card di board ini." });
    }

    // Delete associated comments first
    await query("DELETE FROM logbook_comments WHERE logbook_entry_id = $1", [req.params.cardId]);

    const result = await query(
      "DELETE FROM logbook_entries WHERE id = $1 AND project_id = $2 RETURNING id",
      [req.params.cardId, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Card tidak ditemukan." });
    }

    res.json({ message: "Card berhasil dihapus." });
  })
);

router.delete(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus task board." });
    }

    const attachmentRows = await query(
      `
      SELECT file_url
      FROM research_board_task_attachments
      WHERE task_id = $1
      `,
      [req.params.taskId]
    );

    const result = await query(
      `
      DELETE FROM research_board_tasks
      WHERE project_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.id, req.params.taskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    for (const row of attachmentRows.rows) {
      try {
        await removeBoardAttachmentFile(row.file_url);
      } catch {
        // Ignore orphaned file cleanup failures after DB delete succeeds.
      }
    }

    res.json({ message: "Task board berhasil dihapus." });
  })
);

router.post(
  "/:id/board/tasks/:taskId/subtasks",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah subtask." });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const { id, title, done = false, sortOrder } = req.body || {};
    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "title subtask wajib diisi." });
    }

    const subtaskId = String(id || buildEntityId("SUBTASK")).trim();
    const nextSortOrder = Number.isFinite(Number(sortOrder))
      ? Number(sortOrder)
      : (
          await query(
            `
            SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
            FROM research_board_task_subtasks
            WHERE task_id = $1
            `,
            [req.params.taskId]
          )
        ).rows[0]?.next_sort_order || 0;

    await query(
      `
      INSERT INTO research_board_task_subtasks (id, task_id, title, done, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [subtaskId, req.params.taskId, String(title).trim(), Boolean(done), Number(nextSortOrder)]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Subtask berhasil ditambahkan.",
      subtask: updatedTask?.subtasks.find((item) => item.id === subtaskId) || null,
      task: updatedTask
    });
  })
);

router.patch(
  "/:id/board/tasks/:taskId/subtasks/:subtaskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah subtask." });
    }

    const result = await query(
      `
      UPDATE research_board_task_subtasks
      SET title = COALESCE($3, title),
          done = COALESCE($4, done),
          sort_order = COALESCE($5, sort_order),
          updated_at = NOW()
      WHERE task_id = $1 AND id = $2
      RETURNING id
      `,
      [
        req.params.taskId,
        req.params.subtaskId,
        req.body?.title !== undefined ? String(req.body.title).trim() : null,
        req.body?.done !== undefined ? Boolean(req.body.done) : null,
        req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : null
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Subtask tidak ditemukan." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({
      message: "Subtask berhasil diperbarui.",
      subtask: task?.subtasks.find((item) => item.id === req.params.subtaskId) || null,
      task
    });
  })
);

router.delete(
  "/:id/board/tasks/:taskId/subtasks/:subtaskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus subtask." });
    }

    const result = await query(
      `
      DELETE FROM research_board_task_subtasks
      WHERE task_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.taskId, req.params.subtaskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Subtask tidak ditemukan." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Subtask berhasil dihapus.", task });
  })
);

router.post(
  "/:id/board/tasks/:taskId/attachments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah lampiran task." });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const { id, fileDataUrl, fileName } = req.body || {};
    if (!String(fileDataUrl || "").trim() || !String(fileName || "").trim()) {
      return res.status(400).json({ message: "fileDataUrl dan fileName wajib diisi." });
    }

    let uploadedAttachment;
    try {
      uploadedAttachment = await saveBoardAttachmentFile(String(fileDataUrl).trim(), String(fileName).trim());
    } catch (error) {
      return res.status(error?.statusCode || 400).json({
        message: error?.message || "Gagal upload lampiran task."
      });
    }

    const attachmentId = String(id || buildEntityId("TASKFILE")).trim();
    await query(
      `
      INSERT INTO research_board_task_attachments (
        id, task_id, file_url, file_name, file_size, mime_type, uploaded_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        attachmentId,
        req.params.taskId,
        uploadedAttachment.fileUrl,
        uploadedAttachment.fileName,
        uploadedAttachment.fileSize,
        uploadedAttachment.mimeType,
        resolveRequesterUserId(req) || null
      ]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Lampiran task berhasil ditambahkan.",
      attachment: updatedTask?.attachments.find((item) => item.id === attachmentId) || null,
      task: updatedTask
    });
  })
);

router.delete(
  "/:id/board/tasks/:taskId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus lampiran task." });
    }

    const result = await query(
      `
      DELETE FROM research_board_task_attachments
      WHERE task_id = $1 AND id = $2
      RETURNING id, file_url
      `,
      [req.params.taskId, req.params.attachmentId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Lampiran task tidak ditemukan." });
    }

    try {
      await removeBoardAttachmentFile(result.rows[0].file_url);
    } catch {
      // Metadata delete succeeded; ignore cleanup failure for now.
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Lampiran task berhasil dihapus.", task });
  })
);

router.get(
  "/:id/board/tasks/:taskId/comments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat komentar task." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    res.json(task.comments || []);
  })
);

router.post(
  "/:id/board/tasks/:taskId/comments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const role = extractRole(req);
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah komentar task." });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const authorId = String(req.body?.authorId || resolveRequesterUserId(req) || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!authorId || !text) {
      return res.status(400).json({ message: "authorId dan text wajib diisi." });
    }

    const commentId = String(req.body?.id || buildEntityId("TASKCMT")).trim();
    await query(
      `
      INSERT INTO research_board_task_comments (id, task_id, author_id, author_name, text)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [commentId, req.params.taskId, authorId, toNullableText(req.body?.authorName), text]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Komentar task berhasil ditambahkan.",
      comment: updatedTask?.comments.find((item) => item.id === commentId) || null,
      task: updatedTask
    });

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
    const actorUserId = resolveRequesterUserId(req) || null;
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

    await notifyMilestoneUpdate(req.params.id, actorUserId, "Menambahkan", label);

    res.status(201).json({ message: "Milestone berhasil ditambahkan.", id: result.rows[0].id });
  })
);

router.patch(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const actorUserId = resolveRequesterUserId(req) || null;
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak memperbarui milestone di riset ini." });
    }

    const { label, done, targetDate, sortOrder } = req.body;
    const existingMilestone = await query(
      `
      SELECT label
      FROM research_milestones
      WHERE project_id = $1 AND id = $2
      LIMIT 1
      `,
      [req.params.id, req.params.milestoneId]
    );

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

    await notifyMilestoneUpdate(
      req.params.id,
      actorUserId,
      "Memperbarui",
      String(label || existingMilestone.rows[0]?.label || "milestone").trim()
    );

    res.json({ message: "Milestone berhasil diperbarui." });
  })
);

router.delete(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const actorUserId = resolveRequesterUserId(req) || null;
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus milestone di riset ini." });
    }

    const existingMilestone = await query(
      `
      SELECT label
      FROM research_milestones
      WHERE project_id = $1 AND id = $2
      LIMIT 1
      `,
      [req.params.id, req.params.milestoneId]
    );

    const result = await query(
      "DELETE FROM research_milestones WHERE project_id = $1 AND id = $2 RETURNING id",
      [req.params.id, req.params.milestoneId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Milestone tidak ditemukan." });
    }

    await notifyMilestoneUpdate(
      req.params.id,
      actorUserId,
      "Menghapus",
      String(existingMilestone.rows[0]?.label || "milestone").trim()
    );

    res.json({ message: "Milestone berhasil dihapus." });
  })
);

module.exports = router;
