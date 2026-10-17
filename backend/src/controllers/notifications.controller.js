const pool = require('../config/db');

async function listMyNotifications(req, res, next) {
  try {
    const { userId } = req.user;
    const [rows] = await pool.execute(
      `SELECT notification_id, type, message, link, is_read, created_at
       FROM notifications WHERE user_id = :userId
       ORDER BY created_at DESC LIMIT 50`,
      { userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function unreadCount(req, res, next) {
  try {
    const { userId } = req.user;
    const [[{ count }]] = await pool.execute(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = :userId AND is_read = 0',
      { userId }
    );
    res.json({ count: Number(count) });
  } catch (err) {
    next(err);
  }
}

// The user_id check stops anyone marking another user's notifications as read
async function markRead(req, res, next) {
  try {
    const { userId } = req.user;
    await pool.execute(
      'UPDATE notifications SET is_read = 1 WHERE notification_id = :id AND user_id = :userId',
      { id: req.params.id, userId }
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function markAllRead(req, res, next) {
  try {
    const { userId } = req.user;
    await pool.execute('UPDATE notifications SET is_read = 1 WHERE user_id = :userId AND is_read = 0', { userId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMyNotifications, unreadCount, markRead, markAllRead };