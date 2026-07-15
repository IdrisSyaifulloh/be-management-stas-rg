BEGIN;

CREATE TABLE IF NOT EXISTS dc_issue_batches (
  id TEXT PRIMARY KEY,
  type_code TEXT NOT NULL,
  sequence_year INTEGER NOT NULL,
  sequence_month INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL,
  document_number TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  issued_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_issue_batches_type_code_check
    CHECK (type_code ~ '^[0-9]{2}$'),
  CONSTRAINT dc_issue_batches_sequence_month_check
    CHECK (sequence_month BETWEEN 1 AND 12),
  CONSTRAINT dc_issue_batches_sequence_number_check
    CHECK (sequence_number BETWEEN 1 AND 999)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_issue_batches_scope
  ON dc_issue_batches (type_code, sequence_year, sequence_number);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_issue_batches_document_number
  ON dc_issue_batches (document_number);

ALTER TABLE dc_official_documents
  ADD COLUMN IF NOT EXISTS issue_batch_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dc_official_documents_issue_batch_fk'
      AND conrelid = 'dc_official_documents'::regclass
  ) THEN
    ALTER TABLE dc_official_documents
      ADD CONSTRAINT dc_official_documents_issue_batch_fk
      FOREIGN KEY (issue_batch_id)
      REFERENCES dc_issue_batches(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DROP INDEX IF EXISTS uq_dc_official_documents_number;

CREATE INDEX IF NOT EXISTS idx_dc_official_documents_issue_batch
  ON dc_official_documents (issue_batch_id)
  WHERE issue_batch_id IS NOT NULL;

COMMIT;
