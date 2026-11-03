# Telegram Emoji MCP

**Поиск кастомных эмодзи внутри конкретных Telegram-паков.**

Node.js · Telegram Bot API · MCP · SQLite · PM2

## Возможности

- Добавление публичных паков по ссылке `t.me/addemoji/...`.
- Поиск внутри выбранного набора по базовому символу и сохранённым описаниям.
- Получение `custom_emoji_id`, просмотр и удаление наборов.
- Доступ только для Telegram ID из списка разрешённых.
- Временные ключи MCP выдаются ботом через `/token` на 24 часа; `/revoke` отзывает их.
- Автообновление из публичной ветки `main` через PM2.

## Установка

Требуется Node.js 20+, npm, git и PM2. Подходит для Ubuntu 22.04+ / Debian 12+.

```bash
git clone https://github.com/romanich237/telegram-emoji.git
cd telegram-emoji
npm install
npm install -g pm2
cp config.example.json config.json
```

Заполните **только два параметра** в `config.json`:

```json
{
  "botToken": "123456:YOUR_BOT_TOKEN",
  "allowedUsers": [123456789, 987654321]
}
```

Токен выдаёт [@BotFather](https://t.me/BotFather). В `allowedUsers` указываются числовые Telegram ID. Никогда не публикуйте токен.

```bash
npm run check
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

## Команды Telegram-бота

| Команда | Назначение |
|---|---|
| `/start`, `/help` | Справка |
| `/add https://t.me/addemoji/PackName` | Добавить набор |
| `/packs` | Список наборов |
| `/use PackName` | Выбрать набор |
| `/find сердце` | Поиск внутри набора |
| `/token` | Ключ MCP на 24 часа |
| `/revoke` | Отозвать ключи |

Бот принимает команды только в личных сообщениях от разрешённых пользователей.

## MCP

Endpoint: `http://127.0.0.1:3210/mcp`. Получите временный ключ командой `/token` и передайте его в заголовке `Authorization: Bearer <ключ>`.

Инструменты: `add_emoji_pack`, `list_emoji_packs`, `list_pack_emojis`, `search_pack_emojis`, `annotate_emoji`, `remove_emoji_pack`.

Для удалённого подключения используйте **HTTPS через reverse proxy**. Прямой HTTP без TLS не публикуйте.

## Автообновление

`telegram-emoji-updater` раз в минуту проверяет `origin/main`. При наличии fast-forward обновления и отсутствии локальных изменений выполняет `git merge --ff-only`, установку зависимостей и `pm2 restart telegram-emoji`.

```bash
pm2 logs telegram-emoji
pm2 logs telegram-emoji-updater
```

Автообновление исполняет код из `main` на сервере. Ограничьте права записи в репозиторий.

## Ограничения

Bot API не возвращает смысловые описания кастомных эмодзи. Поиск словами возможен по сохранённым описаниям; визуальный ИИ-поиск пока не реализован.

SQLite хранится локально. `config.json` исключён из Git.
