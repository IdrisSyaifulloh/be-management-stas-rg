const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { parseBoundedLimit, requireEnum } = require("../../utils/securityValidation");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { action, role, limit = 50 } = req.query;
    const normalizedAction = requireEnum(action, ["Login", "Create", "Update", "Delete", "Approve", "Export"], "action");
    const normalizedRole = requireEnum(role, ["Mahasiswa", "Dosen", "Operator"], "role");
    const { whereClause, params } = buildWhereClause([
      { value: normalizedAction, sql: (index) => `al.action = $${index}` },
      { value: normalizedRole, sql: (index) => `al.user_role = $${index}` }
    ]);

    params.push(parseBoundedLimit(limit, 50, 200));

    const result = await query(
      `
      SELECT al.id, al.user_id, u.name AS user_name, u.initials AS user_initials,
             al.user_role, al.action, al.target, al.ip,
             al.detail, al.logged_at
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ${whereClause}
      ORDER BY al.logged_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    res.json(result.rows);
  })
);

module.exports = router;
