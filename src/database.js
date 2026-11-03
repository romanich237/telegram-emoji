const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createDatabase(filename) {
  const fullPath = path.resolve(process.cwd(), filename);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const db = new Database(fullPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      pack_type TEXT NOT NULL DEFAULT 'custom_emoji',
      total_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS emojis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      custom_emoji_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_unique_id TEXT,
      emoji TEXT,
      description TEXT NOT NULL DEFAULT '',
      is_animated INTEGER NOT NULL DEFAULT 0,
      is_video INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      UNIQUE(pack_id, custom_emoji_id)
    );
    CREATE INDEX IF NOT EXISTS idx_emojis_pack ON emojis(pack_id);
    CREATE INDEX IF NOT EXISTS idx_emojis_custom_id ON emojis(custom_emoji_id);
  `);
  return db;
}

module.exports = { createDatabase };