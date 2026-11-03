const { searchEmojis } = require('./search');

function startBot({ telegram, db, auth, onError = console.error }) {
  let running = true;
  let offset = 0;
  const selected = new Map();
  const send = (chatId, text) => telegram.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });

  async function handle(message) {
    if (!message?.from || message.chat?.type !== 'private') return;
    const id = String(message.from.id);
    const chatId = message.chat.id;
    if (!auth.isAllowed(id)) {
      await send(chatId, 'Доступ закрыт. Ваш Telegram ID: ' + id);
      return;
    }
    const input = String(message.text || '').trim();
    if (!input) return;
    if (input === '/start' || input === '/help') {
      await send(chatId, 'Telegram Emoji MCP\n\n/add https://t.me/addemoji/PackName — добавить набор\n/packs — список наборов\n/use PackName — выбрать набор\n/find сердце — поиск внутри выбранного набора\n/token — получить временный ключ MCP (24 часа)\n/revoke — отозвать ключ');
      return;
    }
    if (input === '/token') {
      const { token } = auth.issue(id);
      await send(chatId, 'Ключ MCP на 24 часа:\n' + token + '\n\nПередавайте его как Authorization: Bearer <ключ>. Не пересылайте другим.');
      return;
    }
    if (input === '/revoke') {
      auth.revoke(id);
      await send(chatId, 'Ключи доступа отозваны.');
      return;
    }
    if (input === '/packs') {
      const packs = db.prepare('SELECT title,short_name,total_count FROM packs ORDER BY title').all();
      await send(chatId, packs.length ? packs.map(p => p.title + ' (' + p.short_name + '): ' + p.total_count).join('\n') : 'Наборов пока нет.');
      return;
    }
    if (input.startsWith('/add ')) {
      const name = input.slice(5).trim().replace(/^https?:\/\/(www\.)?t\.me\/addemoji\//i, '').split(/[?#/]/)[0];
      if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('Некорректная ссылка на набор');
      const set = await telegram.getStickerSet(name);
      if (set.sticker_type !== 'custom_emoji') throw new Error('Это не набор Custom Emoji');
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO packs(short_name,title,pack_type,total_count,synced_at)
          VALUES(?,?,?,?,?) ON CONFLICT(short_name) DO UPDATE SET title=excluded.title,total_count=excluded.total_count,synced_at=excluded.synced_at`)
          .run(name,set.title,'custom_emoji',set.stickers.length,new Date().toISOString());
        const pack = db.prepare('SELECT id FROM packs WHERE short_name=?').get(name);
        db.prepare('DELETE FROM emojis WHERE pack_id=?').run(pack.id);
        const insert = db.prepare(`INSERT INTO emojis(pack_id,custom_emoji_id,file_id,file_unique_id,emoji,description,is_animated,is_video,width,height)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const item of set.stickers) {
          if (!item.custom_emoji_id) continue;
          insert.run(pack.id,item.custom_emoji_id,item.file_id,item.file_unique_id || '',item.emoji || '', '',Number(!!item.is_animated),Number(!!item.is_video),item.width || null,item.height || null);
        }
      });
      tx();
      selected.set(id,name);
      await send(chatId,'Добавлен набор: ' + set.title + '\nЭмодзи: ' + set.stickers.length + '\nИспользуйте /find запрос');
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
      if (!pack) throw new Error('Набор больше не существует');
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