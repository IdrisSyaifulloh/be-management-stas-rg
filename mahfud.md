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

### GET `/auth/me`
- Deskripsi: ambil identitas user saat ini berdasarkan JWT yang sudah diverifikasi.
- Wajib autentikasi (cookie `accessToken` httpOnly atau header `Authorization: Bearer ...`).
- Response sukses (`200`):
```json
{
  "user": {
    "id": "U001",
    "name": "Nama User",
    "initials": "NU",
    "role": "mahasiswa",
    "prodi": "Teknik Informatika",
    "tipe": "Magang"
  }
}
```
- Response gagal:
  - `401`: tidak terautentikasi / sesi tidak valid / akun tidak aktif.
- Catatan: gunakan endpoint ini di frontend untuk memverifikasi sesi saat aplikasi dimuat.
  **JANGAN** mempercayai role yang tersimpan di `localStorage` — selalu verifikasi via `/auth/me`.

> **PENTING (Security):**
> Mulai versi ini, backend **TIDAK lagi mempercayai** header `x-user-role` atau `x-user-id` dari client.
> Role hanya diambil dari JWT yang sudah diverifikasi server. Tidak ada lagi fallback ke header / query / body.

### POST `/auth/logout`
- Deskripsi: revoke sesi & clear cookie.

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

### GET `/students/:id/periods`
- Deskripsi: ambil semua periode keanggotaan mahasiswa (Riset / Magang).
- Response: array periode, diurutkan dari yang paling awal.
- Contoh item:
```json
{
  "id": "per_1234567890123001",
  "student_id": "stu_...",
  "tipe": "Magang",
  "mulai": "2025-01-01",
  "selesai": "2025-06-30",
  "keterangan": "Batch 2025 Genap",
  "created_at": "...",
  "updated_at": "..."
}
```

### POST `/students/:id/periods`
- Deskripsi: tambah periode keanggotaan baru untuk mahasiswa.
- Body wajib:
  - `tipe`: `"Riset"` | `"Magang"`
  - `mulai`: tanggal mulai format `YYYY-MM-DD`
- Body opsional:
  - `selesai`: tanggal selesai format `YYYY-MM-DD` (kosong = masih aktif)
  - `keterangan`: catatan bebas
- Response `201`:
```json
{
  "message": "Periode berhasil ditambahkan.",
  "data": { ... }
}
```

### PATCH `/students/:id/periods/:periodId`
- Deskripsi: update periode (misal: isi tanggal selesai saat periode berakhir).
- Body opsional (minimal 1 field):
  - `tipe`, `mulai`, `selesai`, `keterangan`
  - Kirim `"selesai": null` untuk menghapus tanggal selesai (jadikan aktif lagi).

### DELETE `/students/:id/periods/:periodId`
- Deskripsi: hapus satu periode keanggotaan.

> **Auto-alumni:** Scheduler harian (`autoAlumniScheduler`) secara otomatis mengubah
> `students.status` menjadi `'Alumni'` jika semua periode mahasiswa sudah memiliki
> `selesai` dan tanggal tersebut sudah terlewati.

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
- Deskripsi: payload board riset persisten.
- Response utama:
  - `project`
  - `tasks`
  - `columns.todo|doing|review|done`
  - `counts`
- Task kini memuat field lengkap:
  - `id`, `project_id`, `title`, `description`, `status`, `deadline`, `priority`, `tag`
  - `assignee_ids`, `assignees`, `progress`, `comments_count`
  - `subtasks`, `attachments`, `created_by`, `created_at`, `updated_at`

### PATCH `/research/:id/board/header`
- Deskripsi: update header/detail board/proyek.
- Role:
  - `operator`, `dosen` yang punya akses proyek
- Body opsional:
  - `title`, `shortTitle`, `periodText`, `mitra`, `status`, `progress`
  - `category`, `description`, `funding`, `repositori`, `attachmentLink`

### POST `/research/:id/board/tasks`
- Deskripsi: tambah task board persisten.
- Body wajib:
  - `title`
- Body opsional:
  - `id`, `description`, `status`, `deadline`, `priority`, `tag`
  - `assignee_ids` / `assigneeIds`
  - `progress`, `sortOrder`

### GET `/research/:id/board/tasks/:taskId`
- Deskripsi: detail 1 task beserta assignee, subtasks, attachments, comments.

### PATCH `/research/:id/board/tasks/:taskId`
- Deskripsi: edit task board.
- Body opsional:
  - `title`, `description`, `status`, `deadline`, `priority`, `tag`
  - `assignee_ids` / `assigneeIds`
  - `progress`, `sortOrder`

### PATCH `/research/:id/board/tasks/:taskId/status`
- Deskripsi: pindah status task antar kolom.
- Body wajib:
  - `status` (`TO DO` / `DOING` / `REVIEW` / `DONE`)
