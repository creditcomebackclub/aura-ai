const crypto = require('crypto');

function isValidCronSecret(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function safeSecretEqual(expected, provided) {
  if (!isValidCronSecret(expected) || !isValidCronSecret(provided)) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function createSchedulerAuthenticator(expectedSecret) {
  return function authenticateScheduler(req, res, next) {
    if (!isValidCronSecret(expectedSecret)) {
      return res.status(503).json({ error: 'Scheduled checks are not configured.' });
    }
    if (!safeSecretEqual(expectedSecret, req.get('x-aura-cron-secret'))) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    return next();
  };
}

module.exports = {
  createSchedulerAuthenticator,
  isValidCronSecret,
  safeSecretEqual
};
