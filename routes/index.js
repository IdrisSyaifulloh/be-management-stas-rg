var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.json({
    service: 'be-managementstas',
    message: 'Backend API aktif. Gunakan prefix /api.'
  });
});

module.exports = router;
