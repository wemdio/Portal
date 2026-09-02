/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const serviceNames = [
  'worker-baseconstructor',
  'worker-baseconstructor-2',
  'worker-baseconstructor-3',
  'worker-baseconstructor-4',
  'worker-baseconstructor-5',
  'worker-baseconstructor-6',
  'worker-baseconstructor-7',
  'worker-baseconstructor-8',
  'worker-baseconstructor-9',
  'worker-baseconstructor-10',
  'worker-baseconstructor-11',
  'worker-baseconstructor-12',
];

const containerNames = serviceNames.map((serviceName) => `portal-${serviceName}`);

describe('BaseConstructor production capacity', () => {
  it('defines exactly twelve single-job replicas', () => {
    const compose = readRepoFile('docker-compose.prod.yml');
    const declaredServices = Array.from(
      compose.matchAll(
        /^  (worker-baseconstructor(?:-(?:[2-9]|[1-9][0-9]+))?):/gm,
      ),
      (match) => match[1],
    );

    expect(declaredServices).toEqual(serviceNames);
    expect(compose).toContain('- BASE_CONSTRUCTOR_CONCURRENCY=1');
    expect(compose).toContain('- BASE_ENRICH_SCRAPE_CONCURRENCY=${BASE_ENRICH_SCRAPE_CONCURRENCY:-6}');
    expect(compose).toContain('- BASE_ENRICH_PER_SITE_TIMEOUT_MS=${BASE_ENRICH_PER_SITE_TIMEOUT_MS:-60000}');
    expect(compose).toContain('- BASE_TA_SCORING_CONCURRENCY=${BASE_TA_SCORING_CONCURRENCY:-1}');
    expect(compose).not.toContain(
      'BASE_CONSTRUCTOR_CONCURRENCY=${BASE_CONSTRUCTOR_CONCURRENCY',
    );

    for (const containerName of containerNames) {
      expect(compose).toContain(`container_name: ${containerName}`);
    }
  });

  it('keeps replicas four through twelve on the proven conservative limits', () => {
    const compose = readRepoFile('docker-compose.prod.yml');
    const conservativeReplicaBlock = compose.match(
      /^  worker-baseconstructor-4:[\s\S]*?(?=^  worker-baseconstructor-5:)/m,
    )?.[0];

    expect(conservativeReplicaBlock).toBeDefined();
    expect(conservativeReplicaBlock).toContain('memory: 4096M');
    expect(conservativeReplicaBlock).toContain("cpus: '1'");
    expect(conservativeReplicaBlock).toContain('pids: 512');
    const inheritedConservativeReplicas = Array.from(
      compose.matchAll(
        /^  worker-baseconstructor-((?:[5-9]|[1-9][0-9]+)):\r?\n    <<: \*worker-baseconstructor-conservative/gm,
      ),
      (match) => Number(match[1]),
    );
    expect(inheritedConservativeReplicas).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('includes every replica in shared-worker deploy selection', () => {
    const selector = readRepoFile('.semaphore/select-deploy-targets.sh');
    const allWorkers = selector.match(/ALL_WORKER_SERVICES="([\s\S]*?)"/)?.[1];

    expect(allWorkers).toBeDefined();
    for (const serviceName of serviceNames) {
      expect(` ${allWorkers} `).toContain(` ${serviceName} `);
    }
  });
});
