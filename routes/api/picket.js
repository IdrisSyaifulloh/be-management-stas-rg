const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const { requireSafeId } = require("../../utils/securityValidation");
const { resolveStudentId } = require("../../utils/studentResolver");
const {
  createPicketLeaveRequest,
  createPicketSchedule,
  createPicketSubmission,
  createPicketTask,
  deletePicketSchedule,
  deletePicketTask,
  generatePicketSchedule,
  getPicketHistory,
  getPicketOverview,
  getPicketSettings,
  getPicketTodayForStudent,
  isPicketManagerUser,
  listPicketDays,
  listPicketLeaveRequests,
  listPicketManagers,
  listPicketSchedules,
  listPicketStudentOptions,
  listPicketTasks,
  replacePicketManagers,
  resyncPicketSchedule,
  reviewPicketLeaveRequest,
  reviewPicketSubmission,
  updatePicketSchedule,
  updatePicketSettings,
  updatePicketTask
} = require("../../utils/picketService");

const router = express.Router();

function scheduleResponse(item) {
  const schedule = item?.schedule || item;
  const assignment = item?.assignment || item;
  const response = { schedule, assignment };
  if (item?.task) response.task = item.task;
  return response;
}

router.use((req, res, next) => {
  if (!extractRole(req)) {
    return res.status(403).json({ message: "Akses piket membutuhkan autentikasi." });
  }
  return next();
});

async function canManagePicket(req) {
  const role = extractRole(req);
  if (role === "operator") return true;
  if (role === "mahasiswa" && req.authUser?.id) {
    return isPicketManagerUser(req.authUser.id);
  }
  return false;
}

async function requirePicketManager(req, res) {
  if (await canManagePicket(req)) return true;
  res.status(403).json({ message: "Akses kelola piket hanya untuk operator atau PIC piket." });
  return false;
}

async function resolveAllowedStudentId(req, inputStudentId) {
  const role = extractRole(req);
  const manager = await canManagePicket(req);

  if (role === "mahasiswa" && !manager) {
    return resolveStudentId(req.authUser?.id);
  }

  return resolveStudentId(inputStudentId || req.authUser?.id);
}

async function assertStudentScope(req, inputStudentId) {
  const role = extractRole(req);
  const manager = await canManagePicket(req);
  const resolvedInput = await resolveStudentId(inputStudentId);

  if (!resolvedInput) {
    const error = new Error("Mahasiswa tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }

  if (role === "mahasiswa" && !manager) {
    const ownStudentId = await resolveStudentId(req.authUser?.id);
    if (ownStudentId !== resolvedInput) {
      const error = new Error("Anda hanya dapat mengakses data piket sendiri.");
      error.statusCode = 403;
      throw error;
    }
  }

  return resolvedInput;
}

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json(await getPicketSettings());
  })
);

router.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    res.json(await updatePicketSettings({
      ...(req.body || {}),
      updatedBy: req.authUser?.id || null
    }));
  })
);

router.get(
  "/days",
  asyncHandler(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || "true").toLowerCase() !== "false";
    res.json(await listPicketDays({ includeInactive }));
  })
);

router.get(
  "/students",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const items = await listPicketStudentOptions();
    res.json({ items, students: items });
  })
);

router.get(
  "/tasks",
  asyncHandler(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || "true").toLowerCase() !== "false";
    res.json(await listPicketTasks({ includeInactive }));
  })
);

router.post(
  "/tasks",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    res.status(201).json(await createPicketTask(req.body || {}));
  })
);

router.patch(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const task = await updatePicketTask(id, req.body || {});
    if (!task) return res.status(404).json({ message: "Tugas piket tidak ditemukan." });
    return res.json(task);
  })
);

router.delete(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const task = await deletePicketTask(id);
    if (!task) return res.status(404).json({ message: "Tugas piket tidak ditemukan." });
    return res.json({ message: "Tugas piket dinonaktifkan.", task });
  })
);

router.get(
  "/managers",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Daftar PIC piket hanya untuk operator." });
    }
    return res.json(await listPicketManagers());
  })
);

router.patch(
  "/managers",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Pengaturan PIC piket hanya untuk operator." });
    }
    const items = await replacePicketManagers(req.body?.studentIds || req.body?.student_ids || [], req.authUser?.id || null);
    return res.json({ items });
  })
);

router.get(
  "/managers/me",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.json({ isManager: false });
    }
    return res.json({ isManager: await isPicketManagerUser(req.authUser?.id) });
  })
);

