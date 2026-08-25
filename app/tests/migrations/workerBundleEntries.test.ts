/** @jest-environment node */

/**
 * Страж «entry ↔ файл» для воркер-бандлов. Дважды ловили продовый CI-фейл:
 * esbuild-запись в Dockerfile.worker указывает на несуществующий/незакоммиченный
 * worker-файл (salesReportCron — файл удалили, запись осталась; clientReportExports —
 * запись закоммитили раньше файла). Локально на Windows это не ловится, если файл
 * валяется в рабочем дереве незакоммиченным, — поэтому проверяем наличие на диске
 * (в CI checkout совпадает с git) для обоих списков: Dockerfile.worker и
 * package.json build:workers.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function workerEntriesFrom(text: string): string[] {
  return Array.from(new Set(text.match(/worker\/[A-Za-z0-9_-]+\.ts/g) ?? [])).sort();
}

describe('worker bundle entry lists point at real files', () => {
  it('Dockerfile.worker esbuild entries all exist in app/worker/', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8');
    const entries = workerEntriesFrom(dockerfile);
    expect(entries.length).toBeGreaterThan(10);
    const missing = entries.filter((e) => !fs.existsSync(path.join(REPO_ROOT, 'app', e)));
    expect(missing).toEqual([]);
  });

  it('package.json build:workers entries all exist in app/worker/', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'package.json'), 'utf8'));
    for (const scriptName of ['build:workers', 'build:workers:watch']) {
      const entries = workerEntriesFrom(pkg.scripts[scriptName] ?? '');
      const missing = entries.filter((e) => !fs.existsSync(path.join(REPO_ROOT, 'app', e)));
      expect(missing).toEqual([]);
    }
  });

  // Крон-воркеры запускаются на проде через `docker exec … node /app/workers/<name>.js`,
  // поэтому КАЖДЫЙ *Cron.ts из build:workers обязан быть и в esbuild-списке
  // Dockerfile.worker — иначе бандл просто не попадёт в образ (gisSignalOutreachCron,
  // 06.08.2026: в package.json был, в образе отсутствовал, пайплайн молча не стартовал).
  // На проде WORKER_KIND=all / worker/index.ts не запускается — только
  // специализированные контейнеры. Джобы inn_enrich, повешенные только на
  // index.ts, навсегда остаются pending. Страж: dedicated worker + compose.
  it('prod compose runs a dedicated inn-enrich worker (index.ts is not run on prod)', () => {
    const yml = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    expect(yml).toMatch(/container_name:\s*portal-worker-inn-enrich/);
    expect(yml).toMatch(/WORKER_KIND=innerenrich/);
    const runner = fs.readFileSync(path.join(REPO_ROOT, 'app', 'worker', 'runner.ts'), 'utf8');
    expect(runner).toMatch(/case 'innerenrich'/);
    expect(fs.existsSync(path.join(REPO_ROOT, 'app', 'worker', 'innEnrich.ts'))).toBe(true);
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8');
    expect(dockerfile).toMatch(/worker\/innEnrich\.ts/);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'package.json'), 'utf8'));
    expect(pkg.scripts['build:workers']).toMatch(/worker\/innEnrich\.ts/);
    const deployTargets = fs.readFileSync(
      path.join(REPO_ROOT, '.semaphore', 'select-deploy-targets.sh'),
      'utf8',
    );
    expect(deployTargets).toMatch(/ALL_WORKER_SERVICES="[^"]*\bworker-inn-enrich\b/);
  });

  it('prod compose runs website INN lookup outside the browser', () => {
    const yml = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    expect(yml).toMatch(/container_name:\s*portal-worker-website-inn-lookup/);
    expect(yml).toMatch(/WORKER_KIND=websiteinnlookup/);
    const runner = fs.readFileSync(path.join(REPO_ROOT, 'app', 'worker', 'runner.ts'), 'utf8');
    expect(runner).toMatch(/case 'websiteinnlookup'/);
    expect(fs.existsSync(path.join(REPO_ROOT, 'app', 'worker', 'websiteInnLookup.ts'))).toBe(true);
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8');
    expect(dockerfile).toMatch(/worker\/websiteInnLookup\.ts/);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'package.json'), 'utf8'));
    expect(pkg.scripts['build:workers']).toMatch(/worker\/websiteInnLookup\.ts/);
    const deployTargets = fs.readFileSync(
      path.join(REPO_ROOT, '.semaphore', 'select-deploy-targets.sh'),
      'utf8',
    );
    expect(deployTargets).toMatch(/ALL_WORKER_SERVICES="[^"]*\bworker-website-inn-lookup\b/);
  });

  it('every *Cron.ts in build:workers is also bundled in Dockerfile.worker', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'package.json'), 'utf8'));
    const dockerEntries = workerEntriesFrom(fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8'));
    const pkgCrons = workerEntriesFrom(pkg.scripts['build:workers'] ?? '').filter((e) => /Cron\.ts$/.test(e));
    expect(pkgCrons.length).toBeGreaterThan(0);
    const missing = pkgCrons.filter((e) => !dockerEntries.includes(e));
    expect(missing).toEqual([]);
  });
});
