const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const env = require("../../config/env");
const { getAuthCookieOptions } = require("../../utils/authCookieOptions");
const {
  createJwtSession,
  generateSessionId,
  getJwtSessionExpiresAt,
  revokeJwtSession
} = require("../../utils/jwtSessionStore");

const router = express.Router();

const INACTIVE_ACCOUNT_MESSAGE = "Akun Anda tidak aktif. Silakan hubungi administrator.";

const loginSchema = z.object({
  identifier: z.preprocess(
    (value) => (value == null ? undefined : value),
    z.string().trim().min(1).max(160)
  ).optional(),
  email: z.preprocess(
    (value) => (value == null ? undefined : value),
    z.string().trim().min(1).max(160)
  ).optional(),
  password: z.string().min(1).max(200)
}).superRefine((value, ctx) => {
  if (!value.identifier && !value.email) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["email"],
      message: "Email wajib diisi"
    });
  }
});

function sendLoginError(res, statusCode, message, extra = {}) {
  return res.status(statusCode).json({
    status: "error",
    message,
    ...extra
  });
}

function formatLoginValidationErrors(error) {
  const errors = {};

  for (const issue of error.issues || []) {
    const field = issue.path[0] === "identifier" ? "email" : issue.path[0];
    if (!field) continue;

    if (!errors[field]) errors[field] = [];

    if (field === "password") {
      errors[field].push(issue.code === "too_big" ? "Password terlalu panjang" : "Password wajib diisi");
    } else if (field === "email") {
      errors[field].push(issue.code === "too_big" ? "Email terlalu panjang" : "Email wajib diisi");
    } else {
      errors[field].push(issue.message || "Input tidak valid");
    }
  }

  return errors;
}

function clearAuthCookies(res) {
  const cookieOptions = getAuthCookieOptions();

  res.cookie("accessToken", "", {
    ...cookieOptions,
    maxAge: 0
  });

  res.cookie("sessionId", "", {
    ...cookieOptions,
    maxAge: 0
  });
}

let ensureAuthLoginColumnsPromise = null;

async function ensureAuthLoginColumns() {
  if (!ensureAuthLoginColumnsPromise) {
    ensureAuthLoginColumnsPromise = (async () => {
      await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
      `);

      await query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS withdrawal_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ
      `);
    })();
  }

  await ensureAuthLoginColumnsPromise;
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    await ensureAuthLoginColumns();

    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        status: "error",
        errors: formatLoginValidationErrors(validation.error)
      });
    }

    const { password } = validation.data;
    const identifier = validation.data.identifier || validation.data.email;

    const result = await query(
      `
      SELECT u.id, u.name, u.initials, u.role, u.prodi, u.password_hash, u.is_active,
             s.nim, s.tipe, s.status AS student_status, s.withdrawal_at, s.scheduled_deletion_at,
             l.nip
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN lecturers l ON l.user_id = u.id
      WHERE u.id = $1 OR u.email = $1 OR s.nim = $1 OR l.nip = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (result.rowCount === 0) {
      return sendLoginError(res, 401, "Identifier atau password salah.");
    }

    const user = result.rows[0];
    if (user.role === "mahasiswa" && user.student_status === "Mengundurkan Diri" && user.withdrawal_at) {
      const withdrawalDate = new Date(user.withdrawal_at);
      const now = new Date();
      const daysSinceWithdrawal = Math.floor((now - withdrawalDate) / (1000 * 60 * 60 * 24));

      if (daysSinceWithdrawal < 30) {
        return sendLoginError(res, 403, "Akun Anda dalam status Temporary HOLD karena telah mengundurkan diri. Akun akan dihapus setelah 30 hari.", {
          days_remaining: 30 - daysSinceWithdrawal
        });
      }
    }

    if (user.is_active === false) {
      return sendLoginError(res, 403, INACTIVE_ACCOUNT_MESSAGE);
    }

    const validPassword = user.password_hash ? await bcrypt.compare(password, user.password_hash) : false;
    if (!validPassword) {
      return sendLoginError(res, 401, "Identifier atau password salah.");
    }

    const sessionId = generateSessionId();
    const expiresAt = getJwtSessionExpiresAt();
    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        name: user.name,
        jti: sessionId
      },
      env.jwtSecret,
      { expiresIn: "15m" }
    );

    await createJwtSession({
      id: sessionId,
      userId: user.id,
      token,
      expiresAt,
      userAgent: req.get("user-agent") || null,
      ip: req.ip || null
    });

    // Set httpOnly cookie (secure, not accessible via JavaScript/console)
    res.cookie("accessToken", token, {
      ...getAuthCookieOptions(),
      maxAge: 15 * 60 * 1000  // 15 menit
    });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: user.role,
        prodi: user.prodi,
        tipe: user.role === "mahasiswa" ? user.tipe : undefined,
        status: user.role === "mahasiswa" ? user.student_status : undefined,
        studentStatus: user.role === "mahasiswa" ? user.student_status : undefined
      }
    });
  })
);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    await ensureAuthLoginColumns();

    if (!req.authUser?.id) {
      return res.status(401).json({ message: "Tidak terautentikasi." });
    }

    const result = await query(
      `
      SELECT u.id, u.name, u.initials, u.role, u.prodi, u.is_active,
             s.tipe AS student_tipe,
             s.status AS student_status
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      WHERE u.id = $1
      LIMIT 1
      `,
      [req.authUser.id]
    );

    if (result.rowCount === 0 || result.rows[0].is_active === false) {
      return res.status(401).json({ message: "Sesi tidak valid." });
    }

    const user = result.rows[0];

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: user.role,
        prodi: user.prodi,
        tipe: user.role === "mahasiswa" ? user.student_tipe : undefined,
        status: user.role === "mahasiswa" ? user.student_status : undefined,
        studentStatus: user.role === "mahasiswa" ? user.student_status : undefined
      }
    });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token =
      (req.cookies && req.cookies.accessToken) ||
      (String(req.headers.authorization || "").startsWith("Bearer ")
        ? String(req.headers.authorization).slice(7)
        : null);

    await revokeJwtSession({
      id: req.authSessionId || null,
      userId: req.authUser?.id || null,
      token
    });

    clearAuthCookies(res);

    return res.json({ message: "Logged out" });
  })
);

module.exports = router;
