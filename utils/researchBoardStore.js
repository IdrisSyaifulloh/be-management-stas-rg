const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { query } = require("../db/pool");

const BOARD_TASK_UPLOAD_DIR = path.join(__dirname, "../public/uploads/board-tasks");
const MAX_BOARD_ATTACHMENT_SIZE = 15 * 1024 * 1024;
const ALLOWED_BOARD_ATTACHMENT_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "text/plain": ".txt",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip"
};
const BOARD_TASK_STATUSES = ["TO DO", "DOING", "REVIEW", "DONE"];

let ensureResearchBoardTablesPromise = null;

async function ensureResearchBoardTables() {
  if (!ensureResearchBoardTablesPromise) {
    ensureResearchBoardTablesPromise = (async () => {
      await query(`
        ALTER TABLE research_projects
        ADD COLUMN IF NOT EXISTS attachment_link TEXT
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_board_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'TO DO'
            CHECK (status IN ('TO DO', 'DOING', 'REVIEW', 'DONE')),
          deadline DATE,
          priority TEXT,
          tag TEXT,
          progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_board_task_assignees (
          task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (task_id, user_id)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_board_task_subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          done BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_board_task_attachments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          file_url TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_size BIGINT,
          mime_type TEXT,
          uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_board_task_comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          author_name TEXT,
          text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_status
        ON research_board_tasks(project_id, status, sort_order ASC, updated_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_updated
        ON research_board_tasks(project_id, updated_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_subtasks_task
        ON research_board_task_subtasks(task_id, sort_order ASC, created_at ASC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_attachments_task
        ON research_board_task_attachments(task_id, created_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_comments_task
        ON research_board_task_comments(task_id, created_at DESC)
      `);
    })();
  }

  await ensureResearchBoardTablesPromise;
}

function normalizeBoardTaskStatus(value, fallback = "TO DO") {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (normalized === "TODO") return "TO DO";
  if (BOARD_TASK_STATUSES.includes(normalized)) return normalized;
  return fallback;
}

function sanitizeFilenameBase(name) {
  return String(name || "lampiran-task")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "lampiran-task";
}

function resolveBoardAttachmentPath(fileUrl) {
  const normalizedUrl = String(fileUrl || "").trim();
  if (!normalizedUrl.startsWith("/uploads/board-tasks/")) return null;
  return path.join(BOARD_TASK_UPLOAD_DIR, normalizedUrl.replace("/uploads/board-tasks/", ""));
}

