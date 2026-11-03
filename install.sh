#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите установку: sudo bash install.sh"
  exit 1
fi

for command in node npm git nginx; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Не найдена команда $command. Нужны Node.js 20+, npm, git, и nginx."
    exit 1
  }
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Требуется Node.js 20 или новее."
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update
  apt-get install -y certbot
fi

systemctl enable --now certbot.timer

if ! command -v pm2 >/dev/null 2>&1; then
  npm install --global pm2
fi

if [[ ! -f config.json ]]; then
  read -r -s -p "Токен Telegram-бота: " BOT_TOKEN
  echo
  read -r -p "Разрешённые Telegram ID (через запятую): " USER_IDS
  export BOT_TOKEN USER_IDS
  node <<'NODE'
const fs = require('node:fs');
const token = (process.env.BOT_TOKEN || '').trim();
const ids = (process.env.USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Некорректный токен Telegram-бота.');
if (!ids.length || ids.some(id => !/^\d+$/.test(id))) throw new Error('Укажите корректные Telegram ID.');
fs.writeFileSync('config.json', JSON.stringify({ botToken: token, allowedUsers: [...new Set(ids.map(Number))] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
  unset BOT_TOKEN USER_IDS
else
  echo "Найдена существующая конфигурация — сохраняем её."
fi

npm install --omit=dev --no-audit --no-fund
npm run check

# Remove the legacy public HTTP proxy. The bot provisions the HTTPS vhost.
systemctl enable --now nginx
CONF="/etc/nginx/conf.d/telegram-emoji.conf"
if [[ -f "$CONF" ]]; then
  mv "$CONF" "$CONF.disabled"
  if ! nginx -t || ! systemctl reload nginx; then
    mv "$CONF.disabled" "$CONF"
    exit 1
  fi
fi
pm2 delete telegram-emoji-updater >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "Откройте личный чат с ботом и отправьте /start. Для настройки домена откройте порты 80 и 443."
