/* eslint-disable @typescript-eslint/no-require-imports */
const cluster = require('cluster');
const { spawn } = require('child_process');
const path = require('path');
const { ensureDatabase } = require('./db/ensureDatabase');

const WEB_CONCURRENCY = Math.max(1, parseInt(process.env.WEB_CONCURRENCY || '1', 10));
const useCluster = WEB_CONCURRENCY > 1;

function spawnServer() {
  const child = spawn('node', ['server.js'], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  if (useCluster && cluster.isPrimary) {
    console.log(`[start] Cluster mode: launching ${WEB_CONCURRENCY} workers (primary pid=${process.pid})`);

    try {
      await ensureDatabase();
    } catch (err) {
      console.error('[start] DB migration failed — starting workers anyway:', err?.message ?? err);
    }

    for (let i = 0; i < WEB_CONCURRENCY; i++) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      console.error(`[start] Worker ${worker.process.pid} exited (code=${code}, signal=${signal}), restarting...`);
      cluster.fork();
    });

    return;
  }

  if (useCluster) {
    console.log(`[start] Cluster worker pid=${process.pid} starting server`);
    require(path.resolve(__dirname, '..', 'server.js'));
    return;
  }

  try {
    await ensureDatabase();
  } catch (err) {
    console.error('[start] DB migration failed — starting server anyway:', err?.message ?? err);
  }

  spawnServer();
}

main().catch((err) => {
  console.error('[start] Ошибка запуска:', err);
  process.exit(1);
});
