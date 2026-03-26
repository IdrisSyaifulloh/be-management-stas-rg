const express = require("express");

const healthRouter = require("./health");
const authRouter = require("./auth");
const studentsRouter = require("./students");
const lecturersRouter = require("./lecturers");
const researchRouter = require("./research");
const logbooksRouter = require("./logbooks");
const leaveRequestsRouter = require("./leaveRequests");
const letterRequestsRouter = require("./letterRequests");
const certificatesRouter = require("./certificates");
const auditLogsRouter = require("./auditLogs");
const dashboardRouter = require("./dashboard");
const attendanceRouter = require("./attendance");
const draftReportsRouter = require("./draftReports");
const profileRouter = require("./profile");
const systemSettingsRouter = require("./systemSettings");
const exportsRouter = require("./exports");
const notificationsRouter = require("./notifications");
const { requireRoleSoft, requireRoleStrict } = require("../../utils/roleGuard");

const router = express.Router();

router.use("/health", healthRouter);
router.use("/auth", authRouter);

router.use("/students", requireRoleStrict(["operator", "dosen"]), studentsRouter);
router.use("/lecturers", requireRoleStrict(["operator", "dosen"]), lecturersRouter);
router.use("/research", researchRouter);
router.use("/logbooks", logbooksRouter);
router.use("/leave-requests", leaveRequestsRouter);
router.use("/letter-requests", letterRequestsRouter);
router.use("/certificates", certificatesRouter);
router.use("/audit-logs", requireRoleStrict(["operator"]), auditLogsRouter);
router.use("/dashboard", dashboardRouter);
router.use("/attendance", attendanceRouter);
router.use("/draft-reports", draftReportsRouter);
router.use("/profile", profileRouter);
router.use("/notifications", notificationsRouter);
router.use("/system-settings", requireRoleSoft(["operator"]), systemSettingsRouter);
router.use("/exports", requireRoleStrict(["operator"]), exportsRouter);

module.exports = router;
