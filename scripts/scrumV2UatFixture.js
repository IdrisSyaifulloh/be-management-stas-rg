const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { assertStagingEquivalentTarget } = require("./scrumV2DatabaseSafety");

const PREFIX = "UAT-SCRUM-V2";
const ids = {
  operator: `${PREFIX}-OPERATOR`,
  lecturerUser: `${PREFIX}-DOSEN-USER`,
  lecturer: `${PREFIX}-DOSEN`,
  studentUser: `${PREFIX}-MAHASISWA-USER`,
  student: `${PREFIX}-MAHASISWA`,
  project: `${PREFIX}-PROJECT`,
  web: `${PREFIX}-DIV-WEB`,
  data: `${PREFIX}-DIV-DATA`,
  qa: `${PREFIX}-DIV-QA`,
  planning: `${PREFIX}-SPRINT-PLANNING`,
  active: `${PREFIX}-SPRINT-ACTIVE`,
  review: `${PREFIX}-SPRINT-REVIEW`,
  closed: `${PREFIX}-SPRINT-CLOSED`,
  backlogTask: `${PREFIX}-TASK-BACKLOG`,
  activeTask: `${PREFIX}-TASK-ACTIVE`,
  carryTask: `${PREFIX}-TASK-CARRY`,
  githubTask: `${PREFIX}-TASK-GITHUB`,
  repository: `${PREFIX}-REPOSITORY`
};

async function cleanup(client) {
  await client.query("DELETE FROM research_projects WHERE id = $1", [ids.project]);
  await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [[ids.operator, ids.lecturerUser, ids.studentUser]]);
}

