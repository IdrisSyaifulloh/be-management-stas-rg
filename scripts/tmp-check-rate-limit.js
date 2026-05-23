const rateLimit = require('express-rate-limit');
console.log('rateLimit type:', typeof rateLimit);
console.log('ipKeyGenerator type:', typeof rateLimit.ipKeyGenerator);
if (typeof rateLimit.ipKeyGenerator === 'function') {
  console.log('fn string:', rateLimit.ipKeyGenerator.toString());
}
try {
  rateLimit({ windowMs: 1000, max: 1, keyGenerator: function(req){ return rateLimit.ipKeyGenerator(req.ip)+':foo' } });
  console.log('validation ok');
} catch (e) {
  console.error('validation error', e.code, e.message);
}
