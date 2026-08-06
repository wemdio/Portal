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
  it('every *Cron.ts in build:workers is also bundled in Dockerfile.worker', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'package.json'), 'utf8'));
    const dockerEntries = workerEntriesFrom(fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.worker'), 'utf8'));
    const pkgCrons = workerEntriesFrom(pkg.scripts['build:workers'] ?? '').filter((e) => /Cron\.ts$/.test(e));
    expect(pkgCrons.length).toBeGreaterThan(0);
    const missing = pkgCrons.filter((e) => !dockerEntries.includes(e));
    expect(missing).toEqual([]);
  });
});
