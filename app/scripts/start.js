/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('child_process');
const { ensureDatabase } = require('./db/ensureDatabase');

async function main() {
  try {
    await ensureDatabase();
  } catch (err) {
    console.error('[start] DB migration failed — starting server anyway:', err?.message ?? err);
  }

  const child = spawn('node', ['scripts/cluster.js'], { stdio: 'inherit' });
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
