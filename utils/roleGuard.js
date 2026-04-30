function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function extractRole(req) {
  // Role HANYA boleh diambil dari JWT yang sudah diverifikasi (req.authUser).
  // Tidak ada fallback ke header / query / body karena bisa dimanipulasi client.
  if (req?.authUser?.role) {
    return normalizeRole(req.authUser.role);
  }
  return "";
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