- Body opsional:
  - `sortOrder`

### DELETE `/research/:id/board/tasks/:taskId`
- Deskripsi: hapus task board persisten.

### POST `/research/:id/board/tasks/:taskId/subtasks`
- Deskripsi: tambah checklist/subtask.
- Body wajib:
  - `title`
- Body opsional:
  - `id`, `done`, `sortOrder`

### PATCH `/research/:id/board/tasks/:taskId/subtasks/:subtaskId`
- Deskripsi: edit/toggle subtask.
- Body opsional:
  - `title`, `done`, `sortOrder`

### DELETE `/research/:id/board/tasks/:taskId/subtasks/:subtaskId`
- Deskripsi: hapus subtask.

### POST `/research/:id/board/tasks/:taskId/attachments`
- Deskripsi: upload lampiran task persisten.
- Body wajib:
  - `fileDataUrl`, `fileName`
- Body opsional:
  - `id`
- Catatan:
  - `fileDataUrl` menerima format data URL base64.
  - File valid: PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/JPG/PNG/TXT/ZIP, maksimal 15 MB.
  - File disimpan ke `/uploads/board-tasks/...`.

### DELETE `/research/:id/board/tasks/:taskId/attachments/:attachmentId`
- Deskripsi: hapus lampiran task.

### GET `/research/:id/board/tasks/:taskId/comments`
- Deskripsi: list komentar task board.

### POST `/research/:id/board/tasks/:taskId/comments`
- Deskripsi: tambah komentar task board.
- Body wajib:
  - `authorId`, `text`
- Body opsional:
  - `id`, `authorName`

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
- Response tambahan:
  - `file_url`, `file_name`, `file_size`, `has_attachment`

### POST `/logbooks`
- Body wajib:
  - `id`, `studentId`, `date`, `title`, `description`
- Body opsional:
  - `projectId`, `output`, `kendala`, `hasAttachment`, `fileName`, `fileDataUrl`
- Catatan:
  - `fileDataUrl` menerima format data URL base64.
  - File valid: PDF/DOC/DOCX/JPG/PNG/ZIP, maksimal 10 MB.
  - Lampiran disimpan ke `/uploads/logbooks/...`.

### PATCH `/logbooks/:id/verify`
- Body wajib:
  - `verificationStatus` (`Terverifikasi`/`Perlu Revisi`)
  - `verifiedBy`
- Body opsional:
  - `verificationNote`, `verifiedByName`
- Deskripsi: simpan verifikasi via audit log.

### PUT `/logbooks/:id`
- Deskripsi: update entri logbook.
- Body opsional tambahan:
  - `fileName`, `fileDataUrl`, `clearAttachment`

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
  - `studentId`
  - `lecturerId`
  - `requesterType` (`student`/`lecturer`)
  - `requesterId`
  - `projectId`
- Deskripsi:
  - `mahasiswa` melihat surat berdasarkan `student_id` miliknya.
  - `dosen` melihat surat berdasarkan requester dosen miliknya.
  - `operator` dapat memfilter surat mahasiswa maupun dosen.
- Response tambahan:
  - `requesterType`, `requesterId`, `requesterName`
  - `projectId`, `projectName`
  - `catatan`

### POST `/letter-requests`
- Deskripsi:
  - Endpoint generik untuk pengajuan surat mahasiswa maupun dosen.
  - Alias route juga tersedia di: `POST /lecturer-letter-requests`
- Body wajib:
  - `jenis`, `tanggal`, `tujuan`
- Body opsional:
  - `id`
  - `requesterType` (`student`/`lecturer`)
  - `studentId` (untuk requester mahasiswa)
  - `lecturerId` atau `requesterId` (untuk requester dosen)
  - `projectId`
  - `catatan`
- Catatan:
  - Jika `requesterType=student`, backend akan memvalidasi mahasiswa aktif dari `studentId`.
  - Jika `requesterType=lecturer`, backend akan memvalidasi dosen dari `lecturerId`/`requesterId`.
  - Jika `id` tidak dikirim, backend akan generate otomatis sesuai requester.

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

### GET `/dashboard/operator-warnings`
- Deskripsi: daftar warning dashboard operator yang masih aktif untuk periode berjalan.
- Warning yang didukung:
  - `logbook_missing` (unik per mahasiswa + tanggal acuan)
  - `attendance_absent` (unik per mahasiswa + tanggal hari itu)
  - `low_hours` (unik per mahasiswa + periode minggu berjalan)
- Catatan perilaku:
  - `attendance_absent` hanya muncul setelah jam `10:00` WIB.
  - `attendance_absent` tidak lagi memakai flow kirim notifikasi.
  - Warning akan hilang jika sudah pernah dikirim reminder atau sudah ditandai `reviewed` untuk periode yang sama.
