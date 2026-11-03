const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);
const cwd = path.resolve(__dirname, '..');
const interval = 60000;

function startUpdater(restart) {
  let stopped = false;
  let timer;
  let pendingInstall = false;

  async function git(...args) {
    const { stdout } = await run('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
    return stdout.trim();
  }

  async function check() {
    try {
      if (await git('branch', '--show-current') !== 'main') return;
      if (await git('status', '--porcelain')) return;
      if (!pendingInstall) {
        await git('fetch', '--prune', 'origin', 'main');
        const local = await git('rev-parse', 'HEAD');
        const remote = await git('rev-parse', 'origin/main');
        if (local === remote || await git('merge-base', local, remote) !== local || stopped) return;
        await git('merge', '--ff-only', remote);
        pendingInstall = true;
      }
      if (stopped) return;
      await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd, timeout: 180000 });
      await run('npm', ['run', 'check'], { cwd, timeout: 30000 });
      if (stopped) return;
      console.log('Автообновление установлено. PM2 перезапустит сервис.');
      stopped = true;
      restart();
    } catch (error) {
      console.error('Ошибка автообновления:', error.message);
    } finally {
      if (!stopped) timer = setTimeout(check, interval);
    }
  }

  timer = setTimeout(check, 10000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { startUpdater };
