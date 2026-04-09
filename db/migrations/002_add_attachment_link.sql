-- Migration: Add attachment_link to research_projects
-- For progress board lampiran feature

ALTER TABLE research_projects
ADD COLUMN IF NOT EXISTS attachment_link TEXT;

COMMENT ON COLUMN research_projects.attachment_link IS 'URL/link to attachment file (e.g., Google Drive, PDF, etc.)';
