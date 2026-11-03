const config = require('./config');
const { createDatabase } = require('./database');
const { TelegramClient } = require('./telegram');
const { createApp } = require('./server');
const { setupAuth } = require('./auth');
const { createDomainSetup } = require('./domain');
const { startBot } = require('./bot');

const db = createDatabase(config.database.path);
const telegram = new TelegramClient(config.telegram.botToken);
const auth = setupAuth(db,config.allowedUsers);
const app = createApp({ db, telegram, config, auth });
const domainSetup = createDomainSetup(db, config.server.port);
const stopBot = startBot({ telegram, db, auth, domainSetup });

const server = app.listen(config.server.port,config.server.host,() => {
  console.log('Telegram Emoji MCP: http://' + config.server.host + ':' + config.server.port + '/mcp');
});
function shutdown() {
  stopBot();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1),10000).unref();
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);