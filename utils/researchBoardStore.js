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
  "text/plain": ".txt"
};
const BOARD_TASK_STATUSES = ["TO DO", "DOING", "REVIEW", "DONE"];

let ensureResearchBoardTablesPromise = null;

function runQuery(executor, text, params) {
  if (typeof executor === "function") return executor(text, params);
  return executor.query(text, params);
}

async function ensureResearchBoardTables() {
  if (!ensureResearchBoardTablesPromise) {
    ensureResearchBoardTablesPromise = (async () => {
      await query(`
        ALTER TABLE research_projects
        ADD COLUMN IF NOT EXISTS attachment_link TEXT,
        ADD COLUMN IF NOT EXISTS research_type TEXT CHECK (research_type IN ('Internal', 'Eksternal')),
        ADD COLUMN IF NOT EXISTS agreement_type TEXT CHECK (agreement_type IN ('PKS', 'MoU', 'MoA')),
        ADD COLUMN IF NOT EXISTS agreement_start_date DATE,
        ADD COLUMN IF NOT EXISTS agreement_end_date DATE,
        ADD COLUMN IF NOT EXISTS agreement_file_url TEXT,
        ADD COLUMN IF NOT EXISTS proposal_file_url TEXT,
        ADD COLUMN IF NOT EXISTS rab_file_url TEXT
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_divisions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_research_divisions_project_name_ci
        ON research_divisions(project_id, LOWER(name));

        CREATE INDEX IF NOT EXISTS idx_research_divisions_project_active_sort
        ON research_divisions(project_id, is_active, sort_order, name)
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_sprints (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          goal TEXT,
          start_date DATE,
          end_date DATE,
          status TEXT NOT NULL DEFAULT 'planning'
            CHECK (status IN ('planning', 'active', 'review', 'closed')),
          review_started_at TIMESTAMPTZ,
          closed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        ALTER TABLE research_sprints
          ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

        DO $$
        DECLARE constraint_record RECORD;
        BEGIN
          FOR constraint_record IN
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'research_sprints'::regclass
              AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%status%'
          LOOP
            EXECUTE format('ALTER TABLE research_sprints DROP CONSTRAINT %I', constraint_record.conname);
          END LOOP;
        END $$;

        UPDATE research_sprints
        SET status = 'closed',
            closed_at = COALESCE(closed_at, updated_at, NOW()),
            updated_at = NOW()
        WHERE status = 'completed';

        ALTER TABLE research_sprints
          ADD CONSTRAINT research_sprints_status_check
          CHECK (status IN ('planning', 'active', 'review', 'closed'));

        CREATE UNIQUE INDEX IF NOT EXISTS uq_research_sprints_one_active_per_project
        ON research_sprints(project_id)
        WHERE status = 'active'
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
          division_id TEXT REFERENCES research_divisions(id) ON DELETE SET NULL,
          sprint_id TEXT REFERENCES research_sprints(id) ON DELETE SET NULL,
          story_points INTEGER DEFAULT NULL,
          cancelled_at TIMESTAMPTZ,
          cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE SEQUENCE IF NOT EXISTS research_board_task_key_seq;
        ALTER TABLE research_board_tasks ADD COLUMN IF NOT EXISTS task_key TEXT;
        SELECT setval('research_board_task_key_seq', GREATEST(COALESCE((SELECT MAX(CASE WHEN task_key ~ '^TASK-[0-9]+$' THEN SUBSTRING(task_key FROM 6)::bigint END) FROM research_board_tasks), 1), 1), (SELECT COUNT(*) > 0 FROM research_board_tasks));
        UPDATE research_board_tasks SET task_key = 'TASK-' || nextval('research_board_task_key_seq')::text WHERE task_key IS NULL;
        ALTER TABLE research_board_tasks ALTER COLUMN task_key SET DEFAULT ('TASK-' || nextval('research_board_task_key_seq')::text);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_research_board_tasks_task_key ON research_board_tasks(task_key);
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_repositories (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          division_id TEXT REFERENCES research_divisions(id) ON DELETE SET NULL, provider TEXT NOT NULL DEFAULT 'github' CHECK (provider = 'github'),
          github_owner TEXT NOT NULL, github_repo TEXT NOT NULL, github_repository_id TEXT, github_installation_id TEXT,
          default_branch TEXT NOT NULL DEFAULT 'main', is_private BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(project_id, provider, github_owner, github_repo)
        );
        CREATE TABLE IF NOT EXISTS research_task_repository_links (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL REFERENCES research_repositories(id) ON DELETE CASCADE, branch_name TEXT, pull_request_number INTEGER,
          link_source TEXT NOT NULL DEFAULT 'manual' CHECK (link_source IN ('manual','auto_branch','auto_commit','auto_pr')),
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(task_id, repository_id)
        );
        CREATE TABLE IF NOT EXISTS research_github_webhook_deliveries (
          delivery_id TEXT PRIMARY KEY, event_name TEXT, repository_id TEXT REFERENCES research_repositories(id) ON DELETE SET NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')), error_message TEXT
        );
        CREATE TABLE IF NOT EXISTS research_github_activities (
          id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES research_repositories(id) ON DELETE CASCADE, task_id TEXT REFERENCES research_board_tasks(id) ON DELETE SET NULL,
          delivery_id TEXT NOT NULL REFERENCES research_github_webhook_deliveries(delivery_id) ON DELETE CASCADE, activity_type TEXT NOT NULL, github_event_id TEXT,
          github_actor_login TEXT, branch_name TEXT, commit_sha TEXT, commit_message TEXT, pull_request_number INTEGER, pull_request_title TEXT,
          pull_request_state TEXT, pull_request_merged BOOLEAN, html_url TEXT, occurred_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), suggested_task_status TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_research_repositories_project ON research_repositories(project_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_research_task_repository_links_task ON research_task_repository_links(task_id);
        CREATE INDEX IF NOT EXISTS idx_research_github_activities_repo_time ON research_github_activities(repository_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_research_github_activities_task_time ON research_github_activities(task_id, occurred_at DESC);
      `);

      await query(`
        ALTER TABLE research_board_tasks
        ADD COLUMN IF NOT EXISTS division_id TEXT,
        ADD COLUMN IF NOT EXISTS sprint_id TEXT,
        ADD COLUMN IF NOT EXISTS story_points INTEGER DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'research_board_tasks'::regclass
            AND conname = 'research_board_tasks_cancelled_by_fkey'
        ) THEN
          ALTER TABLE research_board_tasks
            ADD CONSTRAINT research_board_tasks_cancelled_by_fkey
            FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'research_board_tasks'::regclass
              AND conname = 'research_board_tasks_division_id_fkey'
          ) THEN
            ALTER TABLE research_board_tasks
              ADD CONSTRAINT research_board_tasks_division_id_fkey
              FOREIGN KEY (division_id) REFERENCES research_divisions(id) ON DELETE SET NULL;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'research_board_tasks'::regclass
              AND conname = 'research_board_tasks_sprint_id_fkey'
          ) THEN
            ALTER TABLE research_board_tasks
              ADD CONSTRAINT research_board_tasks_sprint_id_fkey
              FOREIGN KEY (sprint_id) REFERENCES research_sprints(id) ON DELETE SET NULL;
          END IF;
        END $$
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_sprint_task_assignments (
          id TEXT PRIMARY KEY,
          sprint_id TEXT NOT NULL REFERENCES research_sprints(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
          division_id_at_assignment TEXT,
          division_name_at_assignment TEXT,
          story_points_at_assignment INTEGER,
          status_at_assignment TEXT,
          status_at_close TEXT,
          progress_at_close INTEGER,
          outcome TEXT NOT NULL DEFAULT 'pending'
            CHECK (outcome IN ('pending', 'done', 'carry_over', 'backlog', 'cancelled')),
          target_sprint_id TEXT REFERENCES research_sprints(id) ON DELETE SET NULL,
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          UNIQUE(sprint_id, task_id)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS research_sprint_summaries (
          id TEXT PRIMARY KEY,
          sprint_id TEXT NOT NULL UNIQUE REFERENCES research_sprints(id) ON DELETE CASCADE,
          summary TEXT NOT NULL DEFAULT '',
          achievements TEXT,
          challenges TEXT,
          lessons_learned TEXT,
          next_sprint_plan TEXT,
          is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          finalized_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finalized_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS research_sprint_review_meetings (
          id TEXT PRIMARY KEY,
          sprint_id TEXT NOT NULL UNIQUE REFERENCES research_sprints(id) ON DELETE CASCADE,
          meeting_date DATE,
          start_time TIME,
          location TEXT,
          meeting_link TEXT,
          chair_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          agenda TEXT,
          notes TEXT,
          decisions TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS research_sprint_review_attendees (
          meeting_id TEXT NOT NULL REFERENCES research_sprint_review_meetings(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name_snapshot TEXT NOT NULL,
          role_snapshot TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (meeting_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS research_sprint_member_evaluations (
          id TEXT PRIMARY KEY,
          sprint_id TEXT NOT NULL REFERENCES research_sprints(id) ON DELETE CASCADE,
          evaluated_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          task_completion INTEGER NOT NULL CHECK (task_completion BETWEEN 1 AND 10),
          quality INTEGER NOT NULL CHECK (quality BETWEEN 1 AND 10),
          timeliness INTEGER NOT NULL CHECK (timeliness BETWEEN 1 AND 10),
          collaboration INTEGER NOT NULL CHECK (collaboration BETWEEN 1 AND 10),
          initiative INTEGER NOT NULL CHECK (initiative BETWEEN 1 AND 10),
          overall_score NUMERIC(4,2) NOT NULL CHECK (overall_score >= 1 AND overall_score <= 10),
          notes TEXT NOT NULL,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (sprint_id, evaluated_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_research_sprint_summaries_sprint ON research_sprint_summaries(sprint_id);
        CREATE INDEX IF NOT EXISTS idx_research_sprint_review_meetings_sprint ON research_sprint_review_meetings(sprint_id);
        CREATE INDEX IF NOT EXISTS idx_research_sprint_evaluations_sprint ON research_sprint_member_evaluations(sprint_id);
        CREATE INDEX IF NOT EXISTS idx_research_sprint_evaluations_user ON research_sprint_member_evaluations(evaluated_user_id)
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

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_sprints_project
        ON research_sprints(project_id, status, created_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_tasks_sprint
        ON research_board_tasks(sprint_id)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_division_status_sort
        ON research_board_tasks(project_id, division_id, status, sort_order);

        CREATE INDEX IF NOT EXISTS idx_research_sprint_task_assignments_task
        ON research_sprint_task_assignments(task_id, assigned_at DESC);

        CREATE INDEX IF NOT EXISTS idx_research_sprint_task_assignments_sprint_outcome
        ON research_sprint_task_assignments(sprint_id, outcome, assigned_at)
      `);

      await query(`
        INSERT INTO research_sprint_task_assignments (
          id, sprint_id, task_id, division_id_at_assignment, division_name_at_assignment,
          story_points_at_assignment, status_at_assignment
        )
        SELECT 'SPRINT-TASK-' || MD5(task.sprint_id || ':' || task.id),
               task.sprint_id, task.id, task.division_id, division.name,
               task.story_points, task.status
        FROM research_board_tasks task
        LEFT JOIN research_divisions division ON division.id = task.division_id
        WHERE task.sprint_id IS NOT NULL
        ON CONFLICT (sprint_id, task_id) DO NOTHING
      `);
    })();
  }

  await ensureResearchBoardTablesPromise;
}

function formatDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function withResearchDocumentFields(row) {
  if (!row) return row;

  const agreementStartDate = formatDateOnly(row.agreement_start_date);
  const agreementEndDate = formatDateOnly(row.agreement_end_date);

  return {
    ...row,
    research_type: row.research_type ?? null,
    researchType: row.research_type ?? null,
    agreement_type: row.agreement_type ?? null,
    agreementType: row.agreement_type ?? null,
    agreement_start_date: agreementStartDate,
    agreementStartDate,
    agreement_end_date: agreementEndDate,
    agreementEndDate,
    agreement_file_url: row.agreement_file_url ?? null,
    agreementFileUrl: row.agreement_file_url ?? null,
    proposal_file_url: row.proposal_file_url ?? null,
    proposalFileUrl: row.proposal_file_url ?? null,
    rab_file_url: row.rab_file_url ?? null,
    rabFileUrl: row.rab_file_url ?? null
  };
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
  // Gunakan path.basename() untuk cegah path traversal (../ dll)
  const filename = path.basename(normalizedUrl);
  if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) return null;
  return path.join(BOARD_TASK_UPLOAD_DIR, filename);
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

async function setTaskAssignees(taskId, assigneeIds, executor = query) {
  const uniqueAssigneeIds = Array.from(
    new Set(
      (Array.isArray(assigneeIds) ? assigneeIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );

  await runQuery(executor, "DELETE FROM research_board_task_assignees WHERE task_id = $1", [taskId]);

  if (uniqueAssigneeIds.length === 0) return;

  for (const assigneeId of uniqueAssigneeIds) {
    await runQuery(
      executor,
      `
      INSERT INTO research_board_task_assignees (task_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (task_id, user_id) DO NOTHING
      `,
      [taskId, assigneeId]
    );
  }
}

async function upsertSprintTaskAssignment({ taskId, sprintId, executor = query }) {
  if (!sprintId) return null;
  const snapshot = await runQuery(
    executor,
    `
    SELECT task.id AS task_id, task.sprint_id, task.division_id, division.name AS division_name,
           task.story_points, task.status
    FROM research_board_tasks task
    LEFT JOIN research_divisions division ON division.id = task.division_id
    WHERE task.id = $1 AND task.sprint_id = $2
    LIMIT 1
    `,
    [taskId, sprintId]
  );
  if (snapshot.rowCount === 0) return null;
  const row = snapshot.rows[0];
  const result = await runQuery(
    executor,
    `
    INSERT INTO research_sprint_task_assignments (
      id, sprint_id, task_id, division_id_at_assignment, division_name_at_assignment,
      story_points_at_assignment, status_at_assignment
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (sprint_id, task_id)
    DO UPDATE SET division_id_at_assignment = EXCLUDED.division_id_at_assignment,
                  division_name_at_assignment = EXCLUDED.division_name_at_assignment,
                  story_points_at_assignment = EXCLUDED.story_points_at_assignment,
                  status_at_assignment = EXCLUDED.status_at_assignment
    WHERE EXISTS (
      SELECT 1 FROM research_sprints sprint
      WHERE sprint.id = EXCLUDED.sprint_id AND sprint.status = 'planning'
    )
    RETURNING *
    `,
    [
      `SPRINT-TASK-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      sprintId,
      taskId,
      row.division_id,
      row.division_name,
      row.story_points,
      row.status
    ]
  );
  return result.rows[0] || null;
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
    task_key: taskRow.task_key,
    taskKey: taskRow.task_key,
    project_id: taskRow.project_id,
    projectId: taskRow.project_id,
    title: taskRow.title,
    description: taskRow.description || "",
    status: taskRow.status,
    deadline: taskRow.deadline,
    priority: taskRow.priority,
    tag: taskRow.tag,
    sprint_id: taskRow.sprint_id ?? null,
    sprintId: taskRow.sprint_id ?? null,
    division_id: taskRow.division_id ?? null,
    divisionId: taskRow.division_id ?? null,
    division_name: taskRow.division_name ?? null,
    divisionName: taskRow.division_name ?? null,
    division_is_active: taskRow.division_is_active == null ? null : taskRow.division_is_active === true,
    divisionIsActive: taskRow.division_is_active == null ? null : taskRow.division_is_active === true,
    story_points: taskRow.story_points !== null && taskRow.story_points !== undefined ? Number(taskRow.story_points) : null,
    storyPoints: taskRow.story_points !== null && taskRow.story_points !== undefined ? Number(taskRow.story_points) : null,
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
    SELECT t.id, t.task_key, t.project_id, t.title, t.description, t.status, t.deadline, t.priority,
           t.tag, t.progress, t.created_by, t.created_at, t.updated_at, t.sort_order,
           t.sprint_id, t.story_points, t.division_id,
           division.name AS division_name, division.is_active AS division_is_active,
           u.name AS created_by_name
    FROM research_board_tasks t
    LEFT JOIN users u ON u.id = t.created_by
    LEFT JOIN research_divisions division ON division.id = t.division_id
    WHERE t.project_id = $1
    ORDER BY t.status ASC, t.sort_order ASC, t.updated_at DESC, t.created_at DESC
    LIMIT 500
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
             rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date,
             rp.agreement_file_url, rp.proposal_file_url, rp.rab_file_url,
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
    project: withResearchDocumentFields(projectResult.rows[0] || null),
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

async function fetchProjectSprints(projectId) {
  await ensureResearchBoardTables();

  const result = await query(
    `
    SELECT s.id, s.project_id, s.name, s.goal, s.start_date, s.end_date, s.status,
           s.review_started_at, s.closed_at, s.created_at, s.updated_at,
           COUNT(t.id)::int AS total_tasks,
           COUNT(CASE WHEN t.status = 'DONE' THEN 1 END)::int AS completed_tasks,
           COALESCE(SUM(t.story_points), 0)::int AS total_points,
           COALESCE(SUM(CASE WHEN t.status = 'DONE' THEN t.story_points ELSE 0 END), 0)::int AS completed_points
    FROM research_sprints s
    LEFT JOIN research_board_tasks t ON t.sprint_id = s.id
    WHERE s.project_id = $1
    GROUP BY s.id
    ORDER BY 
      CASE s.status 
        WHEN 'active' THEN 1 
        WHEN 'review' THEN 2
        WHEN 'planning' THEN 3
        WHEN 'closed' THEN 4
        ELSE 5
      END,
      s.created_at DESC
    `,
    [projectId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    project_id: row.project_id,
    name: row.name,
    goal: row.goal || "",
    startDate: formatDateOnly(row.start_date),
    start_date: formatDateOnly(row.start_date),
    endDate: formatDateOnly(row.end_date),
    end_date: formatDateOnly(row.end_date),
    status: row.status,
    reviewStartedAt: row.review_started_at,
    review_started_at: row.review_started_at,
    closedAt: row.closed_at,
    closed_at: row.closed_at,
    totalTasks: Number(row.total_tasks) || 0,
    total_tasks: Number(row.total_tasks) || 0,
    completedTasks: Number(row.completed_tasks) || 0,
    completed_tasks: Number(row.completed_tasks) || 0,
    totalPoints: Number(row.total_points) || 0,
    total_points: Number(row.total_points) || 0,
    completedPoints: Number(row.completed_points) || 0,
    completed_points: Number(row.completed_points) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

module.exports = {
  BOARD_TASK_STATUSES,
  ensureResearchBoardTables,
  fetchBoardSnapshot,
  fetchTaskDetail,
  fetchTaskCollection,
  fetchProjectSprints,
  getNextTaskSortOrder,
  normalizeBoardTaskStatus,
  removeBoardAttachmentFile,
  saveBoardAttachmentFile,
  setTaskAssignees,
  upsertSprintTaskAssignment
};
