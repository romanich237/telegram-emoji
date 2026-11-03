#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите установку: sudo bash install.sh"
  exit 1
fi

for command in node npm git nginx ss shuf; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Не найдена команда $command. Нужны Node.js 20+, npm, git, nginx и iproute2."
    exit 1
  }
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
  read -r -p "Токен Telegram-бота: " BOT_TOKEN
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

PORT_FILE="$APP_DIR/data/nginx-port"
CONF="/etc/nginx/conf.d/telegram-emoji.conf"
mkdir -p "$APP_DIR/data"

is_port_free() {
  local port="$1"
  if ss -H -ltn "( sport = :$port )" | grep -q .; then return 1; fi
  if grep -R -E -q "listen[[:space:]]+([^;]*:)?$port([[:space:];]|$)" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then return 1; fi
  return 0
}

PORT=""
if [[ -s "$PORT_FILE" ]]; then
  SAVED_PORT="$(cat "$PORT_FILE")"
  if [[ "$SAVED_PORT" =~ ^[0-9]+$ ]] && is_port_free "$SAVED_PORT"; then PORT="$SAVED_PORT"; fi
fi

if [[ -z "$PORT" ]]; then
  for attempt in $(seq 1 300); do
    CANDIDATE="$(shuf -i 20000-59999 -n 1)"
    if is_port_free "$CANDIDATE"; then PORT="$CANDIDATE"; break; fi
  done
fi
if [[ -z "$PORT" ]]; then echo "Не удалось найти свободный порт Nginx."; exit 1; fi

BACKUP=""
if [[ -f "$CONF" ]]; then BACKUP="$(mktemp)"; cp "$CONF" "$BACKUP"; fi
restore_nginx_config() {
  if [[ -n "$BACKUP" ]]; then cp "$BACKUP" "$CONF"; rm -f "$BACKUP"; else rm -f "$CONF"; fi
}

cat > "$CONF" <<EOF
server {
    listen $PORT;
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
  restore_nginx_config
  echo "Nginx отклонил конфигурацию. Предыдущая конфигурация восстановлена."
  exit 1
fi
rm -f "$BACKUP"
systemctl enable --now nginx
systemctl reload nginx
printf '%s\n' "$PORT" > "$PORT_FILE"
chmod 600 "$PORT_FILE"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

SERVER_IP="$(hostname -I | awk '{print $1}')"
echo
echo "Установка завершена."
echo "MCP:    http://$SERVER_IP:$PORT/mcp"
echo "Health: http://$SERVER_IP:$PORT/health"
echo
echo "Откройте порт $PORT в firewall и настройте HTTPS для внешнего доступа."
echo "Получите временный MCP-ключ командой /token в Telegram."
