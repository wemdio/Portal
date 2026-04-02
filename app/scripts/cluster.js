/* eslint-disable @typescript-eslint/no-require-imports */
const cluster = require('cluster');
const os = require('os');

const CONCURRENCY = parseInt(process.env.WEB_CONCURRENCY, 10) || Math.min(os.cpus().length, 4);

if (cluster.isPrimary) {
  console.log(`[cluster] master pid=${process.pid}, spawning ${CONCURRENCY} workers`);

  for (let i = 0; i < CONCURRENCY; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(
      `[cluster] worker pid=${worker.process.pid} died (code=${code}, signal=${signal}), restarting...`
    );
    cluster.fork();
  });
} else {
  console.log(`[cluster] worker pid=${process.pid} starting server.js`);
  require('../server.js');
}
