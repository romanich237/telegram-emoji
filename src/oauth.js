const express = require('express');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const escape = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

function setupOAuth(app, db, auth, options) {
  if (!options) return null;
  const { issuer, clientId, clientSecret, redirectUri } = options;
  const url = new URL(issuer);
  const redirect = new URL(redirectUri);
  if (url.protocol !== 'https:' || url.origin !== issuer || redirect.protocol !== 'https:'
    || redirect.hash || redirect.username || redirect.password
    || typeof clientId !== 'string' || !/^[\w.-]{1,128}$/.test(clientId)
    || typeof clientSecret !== 'string' || !keyPattern.test(clientSecret)) {
    throw new Error('Некорректные параметры OAuth в config.json');
  }
  const resource = issuer + '/mcp';
  const metadata = issuer + '/.well-known/oauth-protected-resource/mcp';
  const scope = 'emoji';
  const codes = new Map();
  db.exec('CREATE TABLE IF NOT EXISTS oauth_keys (token_hash TEXT PRIMARY KEY, parent_hash TEXT NOT NULL, binding TEXT NOT NULL)');
  const binding = hash(JSON.stringify([issuer, clientId, clientSecret, redirectUri]));
  const insert = db.prepare('INSERT INTO oauth_keys VALUES (?, ?, ?)');
  const get = db.prepare('SELECT parent_hash FROM oauth_keys WHERE token_hash=? AND binding=?');
  const prune = db.prepare('DELETE FROM oauth_keys WHERE parent_hash NOT IN (SELECT token_hash FROM access_tokens) OR binding != ?');

  app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (_req, res) => res.json({
    resource, authorization_servers: [issuer], scopes_supported: [scope], bearer_methods_supported: ['header']
  }));
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'],
    scopes_supported: [scope]
  }));

  const form = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 20 });
  const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
  function valid(params) {
    return params.client_id === clientId && params.redirect_uri === redirectUri
      && params.response_type === 'code' && params.code_challenge_method === 'S256'
      && typeof params.code_challenge === 'string' && keyPattern.test(params.code_challenge)
      && typeof params.state === 'string' && params.state.length > 0 && params.state.length <= 2048
      && (params.scope === undefined || params.scope === '' || params.scope === scope)
      && (params.resource === undefined || params.resource === resource);
  }
  function authorizationPage(params, res, failed = false) {
    const hidden = fields.filter(name => params[name] !== undefined)
      .map(name => '<input type="hidden" name="' + name + '" value="' + escape(params[name]) + '">').join('');
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; form-action 'self' " + redirect.origin + "; frame-ancestors 'none'; base-uri 'none'"
    });
    return res.status(failed ? 401 : 200).type('html').send(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>Telegram Emoji MCP</title><h1>Подключение к ChatGPT</h1>' +
      '<p>Введи ключ из команды /token своего Telegram-бота, чтобы разрешить доступ к каталогу эмодзи.</p>' +
      (failed ? '<p>Ключ недействителен. Проверь его и попробуй снова.</p>' : '') +
      '<form method="post" action="/oauth/authorize">' + hidden +
      '<label>Ключ MCP <input name="key" type="password" required maxlength="43" autocomplete="off"></label> ' +
      '<button type="submit">Подключить</button></form></html>'
    );
  }
  app.get('/oauth/authorize', (req, res) => {
    if (!valid(req.query)) return res.status(400).send('Некорректный запрос OAuth');
    return authorizationPage(req.query, res);
  });
  app.post('/oauth/authorize', form, (req, res) => {
    if (req.get('origin') !== issuer) return res.sendStatus(403);
    const params = req.body || {};
    if (!valid(params)) return res.status(400).send('Некорректный запрос OAuth');
    if (!auth.verify(params.key)) return authorizationPage(params, res, true);
    const now = Date.now();
    for (const [code, entry] of codes) if (entry.expires <= now) codes.delete(code);
    if (codes.size >= 256) return res.sendStatus(503);
    const code = random();
    const parentHash = createHash('sha256').update(params.key).digest('hex');
    codes.set(code, { challenge: params.code_challenge, parentHash, expires: now + 120000 });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', params.state);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.redirect(303, target.href);
  });
  app.post('/oauth/token', form, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const params = req.body || {};
    if (params.client_id !== clientId || typeof params.client_secret !== 'string'
      || !timingSafeEqual(Buffer.from(hash(params.client_secret)), Buffer.from(hash(clientSecret)))) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    if (params.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const entry = codes.get(params.code);
    if (!entry || entry.expires <= Date.now() || params.redirect_uri !== redirectUri
      || (params.resource !== undefined && params.resource !== resource)
      || typeof params.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier)
      || hash(params.code_verifier) !== entry.challenge || !auth.verifyHash(entry.parentHash)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    codes.delete(params.code);
    prune.run(binding);
    const token = random();
    insert.run(hash(token), entry.parentHash, binding);
    return res.json({ access_token: token, token_type: 'Bearer', scope });
  });

  return {
    metadata,
    verify(token) {
      const row = get.get(hash(token), binding);
      return Boolean(row && auth.verifyHash(row.parent_hash));
    }
  };
}

module.exports = { setupOAuth };
