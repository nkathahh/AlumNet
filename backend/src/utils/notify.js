const pool = require('../config/db');

// Notifications are a side effect: if one fails, the action that triggered it still succeeds
async function createNotification(userId, type, message, link = null) {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, type, message, link) VALUES (:userId, :type, :message, :link)',
      { userId, type, message: message.slice(0, 255), link }
    );
  } catch (err) {
    console.error('Could not create notification:', err.message);
  }
}

async function notifyMany(userIds, type, message, link = null) {
  await Promise.all(userIds.map((id) => createNotification(id, type, message, link)));
}

async function getUserName(userId) {
  try {
    const [[row]] = await pool.execute('SELECT name FROM users WHERE user_id = :userId', { userId });
    return row ? row.name : 'Someone';
  } catch {
    return 'Someone';
  }
}

module.exports = { createNotification, notifyMany, getUserName };