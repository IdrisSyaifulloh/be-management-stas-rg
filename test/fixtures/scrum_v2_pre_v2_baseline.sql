BEGIN;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('mahasiswa', 'dosen', 'operator')),
  email TEXT UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE research_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  short_title TEXT,
  status TEXT NOT NULL DEFAULT 'Aktif',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE research_board_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'TO DO' CHECK (status IN ('TO DO', 'DOING', 'REVIEW', 'DONE')),
  deadline DATE,
  priority TEXT,
  tag TEXT,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users (id, name, initials, role, email)
VALUES ('SCRUM-V2-BASELINE-OPERATOR', 'Baseline Operator', 'BO', 'operator', 'baseline-operator@example.test');

INSERT INTO research_projects (id, title, short_title, status)
VALUES ('SCRUM-V2-MIGRATION-PROJECT', 'Pre-V2 Migration Fixture', 'V2 Fixture', 'Aktif');

INSERT INTO research_board_tasks (id, project_id, title, status, created_by)
VALUES ('SCRUM-V2-BASELINE-TASK', 'SCRUM-V2-MIGRATION-PROJECT', 'Existing pre-V2 task', 'DOING', 'SCRUM-V2-BASELINE-OPERATOR');

COMMIT;
