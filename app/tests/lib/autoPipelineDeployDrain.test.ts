/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('auto-pipeline deploy drain', () => {
  it('gracefully stops auto-pipeline before generic worker removal', () => {
    const compose = readRepoFile('docker-compose.prod.yml');
    const drainWorker = readRepoFile('drain-worker.sh');
    const scheduledDeploy = readRepoFile('.semaphore/scheduled-deploy.yml');
    const deployTargets = readRepoFile('.semaphore/select-deploy-targets.sh');

    const composeService = compose.match(
      /^  worker-autopipeline:\s*\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\s*$)/m,
    )?.[1];
    expect(composeService).toBeDefined();
    expect(composeService).toContain('container_name: portal-worker-autopipeline');
    expect(composeService).toContain('stop_grace_period: 20m');

    const genericContainerBlock = drainWorker.match(
      /^\s*containers=\(\s*([\s\S]*?)\n\s*\)/m,
    )?.[1];
    expect(genericContainerBlock).toBeDefined();
    expect(genericContainerBlock).not.toContain('portal-worker-autopipeline');

    const gracefulStop = drainWorker.match(
      /if should_drain_worker "worker-autopipeline"; then[\s\S]*?\nfi/,
    )?.[0];
    expect(gracefulStop).toBeDefined();
    expect(gracefulStop).toContain('should_drain_worker "worker-autopipeline"');
    expect(gracefulStop).toContain('[drain] Gracefully stopping auto-pipeline');
    expect(gracefulStop).toContain(
      'docker compose --env-file .env -p portal -f docker-compose.prod.yml stop worker-autopipeline',
    );
    expect(gracefulStop).not.toContain('|| true');
    expect(gracefulStop).not.toMatch(/&\s*$/m);

    const autoStopIndex = drainWorker.indexOf(
      'docker compose --env-file .env -p portal -f docker-compose.prod.yml stop worker-autopipeline',
    );
    const genericStopIndex = drainWorker.indexOf('for c in "${containers[@]}"');
    expect(autoStopIndex).toBeGreaterThanOrEqual(0);
    expect(genericStopIndex).toBeGreaterThan(autoStopIndex);

    const drainIndex = scheduledDeploy.indexOf(
      'sudo -n bash drain-worker.sh \\${WORKER_TARGETS};',
    );
    const forceRemoveIndex = scheduledDeploy.indexOf(
      'for svc in \\${WORKER_TARGETS}; do force_rm_svc',
    );
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(forceRemoveIndex).toBeGreaterThan(drainIndex);
    expect(deployTargets).toContain('worker-autopipeline');
    expect(scheduledDeploy).toMatch(
      /name: Pull and deploy[\s\S]*?execution_time_limit:\s*\n\s*minutes: 60/,
    );
  });

  it('fails closed unless manual scoring stops with a clean persisted-lease exit', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-scoring-drain-'));
    const calls = path.join(fixture, 'calls');

    try {
      fs.writeFileSync(
        path.join(fixture, 'docker'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$MANUAL_DRAIN_CALLS"
case "$*" in
  *"ps -q worker-manual-scoring") printf '%s\\n' manual-container; exit 0 ;;
  *"stop --timeout -1 manual-container")
    if [ "\${MANUAL_STAYS_RUNNING:-0}" = 1 ]; then
      trap 'exit 143' TERM
      while :; do :; done
    fi
    exit "\${MANUAL_STOP_RC:-0}"
    ;;
  *"inspect --format"*"manual-container")
    if [ "\${MANUAL_STAYS_RUNNING:-0}" = 1 ]; then
      printf 'true 0\\n'
    else
      printf 'false %s\\n' "\${MANUAL_EXIT_CODE:-0}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fixture, 'sleep'),
        '#!/bin/sh\n[ "${MANUAL_DRAIN_REAL_SLEEP:-0}" = 1 ] && exec /bin/sleep "$@"\nexit 0\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(fixture, 'sudo'),
        '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n',
        { mode: 0o755 },
      );

      const run = (
        stopRc: string,
        exitCode: string,
        staysRunning = '0',
        timeoutSeconds = '600',
        realSleep = '0',
      ) => {
        fs.writeFileSync(calls, '');
        const result = spawnSync(
          'bash',
          [path.join(repoRoot, 'drain-worker.sh'), 'worker-manual-scoring'],
          {
            cwd: fixture,
            encoding: 'utf8',
            timeout: 5_000,
            env: {
              ...process.env,
              PATH: `${fixture}:${process.env.PATH}`,
              NEXT_PUBLIC_SUPABASE_URL: '',
              SUPABASE_SERVICE_ROLE_KEY: '',
              MANUAL_DRAIN_CALLS: calls,
              MANUAL_STOP_RC: stopRc,
              MANUAL_EXIT_CODE: exitCode,
              MANUAL_STAYS_RUNNING: staysRunning,
              MANUAL_SCORING_DRAIN_TIMEOUT_SECONDS: timeoutSeconds,
              MANUAL_DRAIN_REAL_SLEEP: realSleep,
            },
          },
        );
        return {
          ...result,
          calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
        };
      };

      const clean = run('0', '0');
      expect(clean.status).toBe(0);
      expect(clean.calls[0]).toContain('ps -q worker-manual-scoring');
      expect(clean.calls).toHaveLength(3);
      expect(clean.calls.some((call) => call.includes('stop --timeout -1 manual-container'))).toBe(true);
      expect(clean.calls.some((call) => call.includes('inspect --format'))).toBe(true);
      expect(clean.calls.some((call) => call.includes('--timeout 600'))).toBe(false);
      expect(clean.calls.some((call) => call.includes('stop -t 15'))).toBe(false);

      // Even when the local stop client succeeds, a non-zero container exit is
      // fail-closed proof that graceful lease persistence did not complete.
      const killed = run('0', '137');
      expect(killed.status).toBe(1);
      expect(killed.stderr).toContain('aborting before forced removal');

      const stopFailed = run('7', '0');
      expect(stopFailed.status).toBe(1);
      expect(stopFailed.stderr).toContain('stop client failed (7)');
      expect(stopFailed.calls[0]).toContain('ps -q worker-manual-scoring');
      expect(stopFailed.calls).toHaveLength(3);
      expect(
        stopFailed.calls.some((call) => call.includes('stop --timeout -1 manual-container')),
      ).toBe(true);
      expect(stopFailed.calls.some((call) => call.includes('inspect --format'))).toBe(true);

      const timedOut = run('0', '0', '1', '1', '1');
      expect(timedOut.status).toBe(1);
      expect(timedOut.stderr).toContain('worker left running');
      expect(timedOut.calls[0]).toContain('ps -q worker-manual-scoring');
      expect(
        timedOut.calls.some((call) => call.includes('stop --timeout -1 manual-container')),
      ).toBe(true);
      expect(timedOut.calls.filter((call) => call.includes('inspect --format')).length).toBeGreaterThan(0);
      expect(timedOut.calls.some((call) => call.includes('--timeout 600'))).toBe(false);
      expect(timedOut.calls.some((call) => call.includes('rm -f'))).toBe(false);
      expect(timedOut.calls.some((call) => call.includes('kill'))).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
