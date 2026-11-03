const config = require('./config');
const { createDatabase } = require('./database');
const { TelegramClient } = require('./telegram');
const { createApp } = require('./server');

const db = createDatabase(config.database.path);
const telegram = new TelegramClient(config.telegram.botToken);
const app = createApp({ db, telegram, config });

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`Telegram Emoji MCP listening on http://${config.server.host}:${config.server.port}`);
  console.log(`MCP endpoint: http://${config.server.host}:${config.server.port}/mcp`);
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));