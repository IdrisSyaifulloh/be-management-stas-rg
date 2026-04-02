# Student Withdrawal (Mengundurkan Diri) Implementation

## Overview

When an operator changes a student's status from **Aktif** to **Mengundurkan Diri**, the following workflow is triggered:

1. **Temporary HOLD**: The student account cannot login to the web application
2. **30-Day Grace Period**: The account remains in the system for 30 days
3. **Automatic Deletion**: After 30 days, the account is automatically deleted

## Database Changes

### New Columns Added to `students` Table

```sql
withdrawal_at TIMESTAMPTZ        -- When the student withdrew
scheduled_deletion_at TIMESTAMPTZ -- When the account will be deleted (withdrawal_at + 30 days)
```

### Migration

Run the migration to add the new columns:
```bash
npm run db:migrate
```

Or manually:
```bash
node ./db/runSqlFile.js ./db/migrations/001_add_withdrawal_tracking.sql
```

## How It Works

### 1. Operator Changes Status to "Mengundurkan Diri"

**Endpoint**: `PUT /api/students/:id`

**Request Body**:
```json
{
  "status": "Mengundurkan Diri"
}
```

**What Happens**:
- `withdrawal_at` is set to the current timestamp
- `scheduled_deletion_at` is set to `NOW() + 30 days`
- An audit log entry is created
- The response includes a warning about the Temporary HOLD status

**Response**:
```json
{
  "message": "Data mahasiswa berhasil diperbarui.",
  "warning": "Mahasiswa telah mengundurkan diri. Akun dalam status Temporary HOLD dan akan dihapus dalam 30 hari.",
  "scheduled_deletion_at": "2026-05-01T12:00:00.000Z"
}
```

### 2. Student Cannot Login (Temporary HOLD)

When a withdrawn student tries to login:

**Endpoint**: `POST /api/auth/login`

**Response (403 Forbidden)**:
```json
{
  "message": "Akun Anda dalam status Temporary HOLD karena telah mengundurkan diri. Akun akan dihapus setelah 30 hari.",
  "withdrawal_at": "2026-04-01T12:00:00.000Z",
  "scheduled_deletion_at": "2026-05-01T12:00:00.000Z",
  "days_remaining": 25
}
```

### 3. Automatic Deletion After 30 Days

**Background Job**: The system runs an hourly cleanup job that:
- Finds all students with `scheduled_deletion_at <= NOW()`
- Deletes their accounts (cascade deletes the student record)
- Creates an audit log entry for each deletion

**Manual Trigger** (Operator only):
```bash
POST /api/cleanup/withdrawn-students
```

**Response**:
```json
{
  "message": "Cleanup job completed successfully.",
  "deleted_count": 2,
  "deleted_accounts": [
    { "user_id": "usr_mhs_...", "nim": "12345", "name": "John Doe" },
    { "user_id": "usr_mhs_...", "nim": "67890", "name": "Jane Smith" }
  ]
}
```

## Files Modified/Created

### Modified Files
- `routes/api/auth.js` - Added Temporary HOLD check in login
- `routes/api/students.js` - Added withdrawal timestamp logic and audit logging
- `routes/api/index.js` - Added cleanup router
- `app.js` - Started cleanup job monitoring

### New Files
- `db/migrations/001_add_withdrawal_tracking.sql` - Database migration
- `jobs/cleanupWithdrawnStudents.js` - Cleanup job logic
- `routes/api/cleanup.js` - Cleanup API endpoint
- `docs/withdrawal-workflow.md` - This documentation

## Audit Logging

All withdrawal and deletion events are logged in the `audit_logs` table:

### Withdrawal Event
```json
{
  "action": "Update",
  "target": "student_withdrawal",
  "detail": {
    "student_id": "...",
    "previous_status": "Aktif",
    "new_status": "Mengundurkan Diri",
    "withdrawal_at": "2026-04-01T12:00:00.000Z",
    "scheduled_deletion_at": "2026-05-01T12:00:00.000Z",
    "message": "Student withdrawn - account set to Temporary HOLD for 30 days"
  }
}
```

### Deletion Event
```json
{
  "action": "Delete",
  "target": "student_account_cleanup",
  "detail": {
    "student_id": "...",
    "user_id": "...",
    "nim": "12345",
    "name": "John Doe",
    "email": "john@example.com",
    "withdrawal_at": "2026-04-01T12:00:00.000Z",
    "scheduled_deletion_at": "2026-05-01T12:00:00.000Z",
    "reason": "Account automatically deleted after 30 days of withdrawal",
    "deleted_at": "2026-05-01T12:00:00.000Z"
  }
}
```

## Testing

### Test Withdrawal Flow

1. **Change student status to Mengundurkan Diri**:
```bash
curl -X PUT http://localhost:3000/api/students/{student_id} \
  -H "Content-Type: application/json" \
  -H "x-user-role: operator" \
  -H "x-user-id: {operator_id}" \
  -d '{"status": "Mengundurkan Diri"}'
```

2. **Try logging in as the withdrawn student**:
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier": "{nim}", "password": "{password}"}'
```
Expected: 403 response with Temporary HOLD message

3. **Manually trigger cleanup** (after 30 days or by modifying `scheduled_deletion_at`):
```bash
curl -X POST http://localhost:3000/api/cleanup/withdrawn-students \
  -H "x-user-role: operator" \
  -H "x-user-id: {operator_id}"
```

## Notes

- The cleanup job runs **every hour** automatically
- Only accounts with `status = 'Mengundurkan Diri'` AND `scheduled_deletion_at <= NOW()` are deleted
- All deletions are logged for audit purposes
- The 30-day period starts from when the status is changed to "Mengundurkan Diri"
- If needed, operators can manually trigger the cleanup job via the API

## Environment Variables

No new environment variables are required. The cleanup job uses the existing database connection pool.

## Security

- The cleanup endpoint is protected and only accessible by users with `operator` role
- All withdrawal and deletion actions are logged in `audit_logs`
- The Temporary HOLD check happens before password validation to prevent information leakage
