/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

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
});
