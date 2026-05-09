var createError = require("http-errors");
var express = require("express");
var path = require("path");
var cookieParser = require("cookie-parser");
var logger = require("morgan");
var cors = require("cors");
var jwt = require("jsonwebtoken");
var rateLimit = require("express-rate-limit");
var env = require("./config/env");
var validateEnv = require("./config/validateEnv");

var indexRouter = require("./routes/index");
var usersRouter = require("./routes/users");
var apiRouter = require("./routes/api");
var { query } = require("./db/pool");
var { studentAccessLockMiddleware } = require("./utils/studentAccessLocks");
var { hasControlChars } = require("./utils/securityValidation");
var { revokeJwtSession, verifyJwtSession, extendJwtSessionIfNeeded, JWT_SESSION_TTL_MS } = require("./utils/jwtSessionStore");
var { getAuthCookieOptions } = require("./utils/authCookieOptions");

var envValidationResult = validateEnv();

if (!envValidationResult.isValid) {
  throw new Error(
    `Invalid environment configuration: ${envValidationResult.errors.join(" | ")}`
  );
}

var app = express();

// Percayai proxy pertama (Nginx) agar req.ip = IP asli client, bukan 127.0.0.1
app.set("trust proxy", 1);

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");

app.use(logger("dev"));

// ======================================================
// CORS
// ======================================================
var allowedOrigins = String(env.corsOrigin || "")
  .split(",")
  .map(function (origin) { return origin.trim(); })
  .filter(Boolean);

var corsOptions = {
  origin: function (origin, callback) {
    // Di production: wajib ada Origin dan harus ada di whitelist
    if (!origin) {
      if (env.nodeEnv === "production") {
        return callback(new Error("CORS: Origin header wajib ada."));
      }
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS blocked for origin: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ======================================================
// RATE LIMITING
// ======================================================
var loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Terlalu banyak percobaan login. Coba lagi dalam 15 menit." },
  keyGenerator: function (req) {
    return req.ip + ":" + String(req.body && req.body.identifier || "").slice(0, 80);
  }
});

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: false, limit: "15mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth/login", loginRateLimiter);
app.use("/api/v1/auth/login", loginRateLimiter);

// ======================================================
// JWT AUTH MIDDLEWARE
// ======================================================
function clearAuthCookieResponse(res) {
  res.cookie("accessToken", "", {
    ...getAuthCookieOptions(),
    maxAge: 0
  });
}

function isAuthPublicEndpoint(req) {
  if (req.method !== "POST") return false;

  return (
    req.path === "/api/auth/login" ||
    req.path === "/api/v1/auth/login" ||
    req.path === "/api/auth/logout" ||
    req.path === "/api/v1/auth/logout"
  );
}

