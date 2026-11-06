/*
 * In production the server refuses to start with missing or weak secrets,
 * instead of quietly running with a guessable key. Locally and in tests the
 * development fallbacks still apply, so nothing changes there.
 */
function secretProblems(env = process.env) {
  const problems = [];
  if (String(env.JWT_SECRET || '').length < 32) problems.push('JWT_SECRET must be set to at least 32 random characters');
  if (!/^[0-9a-fA-F]{64}$/.test(String(env.TOTP_ENC_KEY || ''))) problems.push('TOTP_ENC_KEY must be 64 hex characters');
  const ml = String(env.ML_SERVICE_URL || '');
  const mlIsLocal = !ml || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(ml);
  if (!mlIsLocal && String(env.ML_API_KEY || '').length < 32) problems.push('ML_API_KEY must be set to at least 32 random characters when the matching service is remote');
  return problems;
}

function checkSecrets(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const problems = secretProblems(env);
  if (!problems.length) {
    if (!env.GATEWAY_SECRET) console.warn('GATEWAY_SECRET is not set: requests are accepted without the gateway.');
    return;
  }
  console.error(`AlumNet will not start in production:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

module.exports = { checkSecrets, secretProblems };
