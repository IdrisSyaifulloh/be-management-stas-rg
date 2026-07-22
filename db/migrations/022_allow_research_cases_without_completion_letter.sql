ALTER TABLE dc_final_activity_cases
  DROP CONSTRAINT IF EXISTS dc_final_activity_cases_completion_document_status_check;

ALTER TABLE dc_final_activity_cases
  ADD CONSTRAINT dc_final_activity_cases_completion_document_status_check
  CHECK (
    (
      completion_document_id IS NULL
      AND (
        case_status = 'pending'
        OR (activity_type = 'Riset' AND case_status IN ('issued', 'revoked'))
      )
    )
    OR (
      completion_document_id IS NOT NULL
      AND case_status IN ('draft_created', 'issued', 'revoked')
    )
  );
