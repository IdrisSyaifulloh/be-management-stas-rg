-- db/seed.sql
-- Password default untuk semua user: '12345678' (sudah di-hash dengan bcrypt)
-- Untuk generate hash baru: node scripts/generatePasswordHash.js <password>
-- 
-- Menggunakan INSERT ... ON CONFLICT untuk menghindari error duplicate key
-- Jika user sudah ada, password akan di-update dengan hash baru

-- ======================================================
-- OPERATOR
-- ======================================================
INSERT INTO users (id, name, initials, role, email, password_hash, prodi)
VALUES
  (
    'usr_operator_002',
    'Operator Lab',
    'OP',
    'operator',
    'operator@gmail.com',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Umum'
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  prodi = EXCLUDED.prodi,
  updated_at = NOW();

-- ======================================================
-- DOSEN
-- ======================================================
INSERT INTO users (id, name, initials, role, email, password_hash, prodi)
VALUES
  (
    'usr_dosen_001',
    'Dr. Ahmad Fauzi',
    'AF',
    'dosen',
    'ahmad.fauzi@telkomuniversity.ac.id',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Teknik Informatika'
  ),
  (
    'usr_dosen_002',
    'Siti Nurhaliza, M.Kom',
    'SN',
    'dosen',
    'siti.nurhaliza@telkomuniversity.ac.id',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Teknik Informatika'
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  prodi = EXCLUDED.prodi,
  updated_at = NOW();

INSERT INTO lecturers (id, user_id, nip, departemen, jabatan, keahlian, status, bergabung)
VALUES
  (
    'lec_001',
    'usr_dosen_001',
    '198501012010011001',
    'Teknik Informatika',
    'Lektor Kepala',
    '{"Machine Learning", "Data Science", "Artificial Intelligence"}',
    'Aktif',
    '2010-01-01'
  ),
  (
    'lec_002',
    'usr_dosen_002',
    '199002022015022002',
    'Teknik Informatika',
    'Lektor',
    '{"Software Engineering", "Web Development", "Mobile Development"}',
    'Aktif',
    '2015-02-01'
  )
ON CONFLICT (id) DO UPDATE SET
  nip = EXCLUDED.nip,
  departemen = EXCLUDED.departemen,
  jabatan = EXCLUDED.jabatan,
  keahlian = EXCLUDED.keahlian,
  status = EXCLUDED.status,
  bergabung = EXCLUDED.bergabung,
  updated_at = NOW();

-- ======================================================
-- MAHASISWA
-- ======================================================
INSERT INTO users (id, name, initials, role, email, password_hash, prodi)
VALUES
  (
    'usr_mhs_001',
    'Andi Pratama',
    'AP',
    'mahasiswa',
    'andi.pratama@student.telkomuniversity.ac.id',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Teknik Informatika'
  ),
  (
    'usr_mhs_002',
    'Budi Santoso',
    'BS',
    'mahasiswa',
    'budi.santoso@student.telkomuniversity.ac.id',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Teknik Informatika'
  ),
  (
    'usr_mhs_003',
    'Citra Dewi',
    'CD',
    'mahasiswa',
    'citra.dewi@student.telkomuniversity.ac.id',
    '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6',
    'Teknik Informatika'
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  prodi = EXCLUDED.prodi,
  updated_at = NOW();

INSERT INTO students (id, user_id, nim, angkatan, phone, status, tipe, bergabung, pembimbing)
VALUES
  (
    'stu_001',
    'usr_mhs_001',
    '1234567890',
    '2022',
    '081234567890',
    'Aktif',
    'Riset',
    '2022-09-01',
    'Dr. Ahmad Fauzi'
  ),
  (
    'stu_002',
    'usr_mhs_002',
    '1234567891',
    '2022',
    '081234567891',
    'Aktif',
    'Magang',
    '2022-09-01',
    'Siti Nurhaliza, M.Kom'
  ),
  (
    'stu_003',
    'usr_mhs_003',
    '1234567892',
    '2023',
    '081234567892',
    'Aktif',
    'Riset',
    '2023-09-01',
    'Dr. Ahmad Fauzi'
  )
ON CONFLICT (id) DO UPDATE SET
  nim = EXCLUDED.nim,
  angkatan = EXCLUDED.angkatan,
  phone = EXCLUDED.phone,
  status = EXCLUDED.status,
  tipe = EXCLUDED.tipe,
  bergabung = EXCLUDED.bergabung,
  pembimbing = EXCLUDED.pembimbing,
  updated_at = NOW();