async function removeBoardAttachmentFile(fileUrl) {
  const targetPath = resolveBoardAttachmentPath(fileUrl);
  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveBoardAttachmentFile(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format lampiran task tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const extension = ALLOWED_BOARD_ATTACHMENT_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe lampiran task belum didukung.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    const error = new Error("Lampiran task base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (!buffer || buffer.length === 0) {
    const error = new Error("Lampiran task kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_BOARD_ATTACHMENT_SIZE) {
    const error = new Error("Ukuran lampiran task maksimal 15 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(BOARD_TASK_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(BOARD_TASK_UPLOAD_DIR, fileName), buffer);

  return {
    fileUrl: `/uploads/board-tasks/${fileName}`,
    fileName: originalFileName || `${baseName}${extension}`,
    fileSize: buffer.length,
    mimeType
  };
}

async function getNextTaskSortOrder(projectId, status) {
  const result = await query(
    `
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM research_board_tasks
    WHERE project_id = $1 AND status = $2
    `,
    [projectId, status]
  );

  return Number(result.rows[0]?.next_sort_order || 0);
}

async function setTaskAssignees(taskId, assigneeIds) {
  const uniqueAssigneeIds = Array.from(
    new Set(
      (Array.isArray(assigneeIds) ? assigneeIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  await query("DELETE FROM research_board_task_assignees WHERE task_id = $1", [taskId]);

  if (uniqueAssigneeIds.length === 0) return;

  for (const assigneeId of uniqueAssigneeIds) {
    await query(
      `
      INSERT INTO research_board_task_assignees (task_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (task_id, user_id) DO NOTHING
      `,
      [taskId, assigneeId]
    );
  }
}

function buildTaskDto(taskRow, maps, includeComments = false) {
  const assignees = maps.assignees.get(taskRow.id) || [];
  const subtasks = maps.subtasks.get(taskRow.id) || [];
  const attachments = maps.attachments.get(taskRow.id) || [];
  const comments = includeComments ? (maps.comments.get(taskRow.id) || []) : undefined;
  const commentsCount = Number(maps.commentsCount.get(taskRow.id) || 0);
  const completedSubtasks = subtasks.filter((item) => item.done).length;

  return {
    id: taskRow.id,
    project_id: taskRow.project_id,
    projectId: taskRow.project_id,
    title: taskRow.title,
    description: taskRow.description || "",
    status: taskRow.status,
    deadline: taskRow.deadline,
    priority: taskRow.priority,
    tag: taskRow.tag,
    assignee_ids: assignees.map((item) => item.user_id),
    assigneeIds: assignees.map((item) => item.user_id),
    assignees,
    progress: Number(taskRow.progress) || 0,
    comments_count: commentsCount,
    commentsCount,
    created_by: taskRow.created_by,
    createdBy: taskRow.created_by,
    created_by_name: taskRow.created_by_name,
    createdByName: taskRow.created_by_name,
    created_at: taskRow.created_at,
    createdAt: taskRow.created_at,
    updated_at: taskRow.updated_at,
    updatedAt: taskRow.updated_at,
    sort_order: Number(taskRow.sort_order) || 0,
    sortOrder: Number(taskRow.sort_order) || 0,
    subtasks,
    subtasks_count: subtasks.length,
    subtasksCount: subtasks.length,
    completed_subtasks: completedSubtasks,
    completedSubtasks,
    attachments,
    attachments_count: attachments.length,
    attachmentsCount: attachments.length,
    ...(includeComments ? { comments } : {})
  };
}

async function fetchTaskCollection(projectId, { includeComments = false } = {}) {
  await ensureResearchBoardTables();

  const taskResult = await query(
    `
    SELECT t.id, t.project_id, t.title, t.description, t.status, t.deadline, t.priority,
           t.tag, t.progress, t.created_by, t.created_at, t.updated_at, t.sort_order,
           u.name AS created_by_name
    FROM research_board_tasks t
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.project_id = $1
    ORDER BY t.status ASC, t.sort_order ASC, t.updated_at DESC, t.created_at DESC
    `,
    [projectId]
  );

  if (taskResult.rowCount === 0) {
    return [];
  }

  const taskIds = taskResult.rows.map((row) => row.id);
  const [assigneeResult, subtaskResult, attachmentResult, commentCountResult, commentResult] = await Promise.all([
    query(
      `
      SELECT a.task_id, a.user_id, u.name, u.initials, u.role
      FROM research_board_task_assignees a
      JOIN users u ON u.id = a.user_id
      WHERE a.task_id = ANY($1::text[])
      ORDER BY u.name ASC
      `,
      [taskIds]
    ),
    query(
      `
      SELECT st.id, st.task_id, st.title, st.done, st.sort_order, st.created_at, st.updated_at
      FROM research_board_task_subtasks st
      WHERE st.task_id = ANY($1::text[])
      ORDER BY st.sort_order ASC, st.created_at ASC, st.id ASC
      `,
      [taskIds]
    ),
    query(
      `
      SELECT at.id, at.task_id, at.file_url, at.file_name, at.file_size, at.mime_type, at.uploaded_by, at.created_at
      FROM research_board_task_attachments at
      WHERE at.task_id = ANY($1::text[])
      ORDER BY at.created_at DESC, at.id DESC
      `,
      [taskIds]
    ),
    query(
      `
      SELECT c.task_id, COUNT(*)::int AS comments_count
      FROM research_board_task_comments c
      WHERE c.task_id = ANY($1::text[])
      GROUP BY c.task_id
      `,
      [taskIds]
    ),
    includeComments
      ? query(
          `
          SELECT c.id, c.task_id, c.author_id, COALESCE(c.author_name, u.name) AS author_name,
                 c.text, c.created_at, c.updated_at
          FROM research_board_task_comments c
          LEFT JOIN users u ON u.id = c.author_id
          WHERE c.task_id = ANY($1::text[])
          ORDER BY c.created_at DESC, c.id DESC
          `,
          [taskIds]
        )
      : Promise.resolve({ rows: [] })
  ]);

  const maps = {
    assignees: new Map(),
    subtasks: new Map(),
    attachments: new Map(),
    commentsCount: new Map(),
    comments: new Map()
  };

  assigneeResult.rows.forEach((row) => {
    if (!maps.assignees.has(row.task_id)) maps.assignees.set(row.task_id, []);
    maps.assignees.get(row.task_id).push({
      user_id: row.user_id,
      userId: row.user_id,
      name: row.name,
      initials: row.initials,
      role: row.role
    });
  });

  subtaskResult.rows.forEach((row) => {
    if (!maps.subtasks.has(row.task_id)) maps.subtasks.set(row.task_id, []);
    maps.subtasks.get(row.task_id).push({
      id: row.id,
      task_id: row.task_id,
      taskId: row.task_id,
      title: row.title,
      done: Boolean(row.done),
      sort_order: Number(row.sort_order) || 0,
      sortOrder: Number(row.sort_order) || 0,
      created_at: row.created_at,
      createdAt: row.created_at,
      updated_at: row.updated_at,
      updatedAt: row.updated_at
    });
  });

  attachmentResult.rows.forEach((row) => {
    if (!maps.attachments.has(row.task_id)) maps.attachments.set(row.task_id, []);
    maps.attachments.get(row.task_id).push({
      id: row.id,
      task_id: row.task_id,
      taskId: row.task_id,
      file_url: row.file_url,
      fileUrl: row.file_url,
      file_name: row.file_name,
      fileName: row.file_name,
      file_size: row.file_size != null ? Number(row.file_size) : null,
      fileSize: row.file_size != null ? Number(row.file_size) : null,
      mime_type: row.mime_type,
      mimeType: row.mime_type,
      uploaded_by: row.uploaded_by,
      uploadedBy: row.uploaded_by,
      created_at: row.created_at,
      createdAt: row.created_at
    });
  });

  commentCountResult.rows.forEach((row) => {
    maps.commentsCount.set(row.task_id, Number(row.comments_count) || 0);
  });

  commentResult.rows.forEach((row) => {
    if (!maps.comments.has(row.task_id)) maps.comments.set(row.task_id, []);
    maps.comments.get(row.task_id).push({
      id: row.id,
      task_id: row.task_id,
      taskId: row.task_id,
      author_id: row.author_id,
      authorId: row.author_id,
      author_name: row.author_name,
      authorName: row.author_name,
      text: row.text,
      created_at: row.created_at,
      createdAt: row.created_at,
      updated_at: row.updated_at,
      updatedAt: row.updated_at
    });
  });

  return taskResult.rows.map((row) => buildTaskDto(row, maps, includeComments));
}

async function fetchTaskDetail(projectId, taskId) {
  const tasks = await fetchTaskCollection(projectId, { includeComments: true });
  return tasks.find((task) => task.id === taskId) || null;
}

async function fetchBoardSnapshot(projectId) {
  await ensureResearchBoardTables();

  const [projectResult, tasks] = await Promise.all([
    query(
      `
      SELECT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status, rp.progress,
             rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
             l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
      FROM research_projects rp
      LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
      LEFT JOIN users u ON u.id = l.user_id
      WHERE rp.id = $1
      LIMIT 1
      `,
      [projectId]
    ),
    fetchTaskCollection(projectId)
  ]);

  const columns = {
    todo: [],
    doing: [],
    review: [],
    done: []
  };

  tasks.forEach((task) => {
    if (task.status === "TO DO") columns.todo.push(task);
    else if (task.status === "DOING") columns.doing.push(task);
    else if (task.status === "REVIEW") columns.review.push(task);
    else columns.done.push(task);
  });

  return {
    projectId,
    project: projectResult.rows[0] || null,
    tasks,
    columns,
    counts: {
      todo: columns.todo.length,
      doing: columns.doing.length,
      review: columns.review.length,
      done: columns.done.length
    }
  };
}

module.exports = {
  BOARD_TASK_STATUSES,
  ensureResearchBoardTables,
  fetchBoardSnapshot,
  fetchTaskDetail,
  getNextTaskSortOrder,
  normalizeBoardTaskStatus,
  removeBoardAttachmentFile,
  saveBoardAttachmentFile,
  setTaskAssignees
};
