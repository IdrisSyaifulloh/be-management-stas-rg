function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function extractRole(req) {
  if (req?.authUser?.role) {
    return normalizeRole(req.authUser.role);
  }
  return normalizeRole(req.headers["x-user-role"] || req.query.role || req.body?.role);
}

function requireRoleSoft(allowedRoles) {
  const allowed = new Set((allowedRoles || []).map(normalizeRole));

  return (req, res, next) => {
    const role = extractRole(req);

    // Non-breaking mode:
    // if role is not provided, skip enforcement to preserve existing clients.
    if (!role) {
      return next();
    }

    if (!allowed.has(role)) {
      return res.status(403).json({
        message: `Akses ditolak. Role yang diizinkan: ${Array.from(allowed).join(", ")}.`
      });
    }

    return next();
  };
}

function requireRoleStrict(allowedRoles) {
  const allowed = new Set((allowedRoles || []).map(normalizeRole));

  return (req, res, next) => {
    const role = extractRole(req);
    if (!role) {
      return res.status(403).json({
        message: `Akses ditolak. Role wajib dikirim dan harus salah satu dari: ${Array.from(allowed).join(", ")}.`
      });
    }

    if (!allowed.has(role)) {
      return res.status(403).json({
        message: `Akses ditolak. Role yang diizinkan: ${Array.from(allowed).join(", ")}.`
      });
    }

    return next();
  };
}

module.exports = {
  extractRole,
  requireRoleSoft,
  requireRoleStrict
};
