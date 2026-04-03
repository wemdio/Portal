/* eslint-disable @typescript-eslint/no-require-imports */
const cluster = require('cluster');
const os = require('os');

const CONCURRENCY = parseInt(process.env.WEB_CONCURRENCY, 10) || Math.min(os.cpus().length, 4);
const GRACEFUL_SHUTDOWN_MS = 10_000;

if (cluster.isPrimary) {
  console.log(`[cluster] master pid=${process.pid}, spawning ${CONCURRENCY} workers`);

  let isRollingRestart = false;

  for (let i = 0; i < CONCURRENCY; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    if (isRollingRestart) return;
    console.error(
      `[cluster] worker pid=${worker.process.pid} died (code=${code}, signal=${signal}), restarting...`
    );
    cluster.fork();
  });

  function waitForListening(worker) {
    return new Promise((resolve) => {
      worker.once('listening', () => resolve());
    });
  }

  function shutdownWorker(worker) {
    return new Promise((resolve) => {
      const pid = worker.process.pid;
      const timer = setTimeout(() => {
        console.warn(`[cluster] worker pid=${pid} did not exit in ${GRACEFUL_SHUTDOWN_MS}ms, killing`);
        worker.kill();
        resolve();
      }, GRACEFUL_SHUTDOWN_MS);

      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      worker.send({ type: 'shutdown' });
      worker.disconnect();
    });
  }

  async function rollingRestart() {
    if (isRollingRestart) {
      console.warn('[cluster] rolling restart already in progress, skipping');
      return;
    }
    isRollingRestart = true;
    console.log('[cluster] starting rolling restart of all workers');

    const oldWorkers = Object.values(cluster.workers).filter(Boolean);

    for (const oldWorker of oldWorkers) {
      const oldPid = oldWorker.process.pid;

      const newWorker = cluster.fork();
      console.log(`[cluster] forked replacement worker pid=${newWorker.process.pid} for pid=${oldPid}`);

      await waitForListening(newWorker);
      console.log(`[cluster] new worker pid=${newWorker.process.pid} is listening, shutting down pid=${oldPid}`);

      await shutdownWorker(oldWorker);
      console.log(`[cluster] old worker pid=${oldPid} shut down`);
    }

    isRollingRestart = false;
    console.log('[cluster] rolling restart complete');
  }

  for (const id in cluster.workers) {
    cluster.workers[id].on('message', (msg) => {
      if (msg && msg.type === 'reload-env') {
        rollingRestart();
      }
    });
  }

  cluster.on('fork', (worker) => {
    worker.on('message', (msg) => {
      if (msg && msg.type === 'reload-env') {
        rollingRestart();
      }
    });
  });
} else {
  console.log(`[cluster] worker pid=${process.pid} starting server.js`);

  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      console.log(`[cluster] worker pid=${process.pid} received shutdown, closing gracefully`);
      process.exit(0);
    }
  });

  require('../server.js');
}
