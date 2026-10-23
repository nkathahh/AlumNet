/*
 * Rate limits kept in the database instead of server memory, so they
 * survive a restart (a deploy or a crash would otherwise reset every
 * counter, giving a password guesser a fresh start) and are shared if more
 * than one copy of the server runs.
 */
const { rateLimit } = require('express-rate-limit');
const pool = require('../config/db');

class DbStore {
  constructor(name) {
    this.prefix = `${name}:`;
    this.localKeys = false; // counts are shared, not per process
  }

  init(options) {
    this.windowSeconds = Math.ceil(options.windowMs / 1000);
  }

  async increment(key) {
    const k = (this.prefix + key).slice(0, 190);
    // One statement, so two requests at the same moment cannot both read the old count
    await pool.execute(
      `INSERT INTO rate_limits (rl_key, hits, reset_at) VALUES (:k, 1, DATE_ADD(NOW(), INTERVAL :w SECOND))
       ON DUPLICATE KEY UPDATE
         hits = IF(reset_at <= NOW(), 1, hits + 1),
         reset_at = IF(reset_at <= NOW(), DATE_ADD(NOW(), INTERVAL :w SECOND), reset_at)`,
      { k, w: this.windowSeconds }
    );
    const [[row]] = await pool.execute('SELECT hits, reset_at FROM rate_limits WHERE rl_key = :k', { k });
    return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
  }

  async decrement(key) {
    await pool.execute('UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE rl_key = :k', { k: (this.prefix + key).slice(0, 190) });
  }

  async resetKey(key) {
    await pool.execute('DELETE FROM rate_limits WHERE rl_key = :k', { k: (this.prefix + key).slice(0, 190) });
  }
}

// Same options as express-rate-limit, plus a name so each limit counts separately.
// If the database cannot be reached the request is let through: the route
// itself will fail anyway, and a limit should never lock everyone out.
function dbRateLimit(name, options) {
  return rateLimit({ ...options, store: new DbStore(name), passOnStoreError: true });
}

// Old counters are removed by the clean-up job
async function pruneRateLimits() {
  await pool.query('DELETE FROM rate_limits WHERE reset_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
}

module.exports = { dbRateLimit, DbStore, pruneRateLimits };
