/** @jest-environment node */

/**
 * undici inflates gzip database responses on the libuv pool. With the default
 * 4 threads busy (getaddrinfo of dead website domains, big zlib jobs), a body
 * of a few dozen bytes waits until a thread frees up (23.09.2026). The VE2
 * worker process must start with a larger pool, and libuv reads the size only
 * once, before the pool is first used.
 *
 * The runner is bundled exactly as in Dockerfile.worker and started with
 * WORKER_KIND=vertical-engine-v2; a stand-in worker module occupies four pool
 * threads and then inflates a small gzip body, as undici does.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STAND_IN_WORKER = `
const crypto = require('node:crypto');
const zlib = require('node:zlib');
// About 0.7 s of pool work per blocker, measured on this machine.
const t0 = Date.now(); crypto.pbkdf2Sync('x', 's', 100000, 32, 'sha512');
const iterations = Math.max(100000, Math.round(700 / Math.max(1e-6, (Date.now() - t0) / 100000)));
let blockersDone = 0;
for (let i = 0; i < 4; i++) crypto.pbkdf2('x', 's', iterations, 32, 'sha512', () => { blockersDone++; });
zlib.gunzip(zlib.gzipSync('{"id":"0482f88b-0c6d-4509-a6ce-22278847ad21"}'), () => {
  process.stdout.write(JSON.stringify({ pool: process.env.UV_THREADPOOL_SIZE ?? null, blockersDoneBeforeBody: blockersDone }));
  process.exit(0);
});
`;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 've2-threadpool-'));
  execFileSync(path.join(process.cwd(), 'node_modules/.bin/esbuild'), [
    'worker/runner.ts', '--bundle', '--platform=node', '--target=node22', `--outfile=${path.join(dir, 'runner.js')}`, '--log-level=error',
  ], { cwd: process.cwd() });
  fs.writeFileSync(path.join(dir, 'verticalEngineV2.js'), STAND_IN_WORKER);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function start(entry: string, env: Record<string, string>): { pool: string | null; blockersDoneBeforeBody: number } {
  const baseEnv = { ...process.env };
  delete baseEnv.UV_THREADPOOL_SIZE;
  return JSON.parse(execFileSync(process.execPath, [path.join(dir, entry)], { env: { ...baseEnv, ...env }, timeout: 30_000 }).toString());
}

describe('VE2 worker libuv pool', () => {
  it('the runner starts the VE2 worker with 16 pool threads: a small gzip body is not queued behind busy threads', () => {
    expect(start('runner.js', { WORKER_KIND: 'vertical-engine-v2' })).toEqual({ pool: '16', blockersDoneBeforeBody: 0 });
  });

  it('control: with the default pool the same body waits for a busy thread', () => {
    const result = start('verticalEngineV2.js', {});
    expect(result.pool).toBeNull();
    expect(result.blockersDoneBeforeBody).toBeGreaterThan(0);
  });

  it('an explicit size from the environment wins', () => {
    expect(start('runner.js', { WORKER_KIND: 'vertical-engine-v2', UV_THREADPOOL_SIZE: '4' }).pool).toBe('4');
  });
});
