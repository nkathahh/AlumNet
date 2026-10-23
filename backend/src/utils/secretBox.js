/*
 * Encryption for secrets the server has to read back, such as two-factor
 * (TOTP) secrets. Passwords and backup codes are hashed, but a TOTP secret
 * must be usable, so it is encrypted with AES-256-GCM instead. A copy of
 * the database alone is then not enough to make someone's sign-in codes.
 *
 * The key comes from TOTP_ENC_KEY (64 hex characters). Keep it out of the
 * database and out of git, like JWT_SECRET.
 */
const crypto = require('crypto');

const PREFIX = 'v1:';
let cachedKeys = null;

// The first key encrypts. Older keys are only tried when reading, so secrets
// encrypted before TOTP_ENC_KEY was set (with the fallback key) still work.
function keys() {
  if (cachedKeys) return cachedKeys;
  const fallback = crypto.scryptSync(String(process.env.JWT_SECRET || 'dev-only'), 'alumnet-totp-key', 32);
  const hex = process.env.TOTP_ENC_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKeys = [Buffer.from(hex, 'hex'), fallback];
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.warn('TOTP_ENC_KEY is not set: two-factor secrets are encrypted with a key derived from JWT_SECRET. Set TOTP_ENC_KEY.');
    }
    // Development fallback, so the app still works before the key is set
    cachedKeys = [fallback];
  }
  return cachedKeys;
}
const key = () => keys()[0];

function seal(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

// Values saved before encryption was added are returned as they are
function open(stored) {
  if (!stored) return null;
  if (!isSealed(stored)) return stored;
  const [iv, tag, body] = stored.slice(PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64'));
  for (const k of keys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch { /* try the next key */ }
  }
  throw new Error('Could not decrypt a two-factor secret: check TOTP_ENC_KEY');
}

// True when a value is sealed with an older key (for example before
// TOTP_ENC_KEY was set), so start-up can seal it again with the current key
function needsReseal(stored) {
  if (!isSealed(stored)) return true;
  const [iv, tag, body] = stored.slice(PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64'));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    Buffer.concat([decipher.update(body), decipher.final()]);
    return false;
  } catch {
    return true;
  }
}

function isSealed(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

module.exports = { seal, open, isSealed, needsReseal };
