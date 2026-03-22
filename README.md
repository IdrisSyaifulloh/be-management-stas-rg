# Backend STAS-RG (Express + PostgreSQL)

Backend ini dibuat sebagai fondasi API untuk frontend STAS-RG, dengan fokus maintainability jangka panjang.

## 1) Stack
- Node.js + Express 4
- PostgreSQL (`pg`)
- Konfigurasi environment via `dotenv`

## 2) Struktur utama
- `app.js` → komposisi middleware + mount route
- `config/` → pembacaan env dan validasi config
- `db/` → koneksi pool PostgreSQL + SQL schema/seed
- `routes/api/` → endpoint domain (auth, students, research, dll)
- `utils/` → helper reusable
- `scripts/` → utility command untuk operasional

## 3) Endpoint
Base path aktif:
- `/api` (existing)
- `/api/v1` (versioned alias untuk kompatibilitas jangka panjang)

Base URL lokal default:
- `http://localhost:3000/api/v1` (direkomendasikan untuk client baru)
- `http://localhost:3000/api` (alias kompatibilitas client lama)

Role guard (soft, non-breaking):
- Beberapa endpoint sensitif mendukung guard role via:
  - header: `x-user-role`
  - header: `x-user-id`
  - atau query/body: `role`
- Jika role tidak dikirim, request tetap diizinkan (kompatibilitas client lama).
- Jika role dikirim namun tidak sesuai, API mengembalikan `403`.

Domain endpoint saat ini (pakai prefix `/api/v1`):
- `GET http://localhost:3000/api/v1/health`
- `POST http://localhost:3000/api/v1/auth/login`
- `GET/POST/PUT/DELETE http://localhost:3000/api/v1/students`
- `GET/POST/PUT/DELETE http://localhost:3000/api/v1/lecturers`
- `GET/POST/PUT/DELETE http://localhost:3000/api/v1/research`
- `GET/POST/PATCH/DELETE http://localhost:3000/api/v1/research/:id/members`
- `POST/DELETE http://localhost:3000/api/v1/research/:id/board-access`
- `GET/POST/PATCH/DELETE http://localhost:3000/api/v1/research/:id/milestones`
- `GET/POST/PUT/DELETE http://localhost:3000/api/v1/logbooks`
- `GET/POST/PATCH/DELETE http://localhost:3000/api/v1/leave-requests`
- `GET/POST/PATCH/DELETE http://localhost:3000/api/v1/letter-requests`
- `GET/POST/PATCH/DELETE http://localhost:3000/api/v1/certificates`
- `GET http://localhost:3000/api/v1/audit-logs`
- `GET http://localhost:3000/api/v1/dashboard/summary`
- `GET/POST/PATCH http://localhost:3000/api/v1/notifications`
- `GET/PUT http://localhost:3000/api/v1/notifications/preferences`

Catatan file upload:
- Endpoint surat/sertifikat mendukung upload file base64 dan akan disimpan ke folder publik backend.
- URL file hasil upload dapat diakses dari:
  - `http://localhost:3000/uploads/letters/<nama-file>`
  - `http://localhost:3000/uploads/certificates/<nama-file>`

## 4) Setup lokal
1. Copy `.env.example` menjadi `.env` lalu sesuaikan koneksi DB.
2. Jalankan:
   - `npm install`
   - `npm run check:config`
   - `npm run db:migrate`
  - `npm run db:seed` (opsional, saat ini tidak mengisi data dummy)
  - `npm run db:clear` (opsional, hapus semua data untuk mulai dari kosong)
   - `npm run dev`

### Setup database via Docker
Jika ingin cepat menjalankan PostgreSQL lokal, gunakan compose di folder backend:

1. Jalankan container DB:
  - `docker compose up -d`
2. Pastikan `.env` backend memakai nilai default berikut (sesuai compose):
  - `DB_HOST=localhost`
  - `DB_PORT=55432`
  - `DB_NAME=stasrg`
  - `DB_USER=postgres`
  - `DB_PASSWORD=postgres`
3. Inisialisasi schema + seed:
  - `npm run db:migrate`
  - `npm run db:seed`
4. Jalankan backend:
  - `npm run dev`

Perintah bantu:
- Stop DB: `docker compose down`
- Stop + hapus data volume: `docker compose down -v`

## 4.1) TAH SETUP ENV PRODUCTION
1. Copy template:
   - Linux/macOS: `cp .env.production.example .env.production`
   - Windows PowerShell: `Copy-Item .env.production.example .env.production`
2. Isi nilai production:
   - `CORS_ORIGIN` => domain frontend production (contoh: `https://app.stasrg.ac.id`)
   - `DATABASE_URL` => koneksi PostgreSQL production
3. Jalankan backend dengan mode production:
   - `NODE_ENV=production npm start`

Catatan:
- Saat `NODE_ENV=production`, backend akan membaca `.env` lalu override dengan `.env.production`.
- Simpan rahasia production di environment server (secret manager) dan jangan commit `.env.production` berisi kredensial nyata.

## 5) JENG PENERUS IEU
- Jangan tulis query SQL langsung berulang di banyak route; gunakan helper di `utils/`.
- Tambah endpoint baru dengan pola:
  1. buat file route domain di `routes/api/`
  2. daftarkan di `routes/api/index.js`
  3. jika butuh filter umum, pakai/extend helper `utils/queryFilters.js`
- Untuk perubahan struktur data, update berurutan:
  1. `db/schema.sql`
  2. `db/seed.sql` (opsional untuk data awal)
  3. route yang terdampak
  4. dokumentasi endpoint di README ini

## 6) Roadmap jangka panjang 
- Pindah semua konsumsi frontend ke `/api/v1` bertahap.
- Rapikan role guard (soft -> strict) secara bertahap setelah semua client konsisten kirim `x-user-role` dan `x-user-id`.
- Tambahkan validasi request schema (contoh: Zod/Joi).
- Tambahkan test integrasi endpoint kritikal (`health`, `auth`, `dashboard`).
- Mulai pisahkan lapisan `service/repository` jika query makin kompleks.
- Migrasikan endpoint sintetis (`draft-reports`, `exports`) ke data persisten penuh.
"# be-management-stas-rg" 
