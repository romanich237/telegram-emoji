const { randomBytes } = require('node:crypto');
const { createEmojiKeyboard } = require('./emoji');
const { parseDomain } = require('./domain');
const { searchEmojis } = require('./search');

function startBot({ telegram, db, auth, domainSetup, oauth, saveOAuth, restart, onError = console.error }) {
  let running = true;
  const commands = [
    { command: 'start', description: 'Главное меню' },
    { command: 'help', description: 'Помощь по боту' },
    { command: 'packs', description: 'Список наборов эмодзи' },
    { command: 'add', description: 'Добавить набор эмодзи' },
    { command: 'search', description: 'Поиск по всем наборам' },
    { command: 'use', description: 'Выбрать наборы по номерам' },
    { command: 'find', description: 'Поиск в выбранных наборах' },
    { command: 'mcp', description: 'Настройки MCP' },
    { command: 'token', description: 'Получить ключ MCP' },
    { command: 'cancel', description: 'Отменить текущее действие' }
  ];
  telegram.call('setMyCommands', { commands }).catch(error => {
    onError(new Error('Не удалось зарегистрировать команды бота: ' + error.message));
  });
  let offset = 0;
  const selected = new Map();
  const pending = new Map();
  const hasEmojis = db.prepare('SELECT 1 FROM emojis LIMIT 1');
  const decorateKeyboard = createEmojiKeyboard(db);
  const confirmation = new Map();
  const issuer = () => domainSetup.current() ? 'https://' + domainSetup.current() : oauth?.issuer;
  function menu(id) {
    let keyboard;
    switch (pending.get(id)) {
      case 'revoke-first': keyboard = [['Продолжить отзыв'], ['Отмена']]; break;
      case 'revoke-final': keyboard = [['Да, отозвать ключ'], ['Отмена']]; break;
      case 'mcp': keyboard = [['Настроить домен', 'Настроить ChatGPT'], ['Получить ключ', 'Отозвать ключ'], ['Сменить секрет OAuth', 'В меню']]; break;
      case 'callback-rotate':
      case 'callback':
      case 'domain': keyboard = [['Отмена']]; break;
      default:
        keyboard = [['Добавить набор', 'Наборы'], ['Настройки MCP']];
        if (hasEmojis.get()) keyboard[1].unshift('Поиск');
        if (pending.has(id)) keyboard.push(['Отмена']);
    }
    return { keyboard: decorateKeyboard(keyboard), resize_keyboard: true, is_persistent: true };
  }
  const send = (chatId, text, options = {}) => telegram.call('sendMessage', {
    chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...options
  });
  const aliases = new Map([
    ['Наборы', '/packs'], ['Подключение MCP', '/mcp'], ['Настройки MCP', '/mcp'], ['Получить ключ', '/token'], ['Настроить ChatGPT', '/oauth'], ['Сменить секрет OAuth', '/oauth_rotate'], ['В меню', '/start'], ['Настроить домен', '/domain'],
    ['Отозвать ключ', '/revoke'], ['Отмена', '/cancel']
  ]);

  const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const packLink = pack => '<a href="https://t.me/addemoji/' + encodeURIComponent(pack.short_name) + '">' +
    escapeHtml(pack.title.slice(0, 90)) + '</a>';

  async function sendResults(chatId, id, results, emptyMessage) {
    if (!results.length) return send(chatId, emptyMessage, { reply_markup: menu(id) });
    const rows = results.map(item => {
      const emoji = escapeHtml(item.emoji || '🙂');
      const tag = '<tg-emoji emoji-id="' + escapeHtml(item.custom_emoji_id) + '">' + emoji + '</tg-emoji>';
      return { emoji, tag, pack: '№' + item.pack_id + ' ' + packLink(item), code: '<code>' + escapeHtml(tag) + '</code>' };
    });
    const options = { parse_mode: 'HTML', reply_markup: menu(id) };
    try {
      return await send(chatId, rows.map(row => row.tag + ' - ' + row.code + ' · ' + row.pack).join('\n'), options);
    } catch (error) {
      if (!/custom.?emoji|parse entities/i.test(error.message)) throw error;
      return send(chatId, rows.map(row => row.emoji + ' - ' + row.code + ' · ' + row.pack).join('\n'), options);
    }
  }

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
      confirmation.delete(id);
      pending.delete(id);
      await send(chatId, 'Действие отменено.', { reply_markup: menu(id) });
      return;
    }
    if (input === '/mcp') {
      pending.set(id, 'mcp');
      const address = issuer();
      const status = oauth && oauth.issuer === address ? 'OAuth настроен' : 'OAuth ждёт настройки';
      await send(chatId, '⚙️ Настройки MCP\n\n' + (address ? address + '/mcp\n' + status : 'Сначала настрой домен и HTTPS.') +
        '\n\n«Настроить ChatGPT» покажет данные клиента и позволит изменить адрес обратного вызова.', { reply_markup: menu(id) });
      return;
    }
    if (input === '/oauth' || input === '/oauth_rotate') {
      if (!issuer()) return askDomain(chatId, id);
      pending.set(id, input === '/oauth_rotate' ? 'callback-rotate' : 'callback');
      const current = oauth && oauth.issuer === issuer() ?
        '\n\nТекущий callback: ' + oauth.redirectUri + '\nID клиента: ' + oauth.clientId +
        '\nСекрет клиента: ' + oauth.clientSecret : '';
      await send(chatId, 'Подключение ChatGPT\n\nПришли URL обратного вызова из настроек коннектора ChatGPT.' + current,
        { protect_content: true, reply_markup: menu(id) });
      return;
    }
    if (input === '/start' || input === '/help') {
      pending.delete(id);
      const domain = issuer();
      if (!domain) {
        await send(chatId, 'Telegram Emoji MCP. Начнём с настройки HTTPS.');
        await askDomain(chatId, id);
      } else {
        await send(chatId, 'Telegram Emoji MCP\n' + domain + '/mcp\n\nДобавляй наборы и подбирай эмодзи для своих проектов.', { reply_markup: menu(id) });
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
      if (action === 'callback' || action === 'callback-rotate') {
        if (!/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(input)) {
          return send(chatId, 'Пришли полный URL обратного вызова из ChatGPT.', { reply_markup: menu(id) });
        }
        const settings = { issuer: issuer(), redirectUri: input, clientId: oauth?.clientId || 'chatgpt',
          clientSecret: action === 'callback' && oauth?.clientSecret ? oauth.clientSecret : randomBytes(32).toString('base64url') };
        if (process.env.pm_id === undefined) return send(chatId, 'Для применения настроек запусти сервис через PM2.');
        saveOAuth(settings);
        pending.set(id, 'mcp');
        try {
          await send(chatId, 'OAuth сохранён. Сервис перезапускается.\n\nURL MCP: ' + settings.issuer + '/mcp' +
            '\nID клиента: ' + settings.clientId + '\nСекрет клиента: ' + settings.clientSecret +
            '\nМетод: client_secret_post\nОбласть: emoji\nPKCE: S256', { protect_content: true, reply_markup: menu(id) });
        } finally {
          restart();
        }
        return;
      }
      if (action === 'domain') {
        const domain = parseDomain(input);
        pending.delete(id);
        await send(chatId, 'Проверяю DNS и настраиваю HTTPS. Это может занять несколько минут.');
        domainSetup.setup(domain).then(
          () => {
            if (!pending.has(id)) pending.set(id, 'mcp');
            return send(chatId, 'MCP готов: https://' + domain + '/mcp', { reply_markup: menu(id) });
          },
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
      const rows = db.prepare(`SELECT e.custom_emoji_id, e.emoji, p.id AS pack_id, p.title, p.short_name,
        e.description || ' ' || p.title || ' ' || p.short_name AS description
        FROM emojis e JOIN packs p ON p.id=e.pack_id ORDER BY e.id`).all();
      const results = searchEmojis(rows, input.slice(8), 15);
      await sendResults(chatId, id, results, 'Совпадений нет. Попробуй другой символ или запрос.');
      return;
    }
    if (input === '/token') {
      const domain = issuer();
      if (!domain) return askDomain(chatId, id);
      pending.set(id, 'mcp');
      const { token } = auth.issue(id);
      await send(chatId, (domain + '/mcp\n\n') + 'Бессрочный ключ MCP:\n' + token + '\n\nПередавайте его как Authorization: Bearer <ключ>. Не пересылайте другим.', { protect_content: true, reply_markup: menu(id) });
      return;
    }
    if (input === '/revoke') {
      pending.set(id, 'revoke-first');
      confirmation.set(id, Date.now() + 120000);
      return send(chatId, '1 из 2. Отозвать MCP-ключ? Подключённые клиенты потеряют доступ.', { reply_markup: menu(id) });
    }
    if (input === 'Продолжить отзыв' || input === 'Да, отозвать ключ') {
      const first = input === 'Продолжить отзыв';
      if (pending.get(id) !== (first ? 'revoke-first' : 'revoke-final') || !(confirmation.get(id) > Date.now())) {
        if (pending.get(id)?.startsWith('revoke-')) pending.set(id, 'mcp');
        return send(chatId, 'Подтверждение недействительно. Начни отзыв заново.', { reply_markup: menu(id) });
      }
      if (first) {
        pending.set(id, 'revoke-final');
        return send(chatId, '2 из 2. Точно отозвать ключ и отключить связанные подключения ChatGPT?', { reply_markup: menu(id) });
      }
      auth.revoke(id);
      confirmation.delete(id);
      pending.set(id, 'mcp');
      return send(chatId, 'Ключ отозван.', { reply_markup: menu(id) });
    }
    if (input === '/packs') {
      pending.delete(id);
      const packs = db.prepare('SELECT id,title,short_name,total_count FROM packs ORDER BY id').all();
      if (!packs.length) return send(chatId, 'Наборов пока нет. Нажми «Добавить набор».', { reply_markup: menu(id) });
      for (let offset = 0; offset < packs.length; offset += 20) {
        const lines = packs.slice(offset, offset + 20).map(pack =>
          '№' + pack.id + ' ' + packLink({ ...pack, title: pack.title.slice(0, 90) }) + ' (' + pack.total_count + ')');
        await send(chatId, lines.join('\n') + '\n\nВыбор набора: /use 1 2 (укажи номера нужных наборов).',
          { parse_mode: 'HTML', reply_markup: menu(id) });
      }
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
      selected.set(id, [name]);
      await send(chatId,'Добавлен набор: ' + set.title + '\nЭмодзи: ' + set.stickers.length + '\nНажми «Поиск», чтобы найти эмодзи.', { reply_markup: menu(id) });
      return;
    }
    if (input.startsWith('/use ')) {
      const name = input.slice(5).trim();
      const numbers = /^№?[1-9]\d*(?:[\s,]+№?[1-9]\d*)*$/.test(name)
        ? [...new Set(name.match(/\d+/g))] : null;
      if (numbers && numbers.length > 20) throw new Error('Выбери до 20 наборов.');
      const packs = numbers
        ? numbers.map(number => db.prepare('SELECT id,short_name,title FROM packs WHERE id=?').get(number))
        : [db.prepare('SELECT id,short_name,title FROM packs WHERE short_name=? OR title=?').get(name, name)];
      const missing = packs.findIndex(pack => !pack);
      if (missing !== -1) throw new Error(numbers ? 'Набор №' + numbers[missing] + ' не найден' : 'Набор не найден');
      selected.set(id, packs.map(pack => pack.short_name));
      await send(chatId, 'Выбранные наборы\n' + packs.map(pack => '№' + pack.id + ' ' + packLink(pack)).join('\n') +
        '\n\nОтправь /find и запрос.', { parse_mode: 'HTML', reply_markup: menu(id) });
      return;
    }
    if (input.startsWith('/find ')) {
      const names = selected.get(id);
      if (!names) throw new Error('Сначала выбери наборы, например /use 1 2');
      const rows = db.prepare(`SELECT e.custom_emoji_id, e.emoji, e.description, p.id AS pack_id, p.title, p.short_name
        FROM emojis e JOIN packs p ON p.id=e.pack_id
        WHERE p.short_name IN (${names.map(() => '?').join(',')}) ORDER BY e.id`).all(...names);
      const results = searchEmojis(rows, input.slice(6), 20);
      await sendResults(chatId, id, results, 'Совпадений нет. Поиск по смыслу требует описаний эмодзи.');
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