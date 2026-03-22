var express = require('express');
var router = express.Router();

/* GET users listing. */
router.get('/', function(req, res, next) {
  res.json({
    message: 'Gunakan endpoint /api/students, /api/lecturers, atau /api/auth/login.'
  });
});

module.exports = router;
