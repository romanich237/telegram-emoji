const crypto = require('node:crypto');

function setupAuth(db, allowedUsers) {
  const allowed = new Set(allowedUsers.map(String));
  db.exec(`CREATE TABLE IF NOT EXISTS access_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  // Promote existing valid keys without reviving expired keys.
  db.prepare('UPDATE access_tokens SET expires_at=0 WHERE expires_at>?').run(Date.now());
  const replaceToken = db.transaction((id, hash) => {
    db.prepare('DELETE FROM access_tokens WHERE user_id=?').run(id);
    db.prepare('INSERT INTO access_tokens(token_hash,user_id,expires_at) VALUES(?,?,0)').run(hash, id);
  });
  function isAllowed(id) { return allowed.has(String(id)); }
  function issue(id) {
    if (!isAllowed(id)) throw new Error('Access denied');
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    replaceToken(String(id), hash);
    return { token };
  }
  function verify(token) {
    if (typeof token !== 'string' || !token) return false;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return verifyHash(hash);
  }
  function verifyHash(hash) {
    const row = db.prepare('SELECT user_id,expires_at FROM access_tokens WHERE token_hash=?').get(hash);
    return Boolean(row && row.expires_at === 0 && isAllowed(row.user_id));
  }
  function revoke(id) {
    db.prepare('DELETE FROM access_tokens WHERE user_id=?').run(String(id));
  }
  return { isAllowed, issue, verify, verifyHash, revoke };
}
module.exports = { setupAuth };