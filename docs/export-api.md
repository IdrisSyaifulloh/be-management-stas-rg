# Export API

Dokumentasi ini ditujukan untuk integrasi frontend fitur ekspor custom STAS-RG.

## Base URL

- `http://localhost:3000/api/v1/exports`
- Alias lama tetap tersedia di `http://localhost:3000/api/exports`

## Auth Header

Endpoint export berada di belakang role guard `operator`, jadi frontend wajib mengirim:

- `x-user-role: operator`
- `x-user-id: <user-id-operator>`

Jika header role tidak dikirim, API akan mengembalikan `403`.

## Endpoint Utama

### 1. Ambil metadata jenis export

`GET /api/v1/exports/templates`

Tujuan:
- Mengambil daftar jenis export yang tersedia
- Mengetahui format file yang didukung
- Mengetahui filter mana yang valid per jenis export

Contoh response:

```json
[
  {
    "id": "kehadiran",
    "title": "Rekap Kehadiran",
    "desc": "Data kehadiran mahasiswa beserta status check-in dan check-out.",
    "period": "Kustom",
    "formats": ["xlsx", "csv", "pdf"],
    "filters": {
      "student": true,
      "project": true,
      "dateRange": true
    },
    "endpoint": "/api/v1/exports/custom?type=kehadiran"
  }
]
```

### 2. Generate export custom

`GET /api/v1/exports/custom`

Query params:

- `type` wajib
- `format` wajib di frontend, tetapi backend akan default ke `csv` jika tidak dikirim
- `studentId` opsional
- `projectId` opsional
- `startDate` opsional
- `endDate` opsional

Contoh:

```http
GET /api/v1/exports/custom?type=kehadiran&format=xlsx&studentId=STD-001&projectId=PRJ-002&startDate=2026-03-01&endDate=2026-03-31
```

## Jenis Export yang Didukung

### 1. `kehadiran`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Kolom output:
- `Nama`
- `NIM`
- `Tanggal`
- `Status`
- `Check-in`
- `Check-out`

### 2. `logbook`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Kolom output:
- `Nama`
- `NIM`
- `Riset`
- `Tanggal`
- `Judul`
- `Deskripsi`
- `Output`

### 3. `riset`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Kolom output:
- `ID Riset`
- `Judul`
- `Short Title`
- `Status`
- `Progress`
- `Periode`
- `Mitra`
- `Kategori`
- `Pembimbing`
- `Jumlah Anggota`
- `Total Milestone`
- `Milestone Selesai`
- `Tanggal Dibuat`

### 4. `cuti`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Kolom output:
- `Nama`
- `NIM`
- `Riset`
- `Tanggal Pengajuan`
- `Mulai Cuti`
- `Selesai Cuti`
- `Durasi`
- `Status`
- `Alasan`
- `Catatan`

### 5. `database-mahasiswa`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Kolom output:
- `Nama`
- `NIM`
- `Email`
- `Prodi`
- `Angkatan`
- `Tipe`
- `Status`
- `Tanggal Bergabung`
- `Riset Aktif`

### 6. `layanan-surat`

Format:
- `xlsx`
- `csv`
- `pdf`

Filter:
- `studentId`
- `startDate`
- `endDate`

Catatan:
- `projectId` tidak didukung untuk jenis ini

Kolom output:
- `Nama`
- `NIM`
- `Jenis Surat`
- `Tanggal`
- `Tujuan`
- `Status`
- `Estimasi Selesai`
- `Nomor Surat`

## Endpoint Langsung per Jenis

Selain `custom`, frontend juga bisa memanggil endpoint langsung:

- `GET /api/v1/exports/kehadiran`
- `GET /api/v1/exports/logbook`
- `GET /api/v1/exports/riset`
- `GET /api/v1/exports/cuti`
- `GET /api/v1/exports/database-mahasiswa`
- `GET /api/v1/exports/layanan-surat`
- `GET /api/v1/exports/rekap-data`

Semua endpoint di atas tetap menerima query param yang sama:

