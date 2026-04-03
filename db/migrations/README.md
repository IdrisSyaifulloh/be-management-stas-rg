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
