# Database Migrations

Folder ini berisi migration files untuk update schema database secara incremental.

## Cara Menggunakan

### 1. Jalankan Semua Migration (Untuk Installasi Baru)

```bash
npm run db:migrate
npm run db:migrate-withdrawal
npm run db:seed
```

### 2. Jalankan Migration Tunggal

```bash
# Migration withdrawal tracking
npm run db:migrate-withdrawal

# Atau manual
node ./db/runSqlFile.js ./db/migrations/001_add_withdrawal_tracking.sql
```

## Migration Files

| File | Deskripsi | Tanggal |
|------|-----------|---------|
| `001_add_withdrawal_tracking.sql` | Menambahkan kolom `withdrawal_at` dan `scheduled_deletion_at` untuk tracking mahasiswa yang mengundurkan diri | 2026-04-02 |
| `024_migrate_picket_fixed_student_days.sql` | Memigrasikan pola dan histori piket lama menjadi hari tetap per mahasiswa tanpa mengubah histori bertanggal | 2026-08-10 |
| `025_add_picket_leave_replacement_schedule.sql` | Menambahkan relasi jadwal pengganti sementara untuk izin piket yang disetujui | 2026-08-10 |
| `026_link_student_leave_to_picket.sql` | Menghubungkan approval izin mahasiswa dengan izin/penyelesaian piket otomatis | 2026-08-12 |

## Kolom yang Ditambahkan

### Tabel `students`

| Kolom | Tipe | Deskripsi |
|-------|------|-----------|
| `withdrawal_at` | TIMESTAMPTZ | Timestamp ketika mahasiswa diubah statusnya menjadi "Mengundurkan Diri" |
| `scheduled_deletion_at` | TIMESTAMPTZ | Timestamp ketika akun akan dihapus otomatis (30 hari setelah withdrawal) |

## Update Database yang Sudah Ada

Jika database sudah ada sebelumnya (tanpa kolom withdrawal), jalankan:

```bash
npm run db:migrate-withdrawal
```

Ini akan menambahkan kolom yang diperlukan tanpa menghapus data yang sudah ada.

## Catatan

- Migration files dijalankan secara manual, tidak otomatis
- Pastikan backup database sebelum menjalankan migration di production
- Migration menggunakan `IF NOT EXISTS` sehingga aman dijalankan berkali-kali

## Migrasi Hari Piket Tetap

Jalankan setelah backup database dan sebelum aplikasi versi baru direstart:

```bash
npm run db:migrate-picket-system
```

Urutan sumber hari tetap adalah pola `weekly_schedule` lama, hari terbanyak pada
histori `picket_schedules`, lalu pembagian seimbang untuk mahasiswa aktif yang
belum memiliki pola maupun histori. Migration tidak mengubah jadwal bertanggal,
submission, atau izin piket yang sudah ada.

Migration kedua menambahkan referensi jadwal pengganti untuk izin piket. Setelah
aplikasi versi baru aktif, izin berstatus `Disetujui` yang tanggal asalnya hari
ini atau setelah hari ini dan belum memiliki jadwal pengganti akan diproses
otomatis oleh scheduler. Izin lama yang tanggalnya sudah lewat tetap disimpan
sebagai histori dan tidak dijadwalkan ulang secara retroaktif.
