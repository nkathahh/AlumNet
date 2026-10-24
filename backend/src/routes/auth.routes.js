const express = require('express');
const { dbRateLimit } = require('../utils/rateLimit');
const router = express.Router();
const auth = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

// Separate limits per purpose. Successful requests are not counted where
// that makes sense, so normal use never hits a limit; repeated failures
// (password or code guessing) do.
const limiter = (name, limit, skipSuccessfulRequests = true) => dbRateLimit(name, {
  windowMs: 15 * 60 * 1000,
  limit,
  skipSuccessfulRequests,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});
const signInLimit = limiter('sign-in', 10);
// Per account as well as per network address, so guesses spread across many
// addresses still stop. Set higher than the address limit so that someone
// failing on purpose cannot easily lock a member out; a password reset or
// Google sign-in still works while it lasts, and the owner is told once.
const ACCOUNT_FAILURES = 20;
const accountSignInLimit = dbRateLimit('sign-in-account', {
  windowMs: 15 * 60 * 1000,
  limit: ACCOUNT_FAILURES,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `email:${String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 150)}`,
  handler: async (req, res, next, options) => {
    if (req.rateLimit && req.rateLimit.used === ACCOUNT_FAILURES + 1) {
      await auth.warnAccountUnderAttack(String((req.body && req.body.email) || '')).catch(() => null);
    }
    res.status(options.statusCode).json({ error: 'Too many wrong attempts for this account. Wait 15 minutes, or reset your password.' });
  }
});
// The two-factor step, per account (the temporary token says whose it is)
const accountCodeLimit = dbRateLimit('code-account', {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const decoded = require('jsonwebtoken').decode(String((req.body && req.body.tempToken) || ''));
    return `user:${(decoded && decoded.userId) || 'unknown'}`;
  },
  message: { error: 'Too many wrong codes. Wait 15 minutes and sign in again.' }
});
const codeLimit = limiter('code', 10);
const accountLimit = limiter('account', 20);
// These send emails, so every request counts: at most 20 from one network address in
// 15 minutes, and at most 5 for any one email
const emailIpLimit = limiter('email-ip', 20, false);
const perEmailLimit = dbRateLimit('email', {
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
router.post('/login', signInLimit, accountSignInLimit, auth.login);
router.post('/google', signInLimit, auth.googleLogin);
router.post('/2fa/verify', codeLimit, accountCodeLimit, auth.verifyTwoFactor);
router.post('/logout', auth.logout);
router.post('/logout-everywhere', requireAuth, auth.logoutEverywhere);

// Password recovery
router.post('/forgot-password', emailLimit, auth.forgotPassword);
router.post('/reset-password', accountLimit, auth.resetPassword);

// Account settings (signed-in users)
router.get('/account', requireAuth, auth.getAccount);
router.post('/privacy', requireAuth, auth.acceptPrivacy);
router.put('/account/alerts', requireAuth, auth.setAlerts);
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
