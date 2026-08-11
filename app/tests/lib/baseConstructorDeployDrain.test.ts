/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('BaseConstructor deploy drain', () => {
  it('gracefully stops every replica before scheduled worker removal', () => {
    const drainWorker = readRepoFile('drain-worker.sh');
    const scheduledDeploy = readRepoFile('.semaphore/scheduled-deploy.yml');
    const containerBlock = drainWorker.match(
      /base_constructor_containers=\(\s*([\s\S]*?)\n\)/,
    )?.[1];

    expect(containerBlock).toBeDefined();
    expect(containerBlock).toContain('portal-worker-baseconstructor');
    expect(containerBlock).toContain('portal-worker-baseconstructor-2');
    expect(containerBlock).toContain('portal-worker-baseconstructor-3');
    expect(drainWorker).toContain(
      'docker kill --signal=SIGTERM "${base_constructor_containers[@]}"',
    );
    expect(drainWorker).toContain('docker stop -t 15 "$c"');
    expect(drainWorker).toContain(
      'patch_rows "base_constructor_jobs" "status=eq.processing"',
    );
    expect(drainWorker).toContain('"started_at":"1970-01-01T00:00:00Z"');

    const stopIndex = drainWorker.indexOf('for c in "${containers[@]}"');
    const handoffIndex = drainWorker.indexOf('status=eq.processing');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(handoffIndex).toBeGreaterThan(stopIndex);

    const drainIndex = scheduledDeploy.indexOf('sudo -n bash drain-worker.sh;');
    const forceRemoveIndex = scheduledDeploy.indexOf(
      'for svc in \\${WORKER_TARGETS}; do force_rm_svc',
    );
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(forceRemoveIndex).toBeGreaterThan(drainIndex);
  });
});
