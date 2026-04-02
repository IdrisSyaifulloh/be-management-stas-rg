/**
 * Scheduled Job: Delete Withdrawn Student Accounts
 * 
 * This script automatically deletes student accounts that have been in 
 * "Mengundurkan Diri" status for more than 30 days.
 * 
 * Run this as a background job or schedule it via cron.
 */

const { query } = require("../db/pool");

/**
 * Delete students whose scheduled_deletion_at has passed
 */
async function deleteExpiredWithdrawnAccounts() {
  try {
    // Find students whose deletion date has passed
    const expiredStudents = await query(
      `
      SELECT s.id, s.user_id, s.nim, u.name, u.email, 
             s.withdrawal_at, s.scheduled_deletion_at
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.status = 'Mengundurkan Diri'
        AND s.scheduled_deletion_at <= NOW()
        AND s.scheduled_deletion_at IS NOT NULL
      `,
      []
    );

    if (expiredStudents.rowCount === 0) {
      console.log('[Cleanup] No expired withdrawn student accounts to delete.');
      return { deleted: 0, message: 'No accounts to delete' };
    }

    console.log(`[Cleanup] Found ${expiredStudents.rowCount} expired withdrawn student account(s) to delete.`);

    const deletedAccounts = [];

    for (const student of expiredStudents.rows) {
      await query("BEGIN");
      try {
        const auditId = `aud_cleanup_${Date.now()}_${student.user_id}`;
        
        // Log the deletion for audit purposes
        await query(
          `
          INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            auditId,
            null,
            'System',
            'Delete',
            'student_account_cleanup',
            JSON.stringify({
              student_id: student.id,
              user_id: student.user_id,
              nim: student.nim,
              name: student.name,
              email: student.email,
              withdrawal_at: student.withdrawal_at,
              scheduled_deletion_at: student.scheduled_deletion_at,
              reason: 'Account automatically deleted after 30 days of withdrawal',
              deleted_at: new Date().toISOString()
            })
          ]
        );

        // Delete the user (cascade will delete the student record)
        await query(
          `DELETE FROM users WHERE id = $1`,
          [student.user_id]
        );

        await query("COMMIT");
        
        deletedAccounts.push({
          user_id: student.user_id,
          nim: student.nim,
          name: student.name
        });
        
        console.log(`[Cleanup] Deleted account for ${student.name} (${student.nim})`);
      } catch (error) {
        await query("ROLLBACK");
        console.error(`[Cleanup] Error deleting account for ${student.nim}:`, error.message);
      }
    }

    const result = {
      deleted: deletedAccounts.length,
      accounts: deletedAccounts,
      message: `Successfully deleted ${deletedAccounts.length} withdrawn student account(s)`
    };

    console.log('[Cleanup]', result.message);
    return result;
  } catch (error) {
    console.error('[Cleanup] Error during cleanup job:', error.message);
    throw error;
  }
}

/**
 * Run cleanup job immediately
 */
async function runCleanup() {
  try {
    console.log('[Cleanup] Starting withdrawn student account cleanup...');
    const result = await deleteExpiredWithdrawnAccounts();
    console.log('[Cleanup] Cleanup completed.');
    return result;
  } catch (error) {
    // Log error but don't crash - allow retry on next interval
    console.error('[Cleanup] Cleanup job failed (will retry in 1 hour):', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error('[Cleanup] Database connection failed. Check your database configuration.');
    }
    return { deleted: 0, message: 'Cleanup failed', error: error.message };
  }
}

/**
 * Start continuous monitoring (runs every hour)
 */
function startMonitoring() {
  const ONE_HOUR = 60 * 60 * 1000; // 1 hour in milliseconds
  
  console.log('[Cleanup] Starting withdrawn student account monitoring (runs every hour)...');
  
  // Run immediately on start
  runCleanup().catch(() => {}); // Ignore errors, already logged
  
  // Then run every hour
  setInterval(() => {
    runCleanup().catch(() => {}); // Ignore errors, already logged
  }, ONE_HOUR);
}

// Export for use in app.js or as a standalone script
module.exports = {
  deleteExpiredWithdrawnAccounts,
  runCleanup,
  startMonitoring
};

// If run directly as a script
if (require.main === module) {
  runCleanup()
    .then(() => {
      console.log('Cleanup job finished.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Cleanup job failed:', err);
      process.exit(1);
    });
}