async function createFixture(client, passwordHash) {
  await cleanup(client);
  await client.query(
    `INSERT INTO users (id,name,initials,role,email,password_hash,is_active)
     VALUES ($1,'UAT Scrum Operator','UO','operator','uat-scrum-operator@example.test',$4,TRUE),
            ($2,'UAT Scrum Dosen','UD','dosen','uat-scrum-dosen@example.test',$4,TRUE),
            ($3,'UAT Scrum Mahasiswa','UM','mahasiswa','uat-scrum-mahasiswa@example.test',$4,TRUE)`,
    [ids.operator, ids.lecturerUser, ids.studentUser, passwordHash]
  );
  await client.query(
    "INSERT INTO lecturers (id,user_id,nip,status) VALUES ($1,$2,'UAT-SCRUM-V2-NIP','Aktif')",
    [ids.lecturer, ids.lecturerUser]
  );
  await client.query(
    "INSERT INTO students (id,user_id,nim,status,tipe,bergabung) VALUES ($1,$2,'UAT-SCRUM-V2-NIM','Aktif','Riset',CURRENT_DATE)",
    [ids.student, ids.studentUser]
  );
  await client.query(
    "INSERT INTO research_projects (id,title,short_title,supervisor_lecturer_id,status,description) VALUES ($1,'UAT Scrum V2 Synthetic Project','UAT Scrum V2',$2,'Aktif','Synthetic staging/UAT fixture only')",
    [ids.project, ids.lecturer]
  );
  await client.query(
    `INSERT INTO research_memberships (project_id,user_id,member_type,peran,status)
     VALUES ($1,$2,'Dosen','Pembimbing','Aktif'),($1,$3,'Mahasiswa','Developer','Aktif')`,
    [ids.project, ids.lecturerUser, ids.studentUser]
  );
  await client.query(
    `INSERT INTO research_divisions (id,project_id,name,sort_order)
     VALUES ($2,$1,'Web',1),($3,$1,'Data',2),($4,$1,'QA',3)`,
    [ids.project, ids.web, ids.data, ids.qa]
  );
  await client.query(
    `INSERT INTO research_sprints (id,project_id,name,goal,start_date,end_date,status,review_started_at,closed_at)
     VALUES ($2,$1,'Planning Sprint','Next iteration',CURRENT_DATE + 14,CURRENT_DATE + 27,'planning',NULL,NULL),
            ($3,$1,'Active Sprint','Current delivery',CURRENT_DATE,CURRENT_DATE + 13,'active',NULL,NULL),
            ($4,$1,'Review Sprint','Awaiting review',CURRENT_DATE - 14,CURRENT_DATE - 1,'review',NOW(),NULL),
            ($5,$1,'Closed Sprint','Historical iteration',CURRENT_DATE - 28,CURRENT_DATE - 15,'closed',NOW() - INTERVAL '14 days',NOW() - INTERVAL '13 days')`,
    [ids.project, ids.planning, ids.active, ids.review, ids.closed]
  );
  await client.query(
    `INSERT INTO research_board_tasks (id,task_key,project_id,title,status,progress,sort_order,created_by,division_id,sprint_id,story_points)
     VALUES ($2,'TASK-900001',$1,'Product backlog example','TO DO',0,1,$6,$7,NULL,3),
            ($3,'TASK-900002',$1,'Active sprint implementation','DOING',45,2,$6,$7,$8,5),
            ($4,'TASK-900003',$1,'Carry-over from closed sprint','DOING',60,3,$6,$9,$10,8),
            ($5,'TASK-900004',$1,'GitHub-linked task','REVIEW',80,4,$6,$7,$8,5)`,
    [ids.project, ids.backlogTask, ids.activeTask, ids.carryTask, ids.githubTask, ids.operator, ids.web, ids.active, ids.data, ids.planning]
  );
  await client.query(
    `INSERT INTO research_board_task_assignees (task_id,user_id)
     VALUES ($1,$5),($2,$5),($3,$5),($4,$5)`,
    [ids.backlogTask, ids.activeTask, ids.carryTask, ids.githubTask, ids.studentUser]
  );
  await client.query(
    `INSERT INTO research_sprint_task_assignments
       (id,sprint_id,task_id,division_id_at_assignment,division_name_at_assignment,story_points_at_assignment,status_at_assignment,outcome,target_sprint_id,status_at_close,progress_at_close,closed_at)
     VALUES ($1,$2,$3,$4,'Data',8,'DOING','carry_over',$5,'DOING',60,NOW() - INTERVAL '13 days'),
            ($6,$5,$3,$4,'Data',8,'DOING','pending',NULL,NULL,NULL,NULL),
            ($7,$8,$9,$10,'Web',5,'DOING','pending',NULL,NULL,NULL,NULL),
            ($11,$8,$12,$10,'Web',5,'REVIEW','pending',NULL,NULL,NULL,NULL)`,
    [
      `${PREFIX}-LEDGER-CLOSED-CARRY`, ids.closed, ids.carryTask, ids.data, ids.planning,
      `${PREFIX}-LEDGER-PLANNING-CARRY`, `${PREFIX}-LEDGER-ACTIVE-1`, ids.active, ids.activeTask, ids.web,
      `${PREFIX}-LEDGER-ACTIVE-2`, ids.githubTask
    ]
  );
  await client.query(
    `INSERT INTO research_sprint_summaries (id,sprint_id,summary,achievements,challenges,lessons_learned,next_sprint_plan,is_finalized,created_by,finalized_by,finalized_at)
     VALUES ($1,$2,'Historical UAT summary','Completed baseline','Synthetic blocker','Verify rollback','Continue planning',TRUE,$3,$3,NOW() - INTERVAL '13 days'),
            ($4,$5,'Review-stage UAT summary','Feature ready','Pending UAT','Keep fixtures isolated','Run manual UAT',FALSE,$3,NULL,NULL)`,
    [`${PREFIX}-SUMMARY-CLOSED`, ids.closed, ids.operator, `${PREFIX}-SUMMARY-REVIEW`, ids.review]
  );
  await client.query(
    `INSERT INTO research_repositories (id,project_id,division_id,github_owner,github_repo,github_repository_id,default_branch,is_private,is_active,created_by)
     VALUES ($1,$2,$3,'uat-synthetic','scrum-v2-fixture','900004','main',FALSE,TRUE,$4)`,
    [ids.repository, ids.project, ids.web, ids.operator]
  );
  await client.query(
    `INSERT INTO research_task_repository_links (id,task_id,repository_id,branch_name,link_source,created_by)
     VALUES ($1,$2,$3,'feature/TASK-900004-uat','manual',$4)`,
    [`${PREFIX}-TASK-REPO-LINK`, ids.githubTask, ids.repository, ids.operator]
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || null;
  assertStagingEquivalentTarget(databaseUrl);
  const { pool } = require("../db/pool");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (process.argv.includes("--cleanup")) {
      await cleanup(client);
      await client.query("COMMIT");
      console.log(`Removed fixture ${PREFIX}.`);
      return;
    }
    const suppliedPassword = process.env.UAT_FIXTURE_PASSWORD;
    const temporaryPassword = suppliedPassword || crypto.randomBytes(24).toString("base64url");
    if (temporaryPassword.length < 12) throw new Error("UAT_FIXTURE_PASSWORD must contain at least 12 characters.");
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    await createFixture(client, passwordHash);
    await client.query("COMMIT");
    console.log(`Created fixture ${PREFIX}.`);
    if (!suppliedPassword) console.log(`Temporary UAT password (shown once): ${temporaryPassword}`);
    else console.log("Credential source: UAT_FIXTURE_PASSWORD (value not printed).");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Scrum V2 UAT fixture failed: ${String(error?.message || "Unknown error").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")}`);
    process.exitCode = 1;
  });
}

module.exports = { PREFIX, createFixture, cleanup, ids };
