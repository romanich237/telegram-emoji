const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(process.cwd(),'config.json');
if (!fs.existsSync(file)) {
  fs.copyFileSync(path.resolve(process.cwd(),'config.example.json'),file);
  throw new Error('Создан config.json. Укажите botToken и allowedUsers, затем перезапустите PM2.');
}
const input = JSON.parse(fs.readFileSync(file,'utf8'));
if (typeof input.botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(input.botToken)) throw new Error('Некорректный botToken');
if (!Array.isArray(input.allowedUsers) || !input.allowedUsers.length || !input.allowedUsers.every(id => /^\d+$/.test(String(id)))) throw new Error('Укажите Telegram ID в allowedUsers');
module.exports = {
  oauth: input.oauth,
  saveOAuth(oauth) {
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const temp = file + '.oauth-' + require('node:crypto').randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify({ ...latest, oauth }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  },
  telegram: { botToken: input.botToken },
  allowedUsers: input.allowedUsers.map(String),
  server: { host: '127.0.0.1', port: 3210 },
  database: { path: './data/emoji.sqlite' },
  search: { maxResults: 30 }
};