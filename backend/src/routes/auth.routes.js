const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

// Separate limits per purpose. Successful requests are not counted, so normal
// use never hits a limit; repeated failures (password or code guessing) do.
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
// Every reset request sends an email, so these count whether or not they succeed
const emailLimit = limiter(5, false);

// Registration and sign-in
router.post('/register', accountLimit, authController.register);
router.get('/username-available', authController.usernameAvailable);
router.get('/staff-lookup', authController.staffLookup);
router.post('/login', signInLimit, authController.login);
router.post('/google', signInLimit, authController.googleLogin);
router.post('/2fa/verify', codeLimit, authController.verifyTwoFactor);

// Password recovery
router.post('/forgot-password', emailLimit, authController.forgotPassword);
router.post('/reset-password', accountLimit, authController.resetPassword);

// Account settings (signed-in users)
router.get('/account', requireAuth, authController.getAccount);
router.patch('/username', requireAuth, authController.updateUsername);
router.post('/change-password', requireAuth, accountLimit, authController.changePassword);
router.post('/2fa/setup', requireAuth, authController.setupTwoFactor);
router.post('/2fa/enable', requireAuth, codeLimit, authController.enableTwoFactor);
router.post('/2fa/disable', requireAuth, codeLimit, authController.disableTwoFactor);
router.post('/google/link', requireAuth, authController.linkGoogle);
router.delete('/google/link', requireAuth, authController.unlinkGoogle);

module.exports = router;
