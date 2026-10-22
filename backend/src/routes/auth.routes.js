const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const auth = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

// Separate limits per purpose. Successful requests are not counted where
// that makes sense, so normal use never hits a limit; repeated failures
// (password or code guessing) do.
const limiter = (limit, skipSuccessfulRequests = true) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit,
  skipSuccessfulRequests,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});
const signInLimit = limiter(10);
const codeLimit = limiter(10);
const accountLimit = limiter(20);
// These send emails, so every request counts: at most 20 from one network address in
// 15 minutes, and at most 5 for any one email
const emailIpLimit = limiter(20, false);
const perEmailLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `email:${String((req.body && req.body.email) || '').trim().toLowerCase()}`,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});
const emailLimit = [emailIpLimit, perEmailLimit];

// Registration (verified by the email HR holds, or by the alumni office)
router.post('/signup/start', emailLimit, auth.signupStart);
router.get('/signup/link', accountLimit, auth.signupLink);
router.post('/signup/complete', accountLimit, auth.signupComplete);
router.post('/signup/review', accountLimit, auth.signupRequestReview);

// Sign-in
router.post('/login', signInLimit, auth.login);
router.post('/google', signInLimit, auth.googleLogin);
router.post('/2fa/verify', codeLimit, auth.verifyTwoFactor);
router.post('/logout', auth.logout);
router.post('/logout-everywhere', requireAuth, auth.logoutEverywhere);

// Password recovery
router.post('/forgot-password', emailLimit, auth.forgotPassword);
router.post('/reset-password', accountLimit, auth.resetPassword);

// Account settings (signed-in users)
router.get('/account', requireAuth, auth.getAccount);
router.post('/change-password', requireAuth, accountLimit, auth.changePassword);
router.post('/2fa/setup', requireAuth, auth.setupTwoFactor);
router.post('/2fa/enable', requireAuth, codeLimit, auth.enableTwoFactor);
router.post('/2fa/backup-codes', requireAuth, codeLimit, auth.regenerateBackupCodes);
router.post('/2fa/disable', requireAuth, codeLimit, auth.disableTwoFactor);
router.post('/google/link', requireAuth, auth.linkGoogle);
router.delete('/google/link', requireAuth, auth.unlinkGoogle);

// Data rights
router.get('/account/export', requireAuth, auth.exportMyData);
router.post('/account/delete', requireAuth, codeLimit, auth.deleteMyAccount);

module.exports = router;
