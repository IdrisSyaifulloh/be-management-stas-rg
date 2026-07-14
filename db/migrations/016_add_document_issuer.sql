BEGIN;

ALTER TABLE dc_official_documents
  ADD COLUMN IF NOT EXISTS issued_by_user_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'dc_official_documents_issued_by_when_published_check'
      AND conrelid = 'dc_official_documents'::regclass
  ) THEN
    ALTER TABLE dc_official_documents
      ADD CONSTRAINT
        dc_official_documents_issued_by_when_published_check
      CHECK (
        status <> 'terbit'
        OR issued_by_user_id IS NOT NULL
      );
  END IF;
END
$$;

COMMIT;
