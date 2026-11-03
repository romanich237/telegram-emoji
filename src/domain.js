const fs = require('node:fs/promises');
const { Resolver } = require('node:dns/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isIPv4 } = require('node:net');

const exec = promisify(execFile);
const conf = '/etc/nginx/conf.d/telegram-emoji-https.conf';
const webroot = '/var/lib/telegram-emoji/acme';
const hook = '/etc/letsencrypt/renewal-hooks/deploy/telegram-emoji-reload';
const run = (command, args, timeout = 15000) => exec(command, args, { timeout, maxBuffer: 256 * 1024 });

function parseDomain(value) {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(domain)) {
    throw new Error('Введи домен, например emoji.example.com.');
  }
  return domain;
}

async function checkDns(domain) {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const ipv6 = resolver.resolve6(domain).catch(error => {
    if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return [];
    throw error;
  });
  const [response, ipv4, aaaa] = await Promise.all([
    fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) }),
    resolver.resolve4(domain).catch(error => {
      if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return [];
      throw error;
    }),
    ipv6
  ]);
  const ip = (await response.text()).trim();
  if (!response.ok || !isIPv4(ip)) throw new Error('Не удалось определить публичный IPv4 сервера.');
  if (!ipv4.length || ipv4.some(address => address !== ip) || aaaa.length) {
    throw new Error('Укажи A-запись ' + domain + ' → ' + ip +
      ' и убери AAAA для этого домена. Сейчас A: ' + (ipv4.join(', ') || 'нет') +
      ', AAAA: ' + (aaaa.join(', ') || 'нет') + '. После обновления DNS отправь домен снова.');
  }
}

function nginxConfig(domain, port, certificate) {
  const proxy = [
    '    location / {',
    '        proxy_pass http://127.0.0.1:' + port + ';',
    '        proxy_http_version 1.1;',
    '        proxy_read_timeout 120s;',
    '        proxy_buffering off;',
    '    }'
  ];
  const lines = [
    'server {', '    listen 80;', '    server_name ' + domain + ';',
    '    location ^~ /.well-known/acme-challenge/ { root ' + webroot + '; }',
    '    location / { ' + (certificate ? 'return 301 https://$host$request_uri;' : 'return 404;') + ' }',
    '}'
  ];
  if (certificate) lines.push(
    'server {', '    listen 443 ssl;', '    server_name ' + domain + ';',
    '    ssl_certificate ' + certificate + '/fullchain.pem;',
    '    ssl_certificate_key ' + certificate + '/privkey.pem;',
    ...proxy, '}'
  );
  return lines.join('\n') + '\n';
}

async function writeConfig(content) {
  const temp = conf + '.tmp';
  await fs.writeFile(temp, content, { mode: 0o644 });
  await fs.rename(temp, conf);
}

async function reload(domain) {
  const { stderr } = await run('nginx', ['-t']);
  if (domain && stderr.split('\n').some(line => line.includes('conflicting server name "' + domain + '"'))) {
    throw new Error('Этот домен уже занят в Nginx.');
  }
  await run('systemctl', ['reload', 'nginx']);
}

function createDomainSetup(db, port) {
  db.exec('CREATE TABLE IF NOT EXISTS service_domain (id INTEGER PRIMARY KEY CHECK(id=1), domain TEXT NOT NULL)');
  const current = () => db.prepare('SELECT domain FROM service_domain WHERE id=1').get()?.domain;
  let busy = false;

  async function setup(domain) {
    domain = parseDomain(domain);
    if (busy) throw new Error('Настройка уже выполняется.');
    busy = true;
    try {
      if (process.getuid?.() !== 0) throw new Error('Запусти установщик через sudo bash install.sh для настройки Nginx.');
      await checkDns(domain);
      await run('certbot', ['--version']).catch(() => {
        throw new Error('Certbot не установлен. Запусти sudo bash install.sh.');
      });
      const previous = await fs.readFile(conf, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      await fs.mkdir(webroot, { recursive: true });
      await fs.mkdir('/etc/letsencrypt/renewal-hooks/deploy', { recursive: true });
      await fs.writeFile(hook, '#!/bin/sh\nnginx -t && systemctl reload nginx\n', { mode: 0o755 });
      const certName = 'telegram-emoji-' + domain;
      const certificate = '/etc/letsencrypt/live/' + certName;
      try {
        await writeConfig(current() === domain && previous ? previous : nginxConfig(domain, port));
        await reload(domain);
        await run('certbot', [
          'certonly', '--webroot', '-w', webroot, '--cert-name', certName, '-d', domain,
          '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--keep-until-expiring'
        ], 180000).catch(error => {
          console.error('Certbot:', error.stderr || error.message);
          throw new Error('Не удалось выпустить сертификат. Проверь доступность порта 80 из интернета и журнал Certbot.');
        });
        await writeConfig(nginxConfig(domain, port, certificate));
        await reload(domain);
        db.prepare('INSERT INTO service_domain(id,domain) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET domain=excluded.domain').run(domain);
      } catch (error) {
        if (previous === null) await fs.rm(conf, { force: true });
        else await writeConfig(previous);
        await reload();
        if (error.cmd) {
          console.error('Nginx:', error.stderr || error.message);
          throw new Error('Не удалось применить настройки Nginx. Проверь журнал сервиса.');
        }
        throw error;
      }
    } finally {
      busy = false;
    }
  }

  return { current, setup };
}

module.exports = { createDomainSetup, parseDomain };
