var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
var jwt = require('jsonwebtoken');
var env = require('./config/env');
var validateEnv = require('./config/validateEnv');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var apiRouter = require('./routes/api');
var { studentAccessLockMiddleware } = require('./utils/studentAccessLocks');
var { hasControlChars } = require('./utils/securityValidation');

var envValidationResult = validateEnv();
if (!envValidationResult.isValid) {
  throw new Error(`Invalid environment configuration: ${envValidationResult.errors.join(' | ')}`);
}

var app = express();

app.use(logger('dev'));
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: false, limit: '15mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));


// ======================================================
// � JWT AUTH MIDDLEWARE
// ======================================================
app.use((req, res, next) => {
  if (hasControlChars(req.query) || hasControlChars(req.body)) {
    return res.status(400).json({ message: "Input tidak valid." });
  }

// Try to extract JWT from httpOnly cookie first (primary method)
  const token = req.cookies?.accessToken;
  if (token) {
    try {
      const decoded = jwt.verify(token, env.jwtSecret);
      req.authUser = {
        id: decoded.id,
        role: decoded.role,
        name: decoded.name
      };
      return next();
    } catch (error) {
      // Token invalid/expired
      return res.status(401).json({ message: "Token tidak valid atau sudah expired." });
    }
  }

  // Fallback to Authorization header (for API/mobile clients)
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const headerToken = authHeader.slice(7);
    try {
      const decoded = jwt.verify(headerToken, env.jwtSecret);
      req.authUser = {
        id: decoded.id,
        role: decoded.role,
        name: decoded.name
      };
      return next();
    } catch (error) {
      return res.status(401).json({ message: "Token tidak valid atau sudah expired." });
    }
  }

  // Legacy header-based auth for backward compatibility (optional, should be removed eventually)
  const role = req.headers["x-user-role"];
  const id = req.headers["x-user-id"];

  if (hasControlChars(req.headers["x-user-id"]) || hasControlChars(req.headers["x-user-role"])) {
    return res.status(400).json({ message: "Input tidak valid." });
  }

  if (role && id) {
    req.authUser = {
      id: String(id),
      role: String(role)
    };
  }

  next();
});

// ======================================================
// 🛡️ SECURITY HEADERS
// ======================================================
app.use((req, res, next) => {
  // Prevent XSS attacks
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  
  // Strict CSP (Content Security Policy)
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';");
  
  // HSTS (enforce HTTPS in production)
  if (env.nodeEnv === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  
  next();
});

app.use(studentAccessLockMiddleware);

// ======================================================
// START CLEANUP JOB FOR WITHDRAWN STUDENTS
// ======================================================
// This automatically deletes student accounts 30 days after withdrawal
const cleanupJob = require('./jobs/cleanupWithdrawnStudents');
cleanupJob.startMonitoring();
const notificationReminderJob = require('./jobs/notificationReminderScheduler');
notificationReminderJob.startMonitoring();
const autoCheckoutJob = require('./jobs/autoCheckoutScheduler');
autoCheckoutJob.startMonitoring();


// ======================================================
// ROUTES
// ======================================================
app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/api', apiRouter);
app.use('/api/v1', apiRouter);


// ======================================================
// ERROR HANDLING
// ======================================================

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404, 'Route tidak ditemukan'));
});

// error handler
app.use(function(err, req, res, next) {
  if (req.path.startsWith('/api')) {
    const status = err.status || err.statusCode || 500;
    return res.status(status).json({
      message: status >= 500 ? 'Terjadi kesalahan pada server.' : (err.message || 'Input tidak valid.')
    });
  }

  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
