const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const cwd = path.resolve(__dirname, '..');
const interval = 60000;

function git(...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 }).trim();
}
function check() {
  try {
    if (!fs.existsSync(path.join(cwd,'.git'))) return console.error('Автообновление: нет .git, пропуск');
    if (git('branch','--show-current') !== 'main') return console.error('Автообновление: активна не main');
    if (git('status','--porcelain')) return console.error('Автообновление: есть локальные изменения, пропуск');
    git('fetch','--prune','origin','main');
    const local = git('rev-parse','HEAD');
    const remote = git('rev-parse','origin/main');
    if (local === remote) return;
    const base = git('merge-base','HEAD','origin/main');
    if (base !== local) return console.error('Автообновление: diverged, пропуск');
    console.log('Найдено обновление',local.slice(0,8),'->',remote.slice(0,8));
    git('merge','--ff-only','origin/main');
    execFileSync('npm',['install','--omit=dev','--no-audit','--no-fund'],{cwd,stdio:'inherit',timeout:180000});
    execFileSync('pm2',['restart','telegram-emoji','--update-env'],{cwd,stdio:'inherit',timeout:30000});
    console.log('Обновлено до',remote.slice(0,8));
  } catch (error) {
    console.error('Ошибка автообновления:',error.message);
  }
}
setTimeout(check,10000);
setInterval(check,interval);