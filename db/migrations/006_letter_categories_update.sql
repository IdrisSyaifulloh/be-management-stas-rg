-- Migration: Tambah kolom kode & singkatan ke letter_categories, seed 17 jenis resmi STAS-RG

ALTER TABLE letter_categories ADD COLUMN IF NOT EXISTS kode       TEXT;
ALTER TABLE letter_categories ADD COLUMN IF NOT EXISTS singkatan  TEXT;

INSERT INTO letter_categories (id, name, kode, singkatan) VALUES
  ('lcat-01', 'Surat Keputusan',                 '01', 'SK'),
  ('lcat-02', 'Surat Undangan',                  '02', 'SU'),
  ('lcat-03', 'Surat Permohonan',                '03', 'SPM'),
  ('lcat-04', 'Surat Pemberitahuan',             '04', 'SPb'),
  ('lcat-05', 'Surat Peminjaman',                '05', 'SPP'),
  ('lcat-06', 'Surat Pernyataan',                '06', 'SPn'),
  ('lcat-07', 'Surat Mandat',                    '07', 'SM'),
  ('lcat-08', 'Surat Tugas',                     '08', 'ST'),
  ('lcat-09', 'Surat Keterangan',                '09', 'Sket'),
  ('lcat-10', 'Surat Rekomendasi',               '10', 'SR'),
  ('lcat-11', 'Surat Balasan',                   '11', 'SB'),
  ('lcat-12', 'Surat Perintah Perjalanan Dinas', '12', 'SPPD'),
  ('lcat-13', 'Sertifikat',                      '13', 'SRT'),
  ('lcat-14', 'Perjanjian Kerja',                '14', 'PK'),
  ('lcat-15', 'Surat Pengantar',                 '15', 'SPeng'),
  ('lcat-16', 'Nota',                            '16', NULL),
  ('lcat-17', 'Surat Berita Acara Serah Terima', '17', NULL)
ON CONFLICT (id) DO NOTHING;
