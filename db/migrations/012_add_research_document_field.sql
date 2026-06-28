ALTER TABLE research_projects
ADD COLUMN IF NOT EXISTS research_type TEXT CHECK (research_type IN ('Internal', 'Eksternal')),
ADD COLUMN IF NOT EXISTS agreement_type TEXT CHECK (agreement_type IN ('PKS', 'MoU', 'MoA')),
ADD COLUMN IF NOT EXISTS agreement_start_date DATE,
ADD COLUMN IF NOT EXISTS agreement_end_date DATE,
ADD COLUMN IF NOT EXISTS agreement_file_url TEXT,
ADD COLUMN IF NOT EXISTS proposal_file_url TEXT,
ADD COLUMN IF NOT EXISTS rab_file_url TEXT;
