# Maintenance Playbook

Dokumen ini untuk mempermudah handover antar developer.

## Rilis perubahan aman
1. Jalankan `npm run check:config`.
2. Jalankan `npm run db:migrate` pada environment target.
3. Jika butuh data awal/testing, jalankan `npm run db:seed`.
4. Jalankan aplikasi dan cek `GET /api/health`.

## Checklist sebelum merge
- Tidak ada duplikasi helper/filter baru.
- Endpoint baru sudah didaftarkan di router index.
- SQL tetap backward-compatible bila memungkinkan.
- README backend sudah diperbarui jika kontrak endpoint berubah.
- Jika endpoint sensitif: pastikan role guard di `routes/api/index.js` dipasang sesuai kebutuhan.

## Konvensi naming
- Tabel: snake_case plural (`leave_requests`)
- Kolom: snake_case (`reviewed_at`)
- Alias response: gunakan nama yang mudah dibaca frontend (`student_name`, `project_name`)

## Strategi perubahan besar
- Gunakan alias version path (`/api/v1`) untuk transisi.
- Hindari breaking change langsung di `/api` tanpa periode migrasi.
- Jika endpoint lama harus dipensiunkan, buat fase:
  - fase 1: tambah endpoint baru
  - fase 2: frontend migrasi
  - fase 3: endpoint lama ditandai deprecated

## Catatan keamanan saat ini
- Konteks user saat ini berbasis header `x-user-role` + `x-user-id` (tanpa token/JWT).
- Role guard saat ini masih mode soft (agar client lama tidak putus).
- Untuk hardening, migrasikan bertahap ke mode strict setelah semua client konsisten mengirim header tersebut.
