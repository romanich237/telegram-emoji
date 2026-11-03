# Telegram Emoji MCP

MCP-сервер для поиска Telegram Premium Custom Emoji внутри выбранных наборов.

## Требования
- Node.js 20+
- Telegram Bot Token от @BotFather

## Запуск

```bash
npm install
cp config.example.json config.json
# заполнить botToken в config.json
npm start
```

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Подробная документация появится вместе с реализацией модулей.