- Response utama:
  - `referenceDate`, `referencePeriod`
  - `meta.attendanceAbsent.visibleAfter|active|notificationEnabled`
  - `warnings.logbookMissing|attendanceAbsent|lowHours`
  - `counts`

### POST `/dashboard/operator-warnings/review`
- Deskripsi: tandai warning dashboard sebagai sudah ditinjau agar tidak muncul lagi pada periode yang sama.
- Role:
  - `operator`
- Body wajib:
  - `type`
  - `studentId` atau `recipientUserId`
- Body opsional:
  - `referenceDate`, `referencePeriod`, `reviewNote`
- Catatan:
  - Untuk `attendance_absent`, jika `referenceDate` tidak dikirim backend memakai tanggal hari ini.
  - Jika warning periode yang sama sudah pernah ditandai, response akan return `duplicate=true`.

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
  - `reminderType`, `studentId`, `referenceDate`, `referencePeriod`
  - `forceResend`
- Catatan:
  - Contract lama tetap didukung.
  - Jika notifikasi dikenali sebagai reminder dashboard, backend otomatis mencatat log reminder.
  - Reminder yang sama tidak akan dikirim ulang untuk periode yang sama kecuali `forceResend=true`.

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

### Perilaku aktif notifikasi sistem
- Backend sekarang membaca toggle `system-settings.notif.events` sebagai rule aktif pengiriman.
- Event yang sudah digate:
  - `logbook_reminder`
  - `logbook_missing`
  - `low_attendance`
  - `cuti_request`
  - `surat_request`
  - `milestone_update`
- Jika event `enabled=false`:
  - row `notifications` tidak dibuat
  - row `dashboard_reminder_logs` tidak dibuat
  - endpoint pengiriman akan return info `skipped=true` untuk flow yang relevan
- Reminder otomatis backend berjalan via scheduler dan memakai `notif.reminder`:
  - `firstTime`
  - `secondTime`
  - `deadlineTime`
  - `toleranceDays`

## 13) Draft Reports

### GET `/draft-reports?studentId=...&type=...`
- Query wajib:
  - `studentId`
- Query opsional:
  - `type` (`Semua` / label aktif dari config backend)
  - `projectId`
- Deskripsi:
  - Data draft sekarang dibaca dari tabel persisten `draft_reports`.
  - Selama masa transisi, data legacy sintetis dari logbook + audit log masih bisa ikut muncul.
- Response tambahan:
  - `file_url`, `file_name`, `file_size`, `mime_type`
  - `version`, `projectId`, `reviewedBy`, `reviewedAt`

### POST `/draft-reports`
- Body wajib:
  - `studentId`, `projectId`, `title`, `type`, `fileName`, `fileDataUrl`
- Body opsional:
  - `id`
- Catatan:
  - Jika `id` tidak dikirim, backend akan generate ID otomatis format `DRF-YYYYMMDD-XXX`.
  - Status default draft baru: `Menunggu Review`.
  - Versi default draft baru: `v1.0`.
  - File valid: PDF/DOC/DOCX, maksimal 10 MB.
  - File disimpan ke `/uploads/drafts/...`.

### PUT `/draft-reports/:id`
- Deskripsi: update draft/revisi mahasiswa.
- Body opsional:
  - `title`, `type`, `projectId`, `fileName`, `fileDataUrl`, `clearAttachment`
- Catatan:
  - Jika upload revisi baru, backend mengganti file lama dengan file baru.
  - Versi akan otomatis naik konsisten, misalnya `v1.0 -> v1.1`.
  - Status otomatis di-reset ke `Menunggu Review`.

### PATCH `/draft-reports/:id/review`
- Body wajib:
  - `status` (`Menunggu Review`/`Dalam Review`/`Disetujui`)
  - `reviewedBy`
- Body opsional:
  - `studentId`
  - `note`, `reviewedByName`
- Catatan:
  - Review dosen tetap disimpan ke audit log.
  - Jika draft sudah persisten, status/comment/reviewer juga ikut diupdate ke tabel `draft_reports`.

## 13.1) Draft Report Types

### GET `/draft-report-types`
- Query opsional:
  - `includeInactive=true|false`
- Deskripsi: ambil daftar jenis draft/laporan dari backend.

### POST `/draft-report-types`
- Role: `operator`
- Body wajib:
  - `label`
- Body opsional:
  - `id`, `is_active`, `sort_order`
- Deskripsi: tambah jenis draft/laporan baru.

### DELETE `/draft-report-types/:id`
- Role: `operator`
- Deskripsi: hapus jenis draft/laporan dari backend config.

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
