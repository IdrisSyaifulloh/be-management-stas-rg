# Scrum V2 Backend Staging/UAT

## Supported database paths

Fresh installations use `db/schema.sql`, whose dependency order creates `research_projects` before `graduation_submission_projects`. After the schema is installed, run the Scrum V2 upgrade command to verify the same canonical current state.

The supported existing-database baseline is an application schema that already contains `users`, `research_projects`, and the pre-V2 `research_board_tasks` columns represented by `test/fixtures/scrum_v2_pre_v2_baseline.sql`. The existing database must already have completed its older application migrations through `028_enforce_unique_picket_tasks_per_date.sql`. Historical applied migrations are not rewritten.

## Fresh install

Use a new database, then run:

```bash
DATABASE_URL=postgresql://... npm run db:migrate
DATABASE_URL=postgresql://... npm run db:migrate:scrum-v2
```

## Existing database upgrade

Take a provider snapshot or backup, verify the supported baseline above, then run:

```bash
DATABASE_URL=postgresql://... npm run db:migrate:scrum-v2
```

The runner is fail-fast and always applies this deterministic order:

1. `029_scrum_v2_core.sql`
2. `030_sprint_review_summary.sql`
3. `031_github_integration_scrum_v2.sql`

These three migrations are intentionally idempotent and are covered by an automated re-run test. The runner logs filenames only and never logs database connection values.

## Staging guard

For staging/UAT, use the guarded command:

```bash
DATABASE_URL=postgresql://... npm run db:migrate:scrum-v2:staging
```

It refuses `NODE_ENV=production`, production-looking targets, and ambiguous targets. The host or database name must clearly contain `staging`, `stage`, `uat`, `test`, `testing`, `disposable`, or `scrum_v2`. Local targets are not accepted unless the database name also has a safe marker.

## Webhook

The only public processing endpoint is:

```text
POST /api/v1/integrations/github/webhook
```

The legacy `/api/integrations/github/webhook` path is not mounted and returns 404. Required staging variable names are `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY`. Do not use a PAT.

## Manual UAT fixture

The fixture uses predictable IDs with the `UAT-SCRUM-V2` prefix and creates an Operator, Dosen, Mahasiswa, project, three divisions, planning/active/review/closed Sprints, backlog and carry-over cases, historical summary data, and a synthetic GitHub repository/task link. It never contacts GitHub.

Provide a temporary password through the environment without placing it in the repository:

```bash
DATABASE_URL=postgresql://... UAT_FIXTURE_PASSWORD='temporary-value' npm run db:fixture:scrum-v2-uat
```

If `UAT_FIXTURE_PASSWORD` is omitted, the script generates a random password and prints it exactly once. The database target guard is always enforced.

Cleanup:

```bash
DATABASE_URL=postgresql://... npm run db:fixture:scrum-v2-uat:cleanup
```

## Validation

Each integration command requires a dedicated disposable database whose name passes the target guard:

```bash
TEST_DATABASE_URL=postgresql://... npm run test:scrum-v2-migrations
TEST_DATABASE_URL=postgresql://... npm run test:scrum-v2-integration
TEST_DATABASE_URL=postgresql://... npm run test:scrum-v2-summary-integration
TEST_DATABASE_URL=postgresql://... npm run test:scrum-v2-github-integration
```

The suites prepare their own schema and fixtures. Do not point them at a shared or production database because setup drops and recreates the `public` schema.

## Rollback policy

Do not attempt an automatic down migration. If an upgrade fails, its current migration transaction rolls back. If a post-upgrade staging check fails, stop the application change, retain logs that contain no secrets, and restore the pre-upgrade database snapshot. Do not deploy until migration, integrity, and regression checks pass.
