/**
 * Nightly emails pull wrapper.
 *
 * Runs pull.mjs --phase=emails --rpm=5 --concurrency=1 ONLY during the night
 * window 23:00 UTC → 03:00 UTC (= 02:00 МСК → 06:00 МСК). Outside that window,
 * sleeps and re-checks every 30 minutes.
 *
 * Why 5 RPM:
 *   - The qualifier worker (portal-worker-instantly-leads) polls /emails every
 *     30s, fetching 5 pages per cycle ≈ 9 RPM. Empirically Instantly's /emails
 *     ceiling is ~15-20 RPM per workspace. 5 RPM keeps headroom for the worker.
 *
 * Per-window throughput: ~240 campaigns/night → completes 1349 in ~6 nights.
 *
 * Resumable: pull.mjs is idempotent (per-campaign file cache). Killing mid-
 * campaign costs at most one campaign's pages — re-run picks up from disk.
 *
 * Usage:
 *   node app/scripts/instantly-dataset/pull-emails-nightly.mjs
 *
 * Stop with Ctrl-C or kill the process; it's safe at any moment.
 */
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PULL_SCRIPT = resolve(__dirname, 'pull.mjs');

const WINDOW_START_UTC_HOUR = 23; // 02:00 МСК
const WINDOW_END_UTC_HOUR = 3;    // 06:00 МСК

function inWindow(d = new Date()) {
  const h = d.getUTCHours();
  // window crosses midnight: [23, 0, 1, 2]
  return h >= WINDOW_START_UTC_HOUR || h < WINDOW_END_UTC_HOUR;
}

function log(...m) {
  console.log(`[${new Date().toISOString()}]`, ...m);
}

let currentChild = null;
let shuttingDown = false;

function stopChild(reason) {
  if (!currentChild) return Promise.resolve();
  log(`Stopping pull (${reason})…`);
  return new Promise((resolveFn) => {
    const child = currentChild;
    child.once('exit', (code, signal) => {
      log(`Pull exited (code=${code}, signal=${signal ?? '-'})`);
      currentChild = null;
      resolveFn();
    });
    try { child.kill('SIGTERM'); } catch {}
    // Force-kill if it doesn't shut down in 10s
    setTimeout(() => {
      if (currentChild === child) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 10_000).unref();
  });
}

function startChild() {
  log(`Starting pull at 5 RPM / concurrency=1`);
  const child = spawn(process.execPath, [PULL_SCRIPT, '--phase=emails', '--rpm=5', '--concurrency=1'], {
    cwd: resolve(__dirname, '../..'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (currentChild === child) currentChild = null;
    if (!shuttingDown) {
      log(`Pull child exited unexpectedly (code=${code}, signal=${signal ?? '-'})`);
    }
  });
  currentChild = child;
}

async function sleepMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function loop() {
  log(`Wrapper started. Window: ${WINDOW_START_UTC_HOUR}:00 → ${WINDOW_END_UTC_HOUR}:00 UTC daily.`);
  while (!shuttingDown) {
    if (inWindow()) {
      if (!currentChild) startChild();
      // Re-check window every 60s; if we're now outside, stop the child
      await sleepMs(60_000);
      if (!inWindow() && currentChild) {
        await stopChild('window closed');
      }
    } else {
      if (currentChild) await stopChild('window closed (race)');
      // Sleep 30 min then re-check
      const now = new Date();
      const next = nextWindowOpenAt(now);
      const minsUntil = Math.round((next - now) / 60_000);
      log(`Outside window. Next opens at ${next.toISOString()} (~${minsUntil} min). Sleeping 30 min.`);
      await sleepMs(30 * 60_000);
    }
  }
}

function nextWindowOpenAt(now) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  if (now.getUTCHours() >= WINDOW_START_UTC_HOUR) {
    // tomorrow's same-hour window (already past today's open)
    next.setUTCDate(next.getUTCDate() + 1);
  }
  next.setUTCHours(WINDOW_START_UTC_HOUR);
  return next;
}

process.on('SIGINT', async () => {
  log('SIGINT received');
  shuttingDown = true;
  await stopChild('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log('SIGTERM received');
  shuttingDown = true;
  await stopChild('SIGTERM');
  process.exit(0);
});

loop().catch((e) => {
  log('Wrapper crashed:', e);
  process.exit(1);
});
