BEGIN;

CREATE TABLE IF NOT EXISTS research_github_delivery_repositories (
  delivery_id TEXT NOT NULL REFERENCES research_github_webhook_deliveries(delivery_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES research_repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (delivery_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_research_github_delivery_repos_repo
  ON research_github_delivery_repositories(repository_id);

-- Backfill from existing deliveries that have a repository_id
INSERT INTO research_github_delivery_repositories (delivery_id, repository_id, created_at)
SELECT delivery_id, repository_id, received_at
FROM research_github_webhook_deliveries
WHERE repository_id IS NOT NULL
ON CONFLICT (delivery_id, repository_id) DO NOTHING;

-- Backfill from existing activities
INSERT INTO research_github_delivery_repositories (delivery_id, repository_id, created_at)
SELECT DISTINCT delivery_id, repository_id, created_at
FROM research_github_activities
ON CONFLICT (delivery_id, repository_id) DO NOTHING;

COMMIT;
