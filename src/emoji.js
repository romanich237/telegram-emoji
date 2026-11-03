const symbols = {
  'Поиск': '🔍', 'Наборы': '📦', 'Добавить набор': '➕',
  'Настройки MCP': '⚙️', 'Настроить домен': '🌐', 'Настроить ChatGPT': '🤖',
  'Получить ключ': '🔑', 'Отозвать ключ': '🔒', 'Сменить секрет OAuth': '🔐',
  'Продолжить отзыв': '⚠️', 'Да, отозвать ключ': '🔒', 'Отмена': '❌', 'В меню': '🏠'
};

function createEmojiKeyboard(db) {
  const lookup = db.prepare(`SELECT custom_emoji_id FROM emojis
    WHERE pack_id IN (1, 2) AND replace(emoji, char(65039), '') = ?
    ORDER BY pack_id, id LIMIT 1`);
  return keyboard => keyboard.map(row => row.map(text => {
    const symbol = symbols[text];
    const icon = symbol && lookup.get(symbol.replace(/\uFE0F/g, ''));
    return icon ? { text, icon_custom_emoji_id: icon.custom_emoji_id } : text;
  }));
}

module.exports = { createEmojiKeyboard };
