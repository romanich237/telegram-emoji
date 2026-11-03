const fs = require('node:fs');
const path = require('node:path');

const configPath = path.resolve(process.cwd(), 'config.json');
const examplePath = path.resolve(process.cwd(), 'config.example.json');

if (!fs.existsSync(configPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, configPath);
    console.error('Создан config.json. Заполните telegram.botToken и перезапустите сервер.');
  }
  throw new Error('Отсутствует config.json');
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.telegram?.botToken) {
  throw new Error('Укажите telegram.botToken в config.json');
}
config.server ||= {};
config.server.host ||= '127.0.0.1';
config.server.port = Number(config.server.port || 3210);
config.database ||= {};
config.database.path ||= './data/emoji.sqlite';
config.security ||= {};
config.search ||= {};
config.search.maxResults = Number(config.search.maxResults || 30);
module.exports = config;