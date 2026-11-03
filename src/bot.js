const { parseDomain } = require('./domain');
const { searchEmojis } = require('./search');

function startBot({ telegram, db, auth, domainSetup, onError = console.error }) {
  let running = true;
  let offset = 0;
  const selected = new Map();
  const pending = new Map();
  const hasEmojis = db.prepare('SELECT 1 FROM emojis LIMIT 1');
  function menu(id) {
    const keyboard = [];
    if (!domainSetup.current()) keyboard.push(['Настроить домен']);
    keyboard.push(['Добавить набор', 'Наборы']);
    if (hasEmojis.get()) keyboard.push(['Поиск']);
    if (domainSetup.current()) keyboard.push(['Подключение MCP', 'Настроить домен']);
    keyboard.push(pending.has(id) ? ['Отмена', 'Отозвать ключ'] : ['Отозвать ключ']);
    return { keyboard, resize_keyboard: true, is_persistent: true };
  }
  const send = (chatId, text, options = {}) => telegram.call('sendMessage', {
    chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...options
  });
  const aliases = new Map([
    ['Наборы', '/packs'], ['Подключение MCP', '/token'], ['Настроить домен', '/domain'],
    ['Отозвать ключ', '/revoke'], ['Отмена', '/cancel']
  ]);

  async function askDomain(chatId, id) {
    pending.set(id, 'domain');
    await send(chatId, 'Введи домен, например emoji.example.com. Его A-запись должна вести на публичный IPv4 сервера. Для выпуска сертификата открой входящие порты 80 и 443.\n\n/cancel — отмена', { reply_markup: menu(id) });
  }

  async function handle(message) {
    if (!message?.from || message.chat?.type !== 'private') return;
    const id = String(message.from.id);
    const chatId = message.chat.id;
    if (!auth.isAllowed(id)) {
      await send(chatId, 'Доступ закрыт. Ваш Telegram ID: ' + id);
      return;
    }
    const text = String(message.text || '').trim();
    let input = aliases.get(text) || text;
    if (!input) return;
    if (input === '/cancel') {
      pending.delete(id);
      await send(chatId, 'Ввод отменён.', { reply_markup: menu(id) });
      return;
    }
    if (input === '/start' || input === '/help') {
      pending.delete(id);
      const domain = domainSetup.current();
      if (!domain) {
        await send(chatId, 'Telegram Emoji MCP. Начнём с настройки HTTPS.');
        await askDomain(chatId, id);
      } else {
        await send(chatId, 'Telegram Emoji MCP\nhttps://' + domain + '/mcp\n\nДобавляй наборы и подбирай эмодзи для своих проектов.', { reply_markup: menu(id) });
      }
      return;
    }
    if (input === '/domain') {
      await askDomain(chatId, id);
      return;
    }
    const isSearch = input === 'Поиск' || /^\/(?:search|find)(?:\s|$)/.test(input)
      || (!input.startsWith('/') && pending.get(id) === 'search' && input !== 'Добавить набор');
    if (isSearch && !hasEmojis.get()) {
      pending.set(id, 'pack');
      await send(chatId, 'Сначала добавь набор. Пришли ссылку t.me/addemoji/…', { reply_markup: menu(id) });
      return;
    }
    if (input === 'Поиск' || input === 'Добавить набор' || input === '/add' || input === '/search') {
      pending.set(id, isSearch ? 'search' : 'pack');
      await send(chatId, isSearch ? 'Введи эмодзи или слово для поиска по каталогу.' : 'Пришли ссылку на набор t.me/addemoji/…', { reply_markup: menu(id) });
      return;
    }
    if (!input.startsWith('/')) {
      const action = pending.get(id);
      if (action === 'domain') {
        const domain = parseDomain(input);
        pending.delete(id);
        await send(chatId, 'Проверяю DNS и настраиваю HTTPS. Это может занять несколько минут.');
        domainSetup.setup(domain).then(
          () => send(chatId, 'MCP готов: https://' + domain + '/mcp', { reply_markup: menu(id) }),
          error => {
            if (!pending.has(id)) pending.set(id, 'domain');
            onError(error);
            return send(chatId, error.code ? 'Не удалось завершить настройку. Проверь журнал PM2 и повтори попытку.' : error.message, { reply_markup: menu(id) });
          }
        ).catch(onError);
        return;
      }
      if (action === 'pack') input = '/add ' + input;
      if (action === 'search') input = '/search ' + input;
    }
    if (input.startsWith('/search ')) {
      if (pending.get(id) === 'search') pending.delete(id);
      const rows = db.prepare(`SELECT e.custom_emoji_id, e.emoji,
        e.description || ' ' || p.title || ' ' || p.short_name AS description
        FROM emojis e JOIN packs p ON p.id=e.pack_id ORDER BY e.id`).all();
      const results = searchEmojis(rows, input.slice(8), 15);
      await send(chatId, results.length ? results.map(item =>
        (item.emoji || 'Эмодзи') + ' · ' + item.custom_emoji_id).join('\n') : 'Совпадений нет. Попробуй другой символ или запрос.', { reply_markup: menu(id) });
      return;
    }
    if (input === '/token') {
      const domain = domainSetup.current();
      if (!domain) return askDomain(chatId, id);
      pending.delete(id);
      const { token } = auth.issue(id);
      await send(chatId, ('https://' + domain + '/mcp\n\n') + 'Ключ MCP на 24 часа:\n' + token + '\n\nПередавайте его как Authorization: Bearer <ключ>. Не пересылайте другим.');
      return;
    }
    if (input === '/revoke') {
      auth.revoke(id);
      await send(chatId, 'Ключи доступа отозваны.');
      return;
    }
    if (input === '/packs') {
      pending.delete(id);
      const packs = db.prepare('SELECT title,short_name,total_count FROM packs ORDER BY title').all();
      await send(chatId, packs.length ? packs.slice(0, 20).map(p => p.title.slice(0, 90) + ' (' + p.short_name + '): ' + p.total_count).join('\n') : 'Наборов пока нет. Нажми «Добавить набор».', { reply_markup: menu(id) });
      return;
    }
    if (input.startsWith('/add ')) {
      const name = input.slice(5).trim().replace(/^https?:\/\/(www\.)?t\.me\/addemoji\//i, '').split(/[?#/]/)[0];
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('Некорректная ссылка на набор');
      const set = await telegram.getStickerSet(name);
      if (set.sticker_type !== 'custom_emoji') throw new Error('Это не набор Custom Emoji');
      if (!set.stickers.some(item => item.custom_emoji_id)) throw new Error('В наборе нет кастомных эмодзи');
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO packs(short_name,title,pack_type,total_count,synced_at)
          VALUES(?,?,?,?,?) ON CONFLICT(short_name) DO UPDATE SET title=excluded.title,total_count=excluded.total_count,synced_at=excluded.synced_at`)
          .run(name,set.title,'custom_emoji',set.stickers.length,new Date().toISOString());
        const pack = db.prepare('SELECT id FROM packs WHERE short_name=?').get(name);
        const descriptions = new Map(db.prepare('SELECT custom_emoji_id, description FROM emojis WHERE pack_id=?')
          .all(pack.id).map(item => [item.custom_emoji_id, item.description]));
        db.prepare('DELETE FROM emojis WHERE pack_id=?').run(pack.id);
        const insert = db.prepare(`INSERT INTO emojis(pack_id,custom_emoji_id,file_id,file_unique_id,emoji,description,is_animated,is_video,width,height)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const item of set.stickers) {
          if (!item.custom_emoji_id) continue;
          insert.run(pack.id,item.custom_emoji_id,item.file_id,item.file_unique_id || '',item.emoji || '', descriptions.get(item.custom_emoji_id) || '',Number(!!item.is_animated),Number(!!item.is_video),item.width || null,item.height || null);
        }
      });
      tx();
      pending.delete(id);
      selected.set(id,name);
      await send(chatId,'Добавлен набор: ' + set.title + '\nЭмодзи: ' + set.stickers.length + '\nНажми «Поиск», чтобы найти эмодзи.', { reply_markup: menu(id) });
      return;
    }
    if (input.startsWith('/use ')) {
      const name = input.slice(5).trim();
      const pack = db.prepare('SELECT short_name,title FROM packs WHERE short_name=? OR title=?').get(name,name);
      if (!pack) throw new Error('Набор не найден');
      selected.set(id,pack.short_name);
      await send(chatId,'Выбран набор: ' + pack.title);
      return;
    }
    if (input.startsWith('/find ')) {
      const name = selected.get(id);
      if (!name) throw new Error('Сначала выберите набор: /use PackName');
      const pack = db.prepare('SELECT id,title FROM packs WHERE short_name=?').get(name);
      if (!pack) {
        selected.delete(id);
        return send(chatId, 'Выбранный набор удалён. Выбери другой через /use или нажми «Поиск».', { reply_markup: menu(id) });
      }
      const rows = db.prepare('SELECT custom_emoji_id,emoji,description FROM emojis WHERE pack_id=?').all(pack.id);
      const results = searchEmojis(rows,input.slice(6),20);
      await send(chatId,results.length ? results.map(e => (e.emoji || 'Эмодзи') + ' — ' + e.custom_emoji_id).join('\n') : 'Совпадений нет. Поиск по смыслу требует описаний эмодзи.');
      return;
    }
    await send(chatId,'Неизвестная команда. Используйте /help');
  }

  async function poll() {
    while (running) {
      try {
        const updates = await telegram.call('getUpdates',{ offset, timeout: 25, allowed_updates: ['message'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          try { await handle(update.message); }
          catch (error) {
            onError(error);
            if (update.message?.chat?.id) await send(update.message.chat.id,'Ошибка: ' + error.message).catch(onError);
          }
        }
      } catch (error) {
        if (running) {
          onError(error);
          await new Promise(resolve => setTimeout(resolve,3000));
        }
      }
    }
  }
  poll().catch(onError);
  return () => { running = false; };
}
module.exports = { startBot };