# Seed Accounts

Seluruh akun hasil seed memakai password yang sama:

- `12345678`

Backend login menerima identifier berikut:

- `id`
- `email`
- `nim` untuk mahasiswa
- `nip` untuk dosen

## Operator

| Nama | ID | Email | Password |
| --- | --- | --- | --- |
| Operator Sistem | `SEED-USR-OP-001` | `operator.sistem@seed.stasrg.local` | `12345678` |
| Operator Akademik | `SEED-USR-OP-002` | `operator.akademik@seed.stasrg.local` | `12345678` |

## Dosen

| Nama | ID | Email | NIP | Password |
| --- | --- | --- | --- | --- |
| Dr. Ahmad Fauzi | `SEED-USR-DOS-001` | `ahmad.fauzi@seed.stasrg.local` | `8800012026001` | `12345678` |
| Siti Nurhaliza, M.Kom | `SEED-USR-DOS-002` | `siti.nurhaliza@seed.stasrg.local` | `8800012026002` | `12345678` |
| Bima Prakoso, Ph.D | `SEED-USR-DOS-003` | `bima.prakoso@seed.stasrg.local` | `8800012026003` | `12345678` |

## Mahasiswa

| Nama | ID | Email | NIM | Status | Password |
| --- | --- | --- | --- | --- | --- |
| Alya Putri Ramadhani | `SEED-USR-MHS-001` | `alya.ramadhani@seed.stasrg.local` | `2200010001` | `Aktif` | `12345678` |
| Rizky Maulana | `SEED-USR-MHS-002` | `rizky.maulana@seed.stasrg.local` | `2200010002` | `Aktif` | `12345678` |
| Nabila Safitri | `SEED-USR-MHS-003` | `nabila.safitri@seed.stasrg.local` | `2200010003` | `Aktif` | `12345678` |
| Muhammad Idris | `SEED-USR-MHS-004` | `muhammad.idris@seed.stasrg.local` | `2200010004` | `Cuti` | `12345678` |
| Dea Lestari | `SEED-USR-MHS-005` | `dea.lestari@seed.stasrg.local` | `2200010005` | `Alumni` | `12345678` |
| Fajar Nugraha | `SEED-USR-MHS-006` | `fajar.nugraha@seed.stasrg.local` | `2200010006` | `Mengundurkan Diri` | `12345678` |

## Catatan

- Akun `USR-MHS-006` berstatus `Mengundurkan Diri`.
- Sesuai logic auth saat ini, akun mengundurkan diri dapat diblok sementara saat `withdrawal_at` masih dalam masa hold.
- Untuk demo normal, paling aman gunakan akun dengan status `Aktif`.