router.post(
  "/schedules",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const item = await createPicketSchedule({
      ...(req.body || {}),
      createdBy: req.authUser?.id || null,
      updatedBy: req.authUser?.id || null
    });
    return res.status(201).json(scheduleResponse(item));
  })
);

router.get(
  "/schedules",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const items = await listPicketSchedules({
      date: req.query.date || req.query.scheduleDate || req.query.schedule_date || null,
      studentId: req.query.studentId || req.query.student_id || null,
      dayId: req.query.dayId || req.query.day_id || null
    });
    return res.json({ items, schedules: items, assignments: items });
  })
);

router.patch(
  "/schedules/:id",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const item = await updatePicketSchedule(id, {
      ...(req.body || {}),
      updatedBy: req.authUser?.id || null
    });
    if (!item) return res.status(404).json({ message: "Jadwal piket tidak ditemukan." });
    return res.json(scheduleResponse(item));
  })
);

router.delete(
  "/schedules/:id",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const item = await deletePicketSchedule(id);
    if (!item) return res.status(404).json({ message: "Jadwal piket tidak ditemukan." });
    return res.json({ message: "Jadwal piket dihapus.", schedule: item, assignment: item });
  })
);

router.post(
  "/schedules/generate",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const result = await generatePicketSchedule({
      date: req.body?.date,
      peoplePerDay: req.body?.peoplePerDay ?? req.body?.people_per_day,
      randomize: req.body?.randomize,
      studentIds: req.body?.studentIds || req.body?.student_ids,
      replaceExisting: req.body?.replaceExisting ?? req.body?.replace_existing,
      overwrite: req.body?.overwrite,
      generatedBy: req.authUser?.id || null
    });
    return res.status(201).json(result);
  })
);

router.post(
  "/schedules/resync",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Resync jadwal piket hanya untuk operator." });
    }
    const result = await resyncPicketSchedule({
      date: req.body?.date,
      generatedBy: req.authUser?.id || null
    });
    return res.json(result);
  })
);

router.get(
  "/operator/overview",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    return res.json(await getPicketOverview(req.query.date));
  })
);

router.get(
  "/today",
  asyncHandler(async (req, res) => {
    const studentId = await resolveAllowedStudentId(req, req.query.studentId || req.query.student_id);
    if (!studentId) return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    return res.json(await getPicketTodayForStudent(studentId, req.query.date));
  })
);

router.get(
  "/history",
  asyncHandler(async (req, res) => {
    const studentId = await resolveAllowedStudentId(req, req.query.studentId || req.query.student_id);
    if (!studentId) return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    return res.json(await getPicketHistory(studentId));
  })
);

router.post(
  "/submissions",
  asyncHandler(async (req, res) => {
    const studentId = await assertStudentScope(req, req.body?.studentId || req.body?.student_id);
    const submission = await createPicketSubmission({
      ...(req.body || {}),
      studentId
    });
    return res.status(201).json(submission);
  })
);

router.patch(
  "/submissions/:id/review",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const submission = await reviewPicketSubmission(id, {
      ...(req.body || {}),
      reviewedBy: req.body?.reviewedBy || req.body?.reviewed_by || req.authUser?.id || null
    });
    if (!submission) return res.status(404).json({ message: "Submission piket tidak ditemukan." });
    return res.json(submission);
  })
);

router.get(
  "/leave-requests",
  asyncHandler(async (req, res) => {
    if (await canManagePicket(req)) {
      return res.json(await listPicketLeaveRequests({
        studentId: req.query.studentId || req.query.student_id || null,
        date: req.query.date || null
      }));
    }

    const studentId = await resolveAllowedStudentId(req, req.query.studentId || req.query.student_id);
    if (!studentId) return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    return res.json(await listPicketLeaveRequests({ studentId, date: req.query.date || null }));
  })
);

router.post(
  "/leave-requests",
  asyncHandler(async (req, res) => {
    const studentId = await assertStudentScope(req, req.body?.studentId || req.body?.student_id);
    const item = await createPicketLeaveRequest({
      ...(req.body || {}),
      studentId
    });
    return res.status(201).json(item);
  })
);

router.patch(
  "/leave-requests/:id/status",
  asyncHandler(async (req, res) => {
    if (!(await requirePicketManager(req, res))) return;
    const id = requireSafeId(req.params.id, "id");
    const item = await reviewPicketLeaveRequest(id, {
      ...(req.body || {}),
      reviewedBy: req.body?.reviewedBy || req.body?.reviewed_by || req.authUser?.id || null
    });
    if (!item) return res.status(404).json({ message: "Pengajuan izin piket tidak ditemukan." });
    return res.json(item);
  })
);

module.exports = router;
