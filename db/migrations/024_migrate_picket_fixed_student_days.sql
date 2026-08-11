BEGIN;

CREATE TABLE IF NOT EXISTS picket_student_days (
  student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  day_id SMALLINT NOT NULL REFERENCES picket_days(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE picket_student_days
  ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE INDEX IF NOT EXISTS idx_picket_student_days_day
  ON picket_student_days(day_id, student_id);

-- Hari yang sudah dikonfigurasi pada weekly_schedule menjadi pilihan utama.
-- Jika konfigurasi lama kosong, gunakan seluruh picket_days yang aktif.
CREATE TEMP TABLE migration_picket_allowed_days
ON COMMIT DROP
AS
WITH configured_days AS (
  SELECT DISTINCT
         COALESCE(
           item->>'dayOfWeek',
           item->>'day_of_week',
           item->>'dayId',
           item->>'day_id'
         )::smallint AS day_id
  FROM picket_settings ps
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(ps.weekly_schedule) = 'array' THEN ps.weekly_schedule
      ELSE '[]'::jsonb
    END
  ) AS entry(item)
  WHERE ps.id = 'default'
    AND COALESCE(item->>'dayOfWeek', item->>'day_of_week', item->>'dayId', item->>'day_id') ~ '^[0-6]$'
    AND LOWER(COALESCE(item->>'enabled', item->>'active', 'true')) NOT IN ('false', '0', 'no', 'off')
), valid_configured_days AS (
  SELECT pd.id AS day_id, pd.name
  FROM configured_days configured
  JOIN picket_days pd ON pd.id = configured.day_id
  WHERE pd.active = TRUE
)
SELECT day_id, name
FROM valid_configured_days
UNION ALL
SELECT pd.id, pd.name
FROM picket_days pd
WHERE pd.active = TRUE
  AND NOT EXISTS (SELECT 1 FROM valid_configured_days);

CREATE UNIQUE INDEX migration_picket_allowed_days_pk
  ON migration_picket_allowed_days(day_id);

-- Prioritas 1: pertahankan anggota yang sudah ditetapkan pada pola mingguan lama.
WITH legacy_members AS (
  SELECT member.student_id,
         MIN(
           COALESCE(
             item->>'dayOfWeek',
             item->>'day_of_week',
             item->>'dayId',
             item->>'day_id'
           )::smallint
         ) AS day_id
  FROM picket_settings ps
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(ps.weekly_schedule) = 'array' THEN ps.weekly_schedule
      ELSE '[]'::jsonb
    END
  ) AS entry(item)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(COALESCE(item->'studentIds', item->'student_ids')) = 'array'
        THEN COALESCE(item->'studentIds', item->'student_ids')
      ELSE '[]'::jsonb
    END
  ) AS member(student_id)
  JOIN migration_picket_allowed_days allowed
    ON allowed.day_id = CASE
      WHEN COALESCE(item->>'dayOfWeek', item->>'day_of_week', item->>'dayId', item->>'day_id') ~ '^[0-6]$'
        THEN COALESCE(item->>'dayOfWeek', item->>'day_of_week', item->>'dayId', item->>'day_id')::smallint
      ELSE NULL
    END
  WHERE ps.id = 'default'
    AND COALESCE(item->>'dayOfWeek', item->>'day_of_week', item->>'dayId', item->>'day_id') ~ '^[0-6]$'
    AND LOWER(COALESCE(item->>'enabled', item->>'active', 'true')) NOT IN ('false', '0', 'no', 'off')
  GROUP BY member.student_id
)
INSERT INTO picket_student_days (student_id, day_id, effective_from)
SELECT s.id, legacy.day_id, CURRENT_DATE
FROM legacy_members legacy
JOIN students s ON s.id = legacy.student_id
JOIN users u ON u.id = s.user_id
WHERE s.status = 'Aktif' AND u.is_active = TRUE
ON CONFLICT (student_id) DO NOTHING;

