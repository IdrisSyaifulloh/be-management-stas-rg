CREATE TABLE IF NOT EXISTS picket_holidays (
  id TEXT PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_picket_holidays_date
ON picket_holidays(holiday_date);
