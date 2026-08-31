/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('BaseConstructor deploy drain', () => {
  it('stops every replica in parallel before handoff and scheduled removal', () => {
    const drainWorker = readRepoFile('drain-worker.sh');
    const scheduledDeploy = readRepoFile('.semaphore/scheduled-deploy.yml');
    const baseConstructorBlock = drainWorker.match(
      /bc_containers=\(\s*([\s\S]*?)\n\)/,
    )?.[1];
    const genericContainerBlock = drainWorker.match(
      /^containers=\(\s*([\s\S]*?)\n\)/m,
    )?.[1];

    expect(baseConstructorBlock).toBeDefined();
    for (const replica of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const suffix = replica === 1 ? '' : `-${replica}`;
      expect(baseConstructorBlock).toContain(
        `portal-worker-baseconstructor${suffix}`,
      );
    }
    expect(genericContainerBlock).not.toContain('baseconstructor');
    expect(drainWorker).toContain('docker stop -t 5 "$c" 2>/dev/null || true &');
    expect(drainWorker).toContain(
      'patch_rows "base_constructor_jobs" "status=eq.processing"',
    );
    expect(drainWorker).toContain('"started_at":"1970-01-01T00:00:00Z"');

    const stopIndex = drainWorker.indexOf('for c in "${bc_containers[@]}"');
    const waitIndex = drainWorker.indexOf('\nwait', stopIndex);
    const handoffIndex = drainWorker.indexOf('status=eq.processing');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(stopIndex);
    expect(handoffIndex).toBeGreaterThan(waitIndex);

    const drainIndex = scheduledDeploy.indexOf(
      'sudo -n bash drain-worker.sh \\${WORKER_TARGETS};',
    );
    const forceRemoveIndex = scheduledDeploy.indexOf(
      'for svc in \\${WORKER_TARGETS}; do force_rm_svc',
    );
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(forceRemoveIndex).toBeGreaterThan(drainIndex);
  });
});