- `format`
- `studentId`
- `projectId`
- `startDate`
- `endDate`

Contoh:

```http
GET /api/v1/exports/kehadiran?format=pdf&studentId=STD-001&startDate=2026-03-01&endDate=2026-03-31
```

## Format Query Param

### `format`

Nilai yang didukung:

- `xlsx`
- `csv`
- `pdf`

### `startDate` dan `endDate`

Format tanggal yang diterima backend:

- `YYYY-MM-DD`
- `DD/MM/YYYY`

Disarankan frontend mengirim `YYYY-MM-DD`.

## Status Code dan Error Handling

### `200 OK`

Berhasil generate file.

Response akan berupa file binary dengan `Content-Type` sesuai format:

- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `text/csv; charset=utf-8`
- `application/pdf`

### `400 Bad Request`

Kasus umum:

- `type` tidak dikirim
- `format` tidak didukung
- format tanggal salah
- `startDate > endDate`
- filter tidak cocok dengan jenis export

Contoh response:

```json
{
  "message": "Format export \"txt\" tidak didukung. Pilihan: xlsx, csv, pdf."
}
```

```json
{
  "message": "Tanggal dari tidak boleh lebih besar dari tanggal sampai."
}
```

```json
{
  "message": "Filter riset tidak didukung untuk export Layanan Surat."
}
```

### `403 Forbidden`

Kasus:

- Header role tidak dikirim
- Role bukan `operator`

Contoh response:

```json
{
  "message": "Akses ditolak. Role wajib dikirim dan harus salah satu dari: operator."
}
```

### `404 Not Found`

Kasus:

- `studentId` tidak ditemukan
- `projectId` tidak ditemukan
- data hasil export kosong
- data pada rentang tanggal yang diminta kosong

Contoh response:

```json
{
  "message": "Mahasiswa yang dipilih tidak ditemukan."
}
```

```json
{
  "message": "Riset yang dipilih tidak ditemukan."
}
```

```json
{
  "message": "Tidak ada data Rekap Kehadiran untuk rentang tanggal 01 Januari 2099 - 31 Januari 2099."
}
```

### `422 Unprocessable Entity`

Kasus:

- export `pdf` terlalu besar

Contoh response:

```json
{
  "message": "Export PDF Rekap Kehadiran dibatasi maksimal 500 baris. Gunakan CSV atau XLSX untuk data besar."
}
```

## Saran Implementasi Frontend

### Mapping pilihan UI ke query param

Gunakan mapping berikut:

- Jenis data -> `type`
- Format file -> `format`
- Mahasiswa -> `studentId`
- Riset -> `projectId`
- Tanggal dari -> `startDate`
- Tanggal sampai -> `endDate`

### Perilaku frontend yang disarankan

- Panggil `/templates` saat halaman load
- Render opsi export berdasarkan `templates`
- Render filter `Riset` hanya jika `filters.project === true`
- Render filter tanggal hanya jika `filters.dateRange === true`
- Saat download file, gunakan `responseType: 'blob'`
- Jika response status bukan `200`, tampilkan `message` dari backend

### Contoh pseudocode fetch

```ts
const params = new URLSearchParams({
  type: "kehadiran",
  format: "xlsx",
  studentId: "STD-001",
  projectId: "PRJ-002",
  startDate: "2026-03-01",
  endDate: "2026-03-31"
});

const response = await fetch(`/api/v1/exports/custom?${params.toString()}`, {
  method: "GET",
  headers: {
    "x-user-role": "operator",
    "x-user-id": currentUserId
  }
});

if (!response.ok) {
  const error = await response.json();
  throw new Error(error.message);
}

const blob = await response.blob();
```

## Catatan Penting

- Untuk kompatibilitas maksimal, frontend sebaiknya selalu memakai endpoint `custom`
- Format `xlsx`, `csv`, dan `pdf` semuanya sudah aktif di backend
- Endpoint lama tetap tersedia untuk backward compatibility
- Jika user memilih kombinasi filter yang tidak valid, backend akan mengembalikan pesan yang sudah siap ditampilkan langsung ke UI
