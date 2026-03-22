# Dokumentasi API Backend STAS-RG

Dokumen ini merangkum endpoint yang tersedia di backend (`be/routes/api`).

## Base URL

- `http://localhost:3000/api/v1`
- Alias juga tersedia di: `http://localhost:3000/api`

## Format Umum

- `Content-Type: application/json`
- Header konteks user (tanpa token/JWT):
  - `x-user-role`: `mahasiswa` | `dosen` | `operator`
  - `x-user-id`: id user login (contoh: `U001`)
- Role guard (soft):
  - Endpoint tertentu memeriksa role dari `x-user-role` (header), `role` (query), atau `role` (body).
  - Jika role tidak dikirim, request tetap diizinkan (kompatibilitas).
  - Jika role dikirim tapi tidak sesuai, response `403`.
- Error umum:

```json
{
  "message": "Penjelasan error"
}
```

## Daftar Endpoint

## 1) Health

### GET `/health`
- Deskripsi: cek kesehatan service + koneksi DB.
- Response:

```json
{
  "ok": true,
  "service": "be-managementstas",
  "time": "2026-03-22T12:34:56.000Z"
}
```

## 2) Auth

### POST `/auth/login`
- Body wajib:
  - `identifier` (id/email/nim/nip)
  - `password`
- Response sukses:

```json
{
  "user": {
    "id": "U001",
    "name": "Nama User",
    "initials": "NU",
    "role": "mahasiswa",
    "prodi": "Teknik Informatika"
  }
}
```

## 3) Students

### GET `/students`
- Deskripsi: ambil semua mahasiswa.

### GET `/students/:id`
- Deskripsi: detail mahasiswa berdasarkan `id`.

### POST `/students`
- Body wajib:
  - `id`, `nim`, `name`, `initials`, `status`, `tipe`, `password`
- Body opsional:
  - `prodi`, `angkatan`, `email`, `phone`, `pembimbing`

### PUT `/students/:id`
- Deskripsi: update data mahasiswa.
- Field yang didukung: `nim`, `name`, `initials`, `prodi`, `angkatan`, `email`, `phone`, `status`, `tipe`, `pembimbing`, `password`.

### DELETE `/students/:id`
- Deskripsi: hapus mahasiswa (dan data user terkait).

## 4) Lecturers

### GET `/lecturers`
- Deskripsi: ambil semua dosen.

### POST `/lecturers`
- Body wajib:
  - `id`, `nip`, `name`, `initials`, `status`, `password`
- Body opsional:
  - `email`, `departemen`, `jabatan`, `keahlian`
- Catatan:
  - `keahlian` menerima `string[]` atau string comma-separated.
  - Constraint unik dipetakan ke pesan human-readable (email/NIP/ID duplikat -> 409).

### PUT `/lecturers/:id`
- Deskripsi: update data dosen.
- Field didukung: `nip`, `name`, `initials`, `email`, `departemen`, `jabatan`, `keahlian`, `status`, `password`.

### DELETE `/lecturers/:id`
- Deskripsi: hapus dosen (dan data user terkait).

## 5) Research

### GET `/research/assigned?userId=...`
- Deskripsi:
  - `operator` -> semua riset
  - `dosen` -> riset yang ditugaskan (anggota/supervisor)
  - `mahasiswa` -> riset yang diikuti

### GET `/research`
- Deskripsi: list semua riset + info supervisor.

### GET `/research/:id/members`
- Deskripsi: list anggota riset.

### GET `/research/:id/board-access`
- Deskripsi: list user yang punya akses board riset.

### GET `/research/:id/board`
- Deskripsi: ringkasan board kolom `todo/doing/review/done` berbasis entri logbook.

### GET `/research/:id/milestones`
- Deskripsi: list milestone riset.

### POST `/research`
- Body wajib:
  - `id`, `title`, `status`
- Body opsional:
  - `shortTitle`, `supervisorLecturerId`, `periodText`, `mitra`, `progress`, `category`, `description`, `funding`, `repositori`

### PUT `/research/:id`
- Deskripsi: update data riset.

### DELETE `/research/:id`
- Deskripsi: hapus riset.

### POST `/research/:id/members`
- Body wajib:
  - `userId`, `memberType` (`Mahasiswa`/`Dosen`)
- Body opsional:
  - `peran`, `status`, `bergabung`

### PATCH `/research/:id/members/:userId`
- Deskripsi: update anggota riset.

### DELETE `/research/:id/members/:userId`
- Deskripsi: hapus anggota riset.

