const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { searchEmojis } = require('./search');

function makeMcpServer({ db, telegram, config }) {
  const server = new McpServer({ name: 'telegram-emoji', version: '1.0.0' });

  server.tool(
    'add_emoji_pack',
    'Добавляет публичный Telegram Custom Emoji Pack по ссылке t.me/addemoji/... или short name и индексирует его содержимое.',
    { pack: z.string().min(1).describe('Ссылка https://t.me/addemoji/PackName или short name набора') },
    async ({ pack }) => {
      const shortName = pack.trim().replace(/^https?:\/\/(www\.)?t\.me\/addemoji\//i, '').replace(/^\//, '').split(/[?#/]/)[0];
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(shortName)) throw new Error('Некорректная ссылка или short name набора');
      const set = await telegram.getStickerSet(shortName);
      if (set.sticker_type && set.sticker_type !== 'custom_emoji') {
        throw new Error('Ссылка ведёт не на набор Custom Emoji');
      }
      const stickers = set.stickers || [];
      const syncedAt = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`INSERT INTO packs(short_name,title,pack_type,total_count,synced_at)
          VALUES(?,?,?,?,?) ON CONFLICT(short_name) DO UPDATE SET
          title=excluded.title, pack_type=excluded.pack_type,
          total_count=excluded.total_count, synced_at=excluded.synced_at`)
          .run(shortName, set.title || shortName, set.sticker_type || 'custom_emoji', stickers.length, syncedAt);
        const packRow = db.prepare('SELECT id FROM packs WHERE short_name=?').get(shortName);
        db.prepare('DELETE FROM emojis WHERE pack_id=?').run(packRow.id);
        const insert = db.prepare(`INSERT INTO emojis
          (pack_id,custom_emoji_id,file_id,file_unique_id,emoji,description,is_animated,is_video,width,height)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        for (const item of stickers) {
          if (!item.custom_emoji_id) continue;
          insert.run(packRow.id, item.custom_emoji_id, item.file_id, item.file_unique_id || '',
            item.emoji || '', '', item.is_animated ? 1 : 0, item.is_video ? 1 : 0,
            item.width || null, item.height || null);
        }
      });
      tx();
      return { content: [{ type: 'text', text: JSON.stringify({
        success: true, title: set.title, short_name: shortName,
        total: stickers.length, indexed: stickers.filter(x => x.custom_emoji_id).length,
        synced_at: syncedAt
      }, null, 2) }] };
    }
  );

  server.tool(
    'list_emoji_packs',
    'Показывает все наборы эмодзи, которые сохранены в локальном каталоге.',
    {},
    async () => {
      const packs = db.prepare(`SELECT p.*, COUNT(e.id) AS indexed_count
        FROM packs p LEFT JOIN emojis e ON e.pack_id=p.id
        GROUP BY p.id ORDER BY p.title COLLATE NOCASE`).all();
      return { content: [{ type: 'text', text: JSON.stringify(packs, null, 2) }] };
    }
  );

  server.tool(
    'list_pack_emojis',
    'Возвращает эмодзи из конкретного ранее добавленного набора, включая fallback символ и custom_emoji_id.',
    { pack: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
    async ({ pack, limit }) => {
      const row = db.prepare('SELECT * FROM packs WHERE short_name=? OR title=?').get(pack, pack);
      if (!row) throw new Error('Набор не найден. Сначала вызовите add_emoji_pack.');
      const items = db.prepare('SELECT custom_emoji_id,emoji,description,is_animated,is_video,width,height FROM emojis WHERE pack_id=? ORDER BY id LIMIT ?')
        .all(row.id, limit || 100);
      return { content: [{ type: 'text', text: JSON.stringify({ pack: row.title, short_name: row.short_name, total: row.total_count, items }, null, 2) }] };
    }
  );

  server.tool(
    'search_pack_emojis',
    'Ищет эмодзи только внутри указанного набора. Поддерживает поиск по fallback-символу и описаниям, добавленным через annotate_emoji.',
    { pack: z.string().min(1), query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    async ({ pack, query, limit }) => {
      const row = db.prepare('SELECT * FROM packs WHERE short_name=? OR title=?').get(pack, pack);
      if (!row) throw new Error('Набор не найден. Сначала вызовите add_emoji_pack.');
      const items = db.prepare('SELECT custom_emoji_id,emoji,description,is_animated,is_video,width,height FROM emojis WHERE pack_id=?').all(row.id);
      const results = searchEmojis(items, query, Math.min(limit || config.search.maxResults, 100));
      return { content: [{ type: 'text', text: JSON.stringify({
        pack: row.title, query, count: results.length, results
      }, null, 2) }] };
    }
  );

  server.tool(
    'annotate_emoji',
    'Сохраняет текстовое описание для эмодзи, чтобы затем находить его по смыслу внутри набора.',
    { pack: z.string().min(1), custom_emoji_id: z.string().min(1), description: z.string().min(1).max(500) },
    async ({ pack, custom_emoji_id, description }) => {
      const result = db.prepare(`UPDATE emojis SET description=? WHERE custom_emoji_id=?
        AND pack_id=(SELECT id FROM packs WHERE short_name=? OR title=?)`)
        .run(description.trim(), custom_emoji_id, pack, pack);
      if (!result.changes) throw new Error('Эмодзи не найден в указанном наборе');
      return { content: [{ type: 'text', text: 'Описание сохранено.' }] };
    }
  );

  server.tool(
    'remove_emoji_pack',
    'Удаляет набор и все его локально сохранённые эмодзи.',
    { pack: z.string().min(1) },
    async ({ pack }) => {
      const result = db.prepare('DELETE FROM packs WHERE short_name=? OR title=?').run(pack, pack);
      return { content: [{ type: 'text', text: result.changes ? 'Набор удалён.' : 'Набор не найден.' }] };
    }
  );

  return server;
}

function createApp({ db, telegram, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'telegram-emoji', version: '1.0.0' }));

  app.get('/preview/:customEmojiId', async (req, res) => {
    try {
      const item = db.prepare('SELECT file_id FROM emojis WHERE custom_emoji_id=?').get(req.params.customEmojiId);
      if (!item) return res.status(404).json({ error: 'Emoji not found' });
      const file = await telegram.downloadFile(item.file_id);
      res.setHeader('content-type', file.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('cache-control', 'public, max-age=3600');
      const { Readable } = require('node:stream');
      Readable.fromWeb(file.body).pipe(res);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post('/mcp', async (req, res) => {
    const expected = config.security.apiKey;
    if (expected && req.headers.authorization !== `Bearer ${expected}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = makeMcpServer({ db, telegram, config });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST /mcp for stateless MCP requests' }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP endpoint' }));
  return app;
}

module.exports = { createApp };