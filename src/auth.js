const crypto = require('node:crypto');

function setupAuth(db, allowedUsers) {
  const allowed = new Set(allowedUsers.map(String));
  db.exec(`CREATE TABLE IF NOT EXISTS access_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  function isAllowed(id) { return allowed.has(String(id)); }
  function issue(id) {
    if (!isAllowed(id)) throw new Error('Access denied');
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM access_tokens WHERE expires_at < ? OR user_id = ?').run(Date.now(), String(id));
    db.prepare('INSERT INTO access_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,String(id),expires);
    return { token, expires };
  }
  function verify(token) {
    if (typeof token !== 'string' || !token) return false;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare('SELECT user_id,expires_at FROM access_tokens WHERE token_hash=?').get(hash);
    return Boolean(row && row.expires_at > Date.now() && isAllowed(row.user_id));
  }
  function revoke(id) {
    db.prepare('DELETE FROM access_tokens WHERE user_id=?').run(String(id));
  }
  return { isAllowed, issue, verify, revoke };
}
module.exports = { setupAuth };