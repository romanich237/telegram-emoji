#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите установку: sudo bash install.sh"
  exit 1
fi

for command in node npm git nginx ss; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Не найдена команда $command. Установите Node.js 20+, npm, git, nginx и iproute2."
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Требуется Node.js 20 или новее."
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install --global pm2
fi

if [[ ! -f config.json ]]; then
  read -r -p "Telegram Bot Token: " BOT_TOKEN
  read -r -p "Разрешённые Telegram ID (через запятую): " USER_IDS
  export BOT_TOKEN USER_IDS
  node <<'NODE'
const fs = require('node:fs');
const token = process.env.BOT_TOKEN.trim();
const ids = process.env.USER_IDS.split(',').map(id => id.trim());
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  throw new Error('Некорректный токен бота');
}
if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
  throw new Error('Некорректные Telegram ID');
}
fs.writeFileSync('config.json', JSON.stringify({
  botToken: token,
  allowedUsers: [...new Set(ids.map(Number))]
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
NODE
  unset BOT_TOKEN USER_IDS
else
  echo "Используется существующий config.json"
fi

npm install --omit=dev --no-audit --no-fund
npm run check

# Повторная установка сохраняет выбранный порт.
PORT_FILE="$APP_DIR/data/nginx-port"
mkdir -p "$APP_DIR/data"
if [[ -s "$PORT_FILE" ]]; then
  PORT="$(cat "$PORT_FILE")"
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
    echo "Некорректный сохранённый порт: $PORT"
    exit 1
  fi
else
  PORT=""
  for attempt in $(seq 1 200); do
    candidate="$(node -e 'console.log(require("node:crypto").randomInt(20000, 60000))')"
    if ! ss -H -ltn "( sport = :$candidate )" | grep -q . && ! grep -R -E -q "listen[[:space:]]+([^;]*:)?$candidate([[:space:];]|$)" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then
      PORT="$candidate"
      break
    fi
  done
  if [[ -z "$PORT" ]]; then
    echo "Не удалось подобрать свободный порт Nginx."
    exit 1
  fi
fi

CONF="/etc/nginx/conf.d/telegram-emoji.conf"
BACKUP=""
if [[ -f "$CONF" ]]; then
  BACKUP="$(mktemp)"
  cp "$CONF" "$BACKUP"
fi

cat > "$CONF" <<EOF
server {
    listen $PORT default_server;
    server_name _;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
EOF

if ! nginx -t; then
  if [[ -n "$BACKUP" ]]; then
    cp "$BACKUP" "$CONF"
  else
    rm -f "$CONF"
  fi
  echo "Ошибка конфигурации Nginx. Изменения отменены."
  exit 1
fi
[[ -z "$BACKUP" ]] || rm -f "$BACKUP"

systemctl enable --now nginx
systemctl reload nginx

printf '%s\n' "$PORT" > "$PORT_FILE"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo
echo "Установка завершена."
echo "MCP: http://IP_СЕРВЕРА:$PORT/mcp"
echo "Health: http://IP_СЕРВЕРА:$PORT/health"
echo "Для удалённого доступа настройте HTTPS и откройте порт $PORT в firewall."
echo "Получите ключ MCP через /token в Telegram-боте."
