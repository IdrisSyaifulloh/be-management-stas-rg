# Monitoring & Activity Tracking API

## Overview

Endpoint ini digunakan untuk memonitor aktivitas mahasiswa yang tidak memenuhi target kehadiran (jam) atau target logbook.

## Endpoints

### 1. Low Activity Monitoring
**GET** `/api/monitoring/low-activity`

Menampilkan daftar mahasiswa yang:
- **Low Attendance:** Jam kerja minggu ini (`jam_minggu_ini`) kurang dari target (`jam_minggu_target`).
- **Low Logbook:** Jumlah entry logbook bulan ini kurang dari 4 (asumsi target standar).

#### Headers
- `x-user-role`: `operator`
- `x-user-id`: ID operator

#### Response
```json
{
  "timestamp": "2026-04-04T12:00:00.000Z",
  "lowAttendance": [
    {
      "id": "stu_...",
      "user_id": "usr_mhs_...",
      "name": "John Doe",
      "nim": "12345",
      "initials": "JD",
      "hours_logged": 5,
      "hours_target": 10,
      "status": "Aktif"
    }
  ],
  "lowLogbook": [
    {
      "id": "stu_...",
      "user_id": "usr_mhs_...",
      "name": "Jane Smith",
      "nim": "67890",
      "initials": "JS",
      "logbook_count": 1,
      "total_logbook": 25
    }
  ]
}
```

#### Logic
1. **Low Attendance**:
   - Query: `SELECT ... WHERE jam_minggu_ini < jam_minggu_target`
   - Menggunakan data cached di tabel `students` (tidak perlu join ke attendance_records).
   
2. **Low Logbook**:
   - Query: `COUNT(logbook_entries) WHERE date >= start_of_month`
   - Target default: 4 entry per bulan.
   - Hasil diurutkan dari yang paling sedikit logbooknya.

## Progress Board - Lampiran (Attachment Link)

### Overview
Fitur untuk menambahkan link lampiran (Google Drive, PDF, dll) ke progress board riset.

### Database Changes
**File:** `db/migrations/002_add_attachment_link.sql`
- Added `attachment_link TEXT` column to `research_projects` table

### API Changes

#### GET `/api/research` & `/api/research/:id`
- Response now includes `attachment_link` field

#### PUT `/api/research/:id`
- Accepts `attachmentLink` in request body
- Example payload:
```json
{
  "attachmentLink": "https://drive.google.com/file/d/xxx"
}
```

### Frontend Changes
**File:** `src/app/components/SharedBoardView.tsx`
- Added attachment link section in progress board
- Edit/Save functionality with inline input
- Clickable link to open attachment in new tab

## Files Modified/Created

| File | Status | Purpose |
|------|--------|---------|
| `routes/api/monitoring.js` | NEW | Endpoint monitoring aktivitas |
| `routes/api/index.js` | MODIFIED | Register monitoring router |
| `routes/api/research.js` | MODIFIED | Added attachment_link to CRUD |
| `db/migrations/002_add_attachment_link.sql` | NEW | Add attachment_link column |
| `src/app/components/SharedBoardView.tsx` | MODIFIED | UI for attachment link |

## Notes
- Endpoint monitoring memerlukan role `operator` (strict guard).
- Data `lowAttendance` bersifat realtime berdasarkan kolom yang diupdate oleh sistem attendance.
- Data `lowLogbook` dihitung langsung dari database setiap kali endpoint dipanggil.
- Attachment link bersifat opsional, bisa kosong (null).