### POST `/research/:id/board-access`
- Body wajib:
  - `userId`

### DELETE `/research/:id/board-access/:userId`
- Deskripsi: cabut akses board user.

### POST `/research/:id/milestones`
- Body wajib:
  - `label`
- Body opsional:
  - `done`, `targetDate`, `sortOrder`

### PATCH `/research/:id/milestones/:milestoneId`
- Deskripsi: update milestone.

### DELETE `/research/:id/milestones/:milestoneId`
- Deskripsi: hapus milestone.

## 6) Logbooks

### GET `/logbooks?studentId=...&projectId=...`
- Query opsional:
  - `studentId`
  - `projectId`
- Deskripsi: list logbook + comments + data verifikasi terbaru.

### POST `/logbooks`
- Body wajib:
  - `id`, `studentId`, `date`, `title`, `description`
- Body opsional:
  - `projectId`, `output`, `kendala`, `hasAttachment`

### PATCH `/logbooks/:id/verify`
- Body wajib:
  - `verificationStatus` (`Terverifikasi`/`Perlu Revisi`)
  - `verifiedBy`
- Body opsional:
  - `verificationNote`, `verifiedByName`
- Deskripsi: simpan verifikasi via audit log.

### PUT `/logbooks/:id`
- Deskripsi: update entri logbook.

### DELETE `/logbooks/:id`
- Deskripsi: hapus entri logbook.

### POST `/logbooks/:id/comments`
- Body wajib:
  - `id`, `logbookId`, `authorId`, `text`
- Body opsional:
  - `authorName`

## 7) Leave Requests

### GET `/leave-requests?status=...`
- Query opsional:
  - `status` (`Menunggu`/`Disetujui`/`Ditolak`)

### POST `/leave-requests`
- Body wajib:
  - `id`, `studentId`, `periodeStart`, `periodeEnd`, `durasi`, `alasan`, `tanggalPengajuan`
- Body opsional:
  - `projectId`, `catatan`

### PATCH `/leave-requests/:id/status`
- Body wajib:
  - `status` (`Menunggu`/`Disetujui`/`Ditolak`)
- Body opsional:
  - `reviewedBy`, `reviewNote`

### DELETE `/leave-requests/:id`
- Deskripsi: hapus pengajuan cuti.

## 8) Letter Requests

### GET `/letter-requests?status=...`
- Query opsional:
  - `status` (`Menunggu`/`Diproses`/`Siap Unduh`)

### POST `/letter-requests`
- Body wajib:
  - `id`, `studentId`, `jenis`, `tanggal`, `tujuan`

### PATCH `/letter-requests/:id/status`
- Body wajib:
  - `status` (`Menunggu`/`Diproses`/`Siap Unduh`)
- Body opsional:
  - `estimasi`, `nomorSurat`, `fileUrl`, `fileDataUrl`, `fileName`
- Catatan:
  - `fileDataUrl` menerima format data URL base64.
  - File valid: PDF/DOC/DOCX/PNG/JPG, maksimal 4 MB.
  - File disimpan ke `/uploads/letters/...`.

### DELETE `/letter-requests/:id`
- Deskripsi: hapus pengajuan surat.

## 9) Certificates

### GET `/certificates?status=...&studentId=...&projectId=...`
- Query opsional:
  - `status`, `studentId`, `projectId`

### POST `/certificates`
- Body wajib:
  - `id`, `studentId`, `projectId`, `requestedBy`
- Body opsional:
  - `kontribusiSelesaiDate`, `requestNote`
- Catatan:
  - Upsert by `(student_id, project_id)`.

### PATCH `/certificates/:id/status`
- Body wajib:
  - `status` (`Belum Diminta`/`Diproses`/`Terbit`)
- Body opsional:
  - `issueDate`, `certificateNumber`, `fileUrl`, `fileDataUrl`, `fileName`
- Catatan:
  - `fileDataUrl` menerima format data URL base64.
  - File valid: PDF/PNG/JPG, maksimal 4 MB.
  - File disimpan ke `/uploads/certificates/...`.

### DELETE `/certificates/:id`
- Deskripsi: hapus data sertifikat.

## 10) Audit Logs

### GET `/audit-logs?action=...&role=...&limit=...`
- Query opsional:
  - `action`, `role`, `limit`
- Catatan:
  - `limit` default 50, max 200.

## 11) Dashboard

### GET `/dashboard/summary`
- Deskripsi: ringkasan dashboard operator.

