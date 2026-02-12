const { spawn } = require('child_process');
const { ensureDatabase } = require('./db/ensureDatabase');

async function main() {
  await ensureDatabase();

  const child = spawn('node', ['server.js'], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[start] Ошибка запуска:', err);
  process.exit(1);
});
