var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
var env = require('./config/env');
var validateEnv = require('./config/validateEnv');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var apiRouter = require('./routes/api');

var envValidationResult = validateEnv();
if (!envValidationResult.isValid) {
  throw new Error(`Invalid environment configuration: ${envValidationResult.errors.join(' | ')}`);
}

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: false, limit: '6mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/api', apiRouter);
app.use('/api/v1', apiRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404, 'Route tidak ditemukan'));
});

// error handler
app.use(function(err, req, res, next) {
  if (req.path.startsWith('/api')) {
    return res.status(err.status || 500).json({
      message: err.message || 'Internal server error'
    });
  }

  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