### GET `/dashboard/student?userId=...`
- Query wajib:
  - `userId`
- Deskripsi: payload dashboard mahasiswa (stats, proyek, logbook, cuti, surat, sertifikat, kehadiran hari ini).

### GET `/dashboard/lecturer?userId=...`
- Query wajib:
  - `userId`
- Deskripsi: payload dashboard dosen (stats, pending logs/leaves, board summary, deadline milestone).

## 12) Attendance

### POST `/attendance/check-in`
- Body wajib:
  - `studentId`, `latitude`, `longitude`
- Body opsional:
  - `accuracy`
- Deskripsi: validasi radius GPS, simpan check-in hari ini.

### POST `/attendance/check-out`
- Body wajib:
  - `studentId`, `latitude`, `longitude`
- Deskripsi: check-out ke record attendance hari ini.

### GET `/attendance/monitor/today`
- Deskripsi: monitor operator untuk hari ini.
- Response utama:
  - `presentIds`, `leaveIds`, `absentIds`

### GET `/attendance?studentId=...&month=YYYY-MM`
- Query wajib:
  - `studentId`
- Query opsional:
  - `month` (default bulan berjalan)
- Deskripsi: rekap chart + today status + history absensi.

## 12.1) Notifications

### GET `/notifications`
- Query opsional:
  - `userId`, `unreadOnly`, `limit`

### POST `/notifications`
- Body wajib:
  - `recipientUserId`, `title`, `body`
- Body opsional:
  - `id`, `type`

### PATCH `/notifications/:id/read`
- Body opsional:
  - `userId` (umumnya tidak perlu selain mode operator)

### PATCH `/notifications/read-all`
- Body opsional:
  - `userId` (umumnya tidak perlu selain mode operator)

### GET `/notifications/preferences`
- Deskripsi: ambil preferensi notifikasi user login.

### PUT `/notifications/preferences`
- Body wajib:
  - `items` array objek `{ id: string, enabled: boolean }`

## 13) Draft Reports

### GET `/draft-reports?studentId=...&type=...`
- Query wajib:
  - `studentId`
- Query opsional:
  - `type` (`Semua` / `Laporan TA` / `Jurnal` / `Laporan Kemajuan`)
- Deskripsi:
  - Saat ini data draft diturunkan dari logbook + audit log review.
  - Beberapa field (`type`, `fileSize`, `version`) masih dibentuk secara sintetis.

### PATCH `/draft-reports/:id/review`
- Body wajib:
  - `status` (`Menunggu Review`/`Dalam Review`/`Disetujui`)
  - `reviewedBy`
  - `studentId`
- Body opsional:
  - `note`, `reviewedByName`

## 14) Profile

### GET `/profile/:userId`
- Deskripsi: ambil profil user (join data students jika ada).

### PATCH `/profile/:userId`
- Deskripsi: update profil.
- Field didukung: `name`, `phone`, `email`, `prodi`.

### PUT `/profile/:userId/password`
- Body wajib:
  - `newPassword`
- Catatan:
  - Password disimpan sebagai `md5(newPassword)` agar konsisten dengan endpoint login.

## 15) System Settings

### GET `/system-settings`
- Deskripsi: ambil pengaturan sistem.

### PATCH `/system-settings`
- Deskripsi: update pengaturan sistem (merge patch object).

## 16) Exports

### GET `/exports/templates`
- Deskripsi: list template quick export.

### GET `/exports/queue`
- Deskripsi: list riwayat/giliran job export.

### POST `/exports/generate`
- Body opsional:
  - `format` (default `XLSX`)
  - `selectedData` (array id data yang diekspor)
- Response:
  - object job export (`id`, `status`, `fileUrl`, dll).
- Catatan:
  - Queue export masih in-memory (`const jobs = []`) dan belum persisten antar restart service.

## Contoh Endpoint Cepat

### Contoh Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "U001",
    "password": "secret123"
  }'
```

### Contoh Buat Logbook

```bash
curl -X POST http://localhost:3000/api/v1/logbooks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "LB-001",
    "studentId": "M001",
    "projectId": "R001",
    "date": "2026-03-22",
    "title": "Eksperimen model",
    "description": "Training awal model",
    "output": "akurasi 0.82"
  }'
```

### Contoh Update Status Surat

```bash
curl -X PATCH http://localhost:3000/api/v1/letter-requests/S123/status \
  -H "Content-Type: application/json" \
  -d '{
    "status": "Diproses",
    "estimasi": "2026-03-25"
  }'
```