app.use(async function (req, res, next) {
  if (hasControlChars(req.query) || hasControlChars(req.body)) {
    return res.status(400).json({ message: "Input tidak valid." });
  }

  if (isAuthPublicEndpoint(req)) {
    return next();
  }

  // Try to extract JWT from httpOnly cookie first (primary method)
  var token = req.cookies && req.cookies.accessToken;

  if (token) {
    try {
      var decoded = jwt.verify(token, env.jwtSecret);
      var sessionIsActive = await verifyJwtSession({
        id: decoded.jti,
        userId: decoded.id,
        token: token
      });

      if (!sessionIsActive) {
        clearAuthCookieResponse(res);

        return res.status(401).json({
          message: "Sesi tidak valid atau sudah berakhir."
        });
      }

      var activeUserResult = await query(
        "SELECT id, is_active FROM users WHERE id = $1 LIMIT 1",
        [decoded.id]
      );

      if (activeUserResult.rowCount === 0 || activeUserResult.rows[0].is_active === false) {
        await revokeJwtSession({
          id: decoded.jti,
          userId: decoded.id,
          token: token
        });
        clearAuthCookieResponse(res);

        return res.status(403).json({
          message: "Akun Anda tidak aktif. Hubungi administrator untuk bantuan."
        });
      }

      req.authUser = {
        id: decoded.id,
        role: decoded.role,
        name: decoded.name
      };
      req.authSessionId = decoded.jti;

      // Sliding session: perpanjang cookie jika sudah lewat setengah TTL
      extendJwtSessionIfNeeded({
        id: decoded.jti,
        userId: decoded.id,
        token: token
      }).then((extended) => {
        if (extended) {
          res.cookie("accessToken", token, {
            ...getAuthCookieOptions(),
            maxAge: JWT_SESSION_TTL_MS
          });
        }
      }).catch(() => {});

      return next();
    } catch (error) {
      if (error && (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError")) {
        clearAuthCookieResponse(res);

        return res.status(401).json({
          message: "Token tidak valid atau sudah expired."
        });
      }

      return next(error);
    }
  }

  // Fallback to Authorization header (for API/mobile clients)
  var authHeader = req.headers["authorization"];

  if (authHeader && authHeader.startsWith("Bearer ")) {
    var headerToken = authHeader.slice(7);

    try {
      var decodedHeader = jwt.verify(headerToken, env.jwtSecret);
      var headerSessionIsActive = await verifyJwtSession({
        id: decodedHeader.jti,
        userId: decodedHeader.id,
        token: headerToken
      });

      if (!headerSessionIsActive) {
        return res.status(401).json({
          message: "Sesi tidak valid atau sudah berakhir."
        });
      }

      req.authUser = {
        id: decodedHeader.id,
        role: decodedHeader.role,
        name: decodedHeader.name
      };
      req.authSessionId = decodedHeader.jti;

      return next();
    } catch (error) {
      if (error && (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError")) {
        return res.status(401).json({
          message: "Token tidak valid atau sudah expired."
        });
      }

      return next(error);
    }
  }

  // Tidak ada JWT cookie / Bearer token yang valid.
  // Header `x-user-role` / `x-user-id` dari client TIDAK boleh dipercaya
  // karena bisa dimanipulasi (privilege escalation).
  // Lanjutkan tanpa req.authUser — route guard akan menolak request
  // ke endpoint yang butuh autentikasi (403 dari requireRoleStrict).
  next();
});

// ======================================================
// SECURITY HEADERS
// ======================================================
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");

  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';"
  );

  if (env.nodeEnv === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }

  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  next();
});

app.use(studentAccessLockMiddleware);

// ======================================================
// START CLEANUP JOB FOR WITHDRAWN STUDENTS
// ======================================================
var cleanupJob = require("./jobs/cleanupWithdrawnStudents");
cleanupJob.startMonitoring();

var notificationReminderJob = require("./jobs/notificationReminderScheduler");
notificationReminderJob.startMonitoring();

var autoCheckoutJob = require("./jobs/autoCheckoutScheduler");
autoCheckoutJob.startMonitoring();

var autoAlumniJob = require("./jobs/autoAlumniScheduler");
autoAlumniJob.startMonitoring();

var weeklyResearchAttendanceSuspensionJob = require("./jobs/weeklyResearchAttendanceSuspension");
weeklyResearchAttendanceSuspensionJob.startMonitoring();

// ======================================================
// ROUTES
// ======================================================
app.use("/", indexRouter);
app.use("/users", usersRouter);
app.use("/api", apiRouter);
app.use("/api/v1", apiRouter);

// ======================================================
// ERROR HANDLING
// ======================================================
app.use(function (req, res, next) {
  next(createError(404, "Route tidak ditemukan"));
});

app.use(function (err, req, res, next) {
  if (req.path.startsWith("/api")) {
    var status = err.status || err.statusCode || 500;

    return res.status(status).json({
      message:
        status >= 500
          ? "Terjadi kesalahan pada server."
          : err.message || "Input tidak valid."
    });
  }

  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  res.status(err.status || 500);
  res.render("error");
});

module.exports = app;