-- Prioritas 2: jika tidak ada pola lama, gunakan hari yang paling sering muncul
-- pada histori jadwal. Jika frekuensinya sama, pilih histori yang paling baru.
WITH historical_frequency AS (
  SELECT psch.student_id,
         EXTRACT(DOW FROM psch.schedule_date)::smallint AS day_id,
         COUNT(*) AS occurrence_count,
         MAX(psch.schedule_date) AS latest_date
  FROM picket_schedules psch
  JOIN migration_picket_allowed_days allowed
    ON allowed.day_id = EXTRACT(DOW FROM psch.schedule_date)::smallint
  GROUP BY psch.student_id, EXTRACT(DOW FROM psch.schedule_date)::smallint
), ranked_history AS (
  SELECT frequency.*,
         ROW_NUMBER() OVER (
           PARTITION BY frequency.student_id
           ORDER BY frequency.occurrence_count DESC,
                    frequency.latest_date DESC,
                    frequency.day_id ASC
         ) AS rank_number
  FROM historical_frequency frequency
)
INSERT INTO picket_student_days (student_id, day_id, effective_from)
SELECT s.id, history.day_id, CURRENT_DATE
FROM ranked_history history
JOIN students s ON s.id = history.student_id
JOIN users u ON u.id = s.user_id
LEFT JOIN picket_student_days existing ON existing.student_id = s.id
WHERE history.rank_number = 1
  AND existing.student_id IS NULL
  AND s.status = 'Aktif'
  AND u.is_active = TRUE
ON CONFLICT (student_id) DO NOTHING;

-- Prioritas 3: mahasiswa aktif tanpa pola maupun histori dibagi secara
-- deterministik dan seimbang. Tidak ada data lama yang diacak ulang.
WITH missing_students AS (
  SELECT s.id,
         ROW_NUMBER() OVER (ORDER BY s.created_at ASC, s.id ASC) AS row_number
  FROM students s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN picket_student_days existing ON existing.student_id = s.id
  WHERE existing.student_id IS NULL
    AND s.status = 'Aktif'
    AND u.is_active = TRUE
), day_loads AS (
  SELECT allowed.day_id,
         COUNT(existing.student_id)::int AS current_load
  FROM migration_picket_allowed_days allowed
  LEFT JOIN picket_student_days existing ON existing.day_id = allowed.day_id
  GROUP BY allowed.day_id
), candidate_slots AS (
  SELECT loads.day_id,
         ROW_NUMBER() OVER (
           ORDER BY loads.current_load + slot_number ASC,
                    loads.day_id ASC,
                    slot_number ASC
         ) AS row_number
  FROM day_loads loads
  CROSS JOIN generate_series(
    1,
    GREATEST((SELECT COUNT(*)::int FROM missing_students), 1)
  ) AS slot_number
), balanced_assignments AS (
  SELECT missing.id AS student_id, slots.day_id
  FROM missing_students missing
  JOIN candidate_slots slots ON slots.row_number = missing.row_number
)
INSERT INTO picket_student_days (student_id, day_id, effective_from)
SELECT student_id, day_id, CURRENT_DATE
FROM balanced_assignments
ON CONFLICT (student_id) DO NOTHING;

-- Sinkronkan JSON lama supaya frontend lama tetap membaca pola yang sama.
WITH day_members AS (
  SELECT allowed.day_id,
         allowed.name,
         COUNT(s.id)::int AS total,
         COALESCE(
           jsonb_agg(s.id ORDER BY u.name ASC)
             FILTER (WHERE s.id IS NOT NULL),
           '[]'::jsonb
         ) AS student_ids
  FROM migration_picket_allowed_days allowed
  LEFT JOIN picket_student_days psd ON psd.day_id = allowed.day_id
  LEFT JOIN students s ON s.id = psd.student_id AND s.status = 'Aktif'
  LEFT JOIN users u ON u.id = s.user_id AND u.is_active = TRUE
  GROUP BY allowed.day_id, allowed.name
), migrated_schedule AS (
  SELECT jsonb_agg(
           jsonb_build_object(
             'dayOfWeek', members.day_id,
             'label', members.name,
             'enabled', TRUE,
             'peoplePerDay', GREATEST(settings.people_per_day, members.total, 1),
             'studentIds', members.student_ids
           )
           ORDER BY members.day_id ASC
         ) AS weekly_schedule
  FROM day_members members
  CROSS JOIN picket_settings settings
  WHERE settings.id = 'default'
)
UPDATE picket_settings settings
SET weekly_schedule = migrated.weekly_schedule,
    updated_at = NOW()
FROM migrated_schedule migrated
WHERE settings.id = 'default';

-- Hentikan migration jika masih ada mahasiswa aktif tanpa hari tetap.
DO $$
DECLARE
  missing_count INTEGER;
BEGIN
  SELECT COUNT(*)::int
  INTO missing_count
  FROM students s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN picket_student_days psd ON psd.student_id = s.id
  WHERE s.status = 'Aktif'
    AND u.is_active = TRUE
    AND psd.student_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Migrasi hari piket gagal: % mahasiswa aktif belum memiliki hari tetap.', missing_count;
  END IF;
END
$$;

COMMIT;
