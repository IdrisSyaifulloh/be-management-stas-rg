-- db/seed_weekly_attendance.sql
-- Seed attendance untuk minggu berjalan (Senin minggu ini s.d. hari ini)
-- Dijalankan SETELAH seed.sql agar student IDs sudah ada
-- Aman dijalankan berulang (ON CONFLICT DO UPDATE)

BEGIN;

-- ======================================================
-- ATTENDANCE MINGGU INI — MAHASISWA UTAMA (SEED-STD-*)
-- ======================================================
-- Senin 2026-05-12
INSERT INTO attendance_records (
  id, student_id, attendance_date, status,
  check_in_at, check_out_at,
  check_in_lat, check_in_lng, check_out_lat, check_out_lng,
  accuracy_meters, distance_meters, within_radius,
  checkout_source, auto_checkout
)
VALUES
  -- Alya: hadir Senin & Selasa → 2× minggu ini
  ('SEED-WK-001', 'SEED-STD-001', '2026-05-12', 'Hadir',
   '2026-05-12 08:03:00+07', '2026-05-12 16:15:00+07',
   -6.9731, 107.6301, -6.9732, 107.6302, 5.1, 11.4, TRUE, 'USER_GPS', FALSE),

  -- Rizky: hadir Senin saja → 1× minggu ini
  ('SEED-WK-002', 'SEED-STD-002', '2026-05-12', 'Hadir',
   '2026-05-12 08:20:00+07', '2026-05-12 15:55:00+07',
   -6.9730, 107.6299, -6.9730, 107.6300, 6.3, 13.1, TRUE, 'USER_GPS', FALSE),

  -- Nabila: hadir Senin & Selasa → 2× minggu ini
  ('SEED-WK-003', 'SEED-STD-003', '2026-05-12', 'Hadir',
   '2026-05-12 08:01:00+07', '2026-05-12 17:05:00+07',
   -6.9728, 107.6303, -6.9729, 107.6304, 4.2, 9.9, TRUE, 'USER_GPS', FALSE)

ON CONFLICT (student_id, attendance_date) DO UPDATE SET
  status         = EXCLUDED.status,
  check_in_at    = EXCLUDED.check_in_at,
  check_out_at   = EXCLUDED.check_out_at,
  check_in_lat   = EXCLUDED.check_in_lat,
  check_in_lng   = EXCLUDED.check_in_lng,
  check_out_lat  = EXCLUDED.check_out_lat,
  check_out_lng  = EXCLUDED.check_out_lng,
  accuracy_meters = EXCLUDED.accuracy_meters,
  distance_meters = EXCLUDED.distance_meters,
  within_radius  = EXCLUDED.within_radius,
  checkout_source = EXCLUDED.checkout_source,
  auto_checkout  = EXCLUDED.auto_checkout,
  updated_at     = NOW();

-- Selasa 2026-05-13
INSERT INTO attendance_records (
  id, student_id, attendance_date, status,
  check_in_at, check_out_at,
  check_in_lat, check_in_lng, check_out_lat, check_out_lng,
  accuracy_meters, distance_meters, within_radius,
  checkout_source, auto_checkout
)
VALUES
  -- Alya: hadir hari ini juga → total 2×
  ('SEED-WK-004', 'SEED-STD-001', '2026-05-13', 'Hadir',
   '2026-05-13 08:10:00+07', '2026-05-13 16:00:00+07',
   -6.9731, 107.6301, -6.9732, 107.6302, 5.4, 12.0, TRUE, 'USER_GPS', FALSE),

  -- Nabila: hadir hari ini juga → total 2×
  ('SEED-WK-005', 'SEED-STD-003', '2026-05-13', 'Hadir',
   '2026-05-13 08:05:00+07', '2026-05-13 17:10:00+07',
   -6.9728, 107.6303, -6.9729, 107.6304, 4.5, 10.1, TRUE, 'USER_GPS', FALSE)

  -- Rizky tidak hadir hari ini → tetap 1×

ON CONFLICT (student_id, attendance_date) DO UPDATE SET
  status         = EXCLUDED.status,
  check_in_at    = EXCLUDED.check_in_at,
  check_out_at   = EXCLUDED.check_out_at,
  check_in_lat   = EXCLUDED.check_in_lat,
  check_in_lng   = EXCLUDED.check_in_lng,
  check_out_lat  = EXCLUDED.check_out_lat,
  check_out_lng  = EXCLUDED.check_out_lng,
  accuracy_meters = EXCLUDED.accuracy_meters,
  distance_meters = EXCLUDED.distance_meters,
  within_radius  = EXCLUDED.within_radius,
  checkout_source = EXCLUDED.checkout_source,
  auto_checkout  = EXCLUDED.auto_checkout,
  updated_at     = NOW();

