module.exports = {
  apps: [
    { name: 'telegram-emoji', script: './src/index.js', cwd: __dirname, instances: 1, exec_mode: 'fork', autorestart: true, watch: false, max_memory_restart: '300M', time: true }
  ]
};