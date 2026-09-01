/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('BaseConstructor deploy drain', () => {
  it('does not pause or stop unrelated workers during a Base Constructor-only drain', () => {
    const drainWorker = readRepoFile('drain-worker.sh');
    const guardedGenericStops = drainWorker.match(
      /if should_drain_non_baseconstructor_workers; then[\s\S]*?for c in "\$\{containers\[@\]\}"[\s\S]*?\nfi/,
    )?.[0];

    expect(drainWorker).toContain(
      'if should_drain_non_baseconstructor_workers && [ -n "$SUPABASE_URL" ] && [ -n "$KEY" ]; then',
    );
    expect(guardedGenericStops).toBeDefined();
  });

  it('does not stop or age Base Constructor jobs unless its worker group was selected', () => {
    const drainWorker = readRepoFile('drain-worker.sh');
    const guardedDrain = drainWorker.match(
      /if should_drain_baseconstructor_workers; then[\s\S]*?\nfi/,
    )?.[0];

    expect(guardedDrain).toBeDefined();
    expect(guardedDrain).toContain('for c in "${bc_containers[@]}"');
    expect(guardedDrain).toContain('status=eq.processing');
  });

  it('stops every replica in parallel before handoff and scheduled removal', () => {
    const drainWorker = readRepoFile('drain-worker.sh');
    const scheduledDeploy = readRepoFile('.semaphore/scheduled-deploy.yml');
    const baseConstructorBlock = drainWorker.match(
      /bc_containers=\(\s*([\s\S]*?)\n\s*\)/,
    )?.[1];
    const genericContainerBlock = drainWorker.match(
      /^\s*containers=\(\s*([\s\S]*?)\n\s*\)/m,
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
    const waitIndex = drainWorker.indexOf('\n  wait', stopIndex);
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