-- ======================================================
-- ATTENDANCE MINGGU INI — BULK STUDENTS (variasi jumlah)
-- ======================================================
-- 10 mahasiswa pertama bulk diberi kehadiran bervariasi
-- supaya daftar punya tampilan 0×, 1×, 2× yang beragam

-- Senin 2026-05-12: bulk 1,2,4,5,7,9,10 hadir
INSERT INTO attendance_records (
  id, student_id, attendance_date, status,
  check_in_at, check_out_at,
  check_in_lat, check_in_lng, check_out_lat, check_out_lng,
  accuracy_meters, distance_meters, within_radius,
  checkout_source, auto_checkout
)
SELECT
  'SEED-WK-BULK-MON-' || to_char(gs, 'FM000') AS id,
  'SEED-BULK-STD-' || to_char(gs, 'FM000')    AS student_id,
  '2026-05-12'::date                            AS attendance_date,
  'Hadir'                                       AS status,
  ('2026-05-12 08:0' || (gs % 6) || ':00+07')::timestamptz AS check_in_at,
  ('2026-05-12 16:0' || (gs % 6) || ':00+07')::timestamptz AS check_out_at,
  -6.9730 + ((gs % 10)::numeric / 10000)       AS check_in_lat,
  107.6300 + ((gs % 10)::numeric / 10000)      AS check_in_lng,
  -6.9731 + ((gs % 10)::numeric / 10000)       AS check_out_lat,
  107.6301 + ((gs % 10)::numeric / 10000)      AS check_out_lng,
  4 + (gs % 5)                                 AS accuracy_meters,
  10 + (gs % 12)                               AS distance_meters,
  TRUE                                          AS within_radius,
  'USER_GPS'                                    AS checkout_source,
  FALSE                                         AS auto_checkout
FROM generate_series(1, 10) AS gs
WHERE gs IN (1, 2, 4, 5, 7, 9, 10)   -- gs 3,6,8 tidak hadir Senin → 0× atau 1×
ON CONFLICT (student_id, attendance_date) DO UPDATE SET
  status         = EXCLUDED.status,
  check_in_at    = EXCLUDED.check_in_at,
  check_out_at   = EXCLUDED.check_out_at,
  checkout_source = EXCLUDED.checkout_source,
  auto_checkout  = EXCLUDED.auto_checkout,
  updated_at     = NOW();

-- Selasa 2026-05-13: bulk 1,4,7 hadir lagi → total 2×; sisanya tetap 1×
INSERT INTO attendance_records (
  id, student_id, attendance_date, status,
  check_in_at, check_out_at,
  check_in_lat, check_in_lng, check_out_lat, check_out_lng,
  accuracy_meters, distance_meters, within_radius,
  checkout_source, auto_checkout
)
SELECT
  'SEED-WK-BULK-TUE-' || to_char(gs, 'FM000') AS id,
  'SEED-BULK-STD-' || to_char(gs, 'FM000')    AS student_id,
  '2026-05-13'::date                            AS attendance_date,
  'Hadir'                                       AS status,
  ('2026-05-13 08:0' || (gs % 6) || ':00+07')::timestamptz AS check_in_at,
  ('2026-05-13 16:0' || (gs % 6) || ':00+07')::timestamptz AS check_out_at,
  -6.9730 + ((gs % 10)::numeric / 10000)       AS check_in_lat,
  107.6300 + ((gs % 10)::numeric / 10000)      AS check_in_lng,
  -6.9731 + ((gs % 10)::numeric / 10000)       AS check_out_lat,
  107.6301 + ((gs % 10)::numeric / 10000)      AS check_out_lng,
  4 + (gs % 5)                                 AS accuracy_meters,
  10 + (gs % 12)                               AS distance_meters,
  TRUE                                          AS within_radius,
  'USER_GPS'                                    AS checkout_source,
  FALSE                                         AS auto_checkout
FROM generate_series(1, 10) AS gs
WHERE gs IN (1, 4, 7)
ON CONFLICT (student_id, attendance_date) DO UPDATE SET
  status         = EXCLUDED.status,
  check_in_at    = EXCLUDED.check_in_at,
  check_out_at   = EXCLUDED.check_out_at,
  checkout_source = EXCLUDED.checkout_source,
  auto_checkout  = EXCLUDED.auto_checkout,
  updated_at     = NOW();

COMMIT;
