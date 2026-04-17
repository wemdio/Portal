import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';

dotenv.config({ path: resolve(__dirname, '../../.env') });

import { processSignalsForUrl } from '../src/lib/enrich/websiteSignalProcessor';

const CSV_PATH = process.argv[2] ?? 'C:\\Users\\wemd1\\Downloads\\Untitled spreadsheet - Sheet1 - 2026-04-17T033047.532.csv';
const SAMPLE_SIZE = Number(process.argv[3] ?? '120');
const CONCURRENCY = Number(process.argv[4] ?? '4');

interface TestResult {
  url: string;
  normalized: string;
  ok: boolean;
  error?: string;
  method?: 'http' | 'playwright';
  signalIds: string[];
  profile: string;
  stack: string;
  durationMs: number;
}

function readCsvWebsites(): string[] {
  const raw = readFileSync(CSV_PATH, 'utf-8');
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  const sites = new Set<string>();
  for (const row of parsed.data) {
    const cell = row['Веб-сайт'] ?? row['website'] ?? row['Website'];
    if (!cell) continue;
    for (const candidate of String(cell).split(/[\s,;]+/)) {
      const trimmed = candidate.trim();
      if (trimmed && trimmed.length > 3) sites.add(trimmed.toLowerCase());
    }
  }
  return Array.from(sites);
}

async function processSite(url: string): Promise<TestResult> {
  const start = Date.now();
  const result = await processSignalsForUrl(url);

  if ('error' in result) {
    return {
      url,
      normalized: url,
      ok: false,
      error: result.error,
      signalIds: [],
      profile: '',
      stack: '',
      durationMs: Date.now() - start,
    };
  }

  return {
    url,
    normalized: url,
    ok: true,
    method: result.method,
    signalIds: result.signalIds,
    profile: result.profile,
    stack: result.stack,
    durationMs: Date.now() - start,
  };
}

async function runWithConcurrency(sites: string[], limit: number): Promise<TestResult[]> {
  const results: TestResult[] = new Array(sites.length);
  let idx = 0;
  let completed = 0;

  async function worker(workerId: number) {
    while (idx < sites.length) {
      const myIdx = idx++;
      const site = sites[myIdx];
      try {
        results[myIdx] = await processSite(site);
      } catch (err) {
        results[myIdx] = {
          url: site,
          normalized: '',
          ok: false,
          error: err instanceof Error ? err.message : 'unknown error',
          signalIds: [],
          profile: '',
          stack: '',
          durationMs: 0,
        };
      }
      completed++;
      if (completed % 10 === 0 || completed === sites.length) {
        process.stdout.write(`\r  Прогресс: ${completed}/${sites.length}    `);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, sites.length) }, (_, i) => worker(i));
  await Promise.all(workers);
  process.stdout.write('\n');
  return results;
}

function buildReport(results: TestResult[]): string {
  const lines: string[] = [];
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const failed = total - ok;
  const withSignals = results.filter((r) => r.ok && r.signalIds.length > 0).length;
  const withProfile = results.filter((r) => r.profile).length;
  const noSignals = results.filter((r) => r.ok && r.signalIds.length === 0);
  const httpCount = results.filter((r) => r.ok && r.method === 'http').length;
  const playwrightCount = results.filter((r) => r.ok && r.method === 'playwright').length;
  const avgFetchMs = Math.round(
    results.reduce((sum, r) => sum + r.durationMs, 0) / Math.max(1, total),
  );
  const avgSignalsPerSite =
    results.filter((r) => r.ok).reduce((sum, r) => sum + r.signalIds.length, 0) /
    Math.max(1, ok);

  lines.push('═'.repeat(70));
  lines.push('ОТЧЁТ ПО АНАЛИЗУ СИГНАЛОВ С САЙТОВ');
  lines.push('═'.repeat(70));
  lines.push('');
  lines.push('ОБЩАЯ СТАТИСТИКА:');
  lines.push(`  Всего сайтов протестировано:     ${total}`);
  lines.push(`  Успешно загружено:               ${ok} (${Math.round((ok / total) * 100)}%)`);
  lines.push(`    через HTTP (быстро):           ${httpCount}`);
  lines.push(`    через Playwright (fallback):   ${playwrightCount}`);
  lines.push(`  Не удалось загрузить:            ${failed} (${Math.round((failed / total) * 100)}%)`);
  lines.push(`  С обнаруженными сигналами:       ${withSignals} (${Math.round((withSignals / Math.max(1, ok)) * 100)}% от загруженных)`);
  lines.push(`  С определённым профилем:         ${withProfile} (${Math.round((withProfile / Math.max(1, ok)) * 100)}% от загруженных)`);
  lines.push(`  Среднее число сигналов на сайт:  ${avgSignalsPerSite.toFixed(1)}`);
  lines.push(`  Среднее время загрузки:          ${avgFetchMs}ms`);
  lines.push('');

  // Profile distribution
  const profileCounts = new Map<string, number>();
  for (const r of results) {
    if (!r.ok) continue;
    const key = r.profile || '(нет профиля)';
    profileCounts.set(key, (profileCounts.get(key) ?? 0) + 1);
  }
  lines.push('РАСПРЕДЕЛЕНИЕ ПРОФИЛЕЙ:');
  const profileList = [...profileCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [profile, count] of profileList) {
    const pct = Math.round((count / Math.max(1, ok)) * 100);
    lines.push(`  ${count.toString().padStart(4)} (${pct.toString().padStart(2)}%)  ${profile}`);
  }
  lines.push('');

  const signalCounts = new Map<string, number>();
  for (const r of results) {
    for (const id of r.signalIds) {
      signalCounts.set(id, (signalCounts.get(id) ?? 0) + 1);
    }
  }
  const sortedSignals = [...signalCounts.entries()].sort((a, b) => b[1] - a[1]);
  lines.push('ОБНАРУЖЕННЫЕ СИГНАЛЫ (по убыванию частоты):');
  for (const [id, count] of sortedSignals) {
    const pct = Math.round((count / Math.max(1, ok)) * 100);
    lines.push(`  ${count.toString().padStart(4)} (${pct.toString().padStart(2)}%)  ${id}`);
  }
  lines.push('');

  // Sample results per profile
  lines.push('ПРИМЕРЫ ПО КАЖДОМУ ПРОФИЛЮ (до 3 сайтов):');
  for (const [profile] of profileList) {
    if (profile === '(нет профиля)') continue;
    const examples = results.filter((r) => r.profile === profile).slice(0, 3);
    lines.push('');
    lines.push(`  >>> ${profile}`);
    for (const ex of examples) {
      lines.push(`      ${ex.normalized}`);
      lines.push(`      Стек: ${ex.stack}`);
    }
  }
  lines.push('');

  // No signals examples - quality check
  if (noSignals.length > 0) {
    lines.push('САЙТЫ БЕЗ ОБНАРУЖЕННЫХ СИГНАЛОВ (проверка качества, до 15):');
    for (const r of noSignals.slice(0, 15)) {
      lines.push(`  ${r.normalized}`);
    }
    lines.push('');
  }

  const orphanProfile = results.filter((r) => r.ok && r.signalIds.length > 0 && !r.profile);
  if (orphanProfile.length > 0) {
    lines.push(`САЙТЫ С СИГНАЛАМИ, НО БЕЗ ПРОФИЛЯ: ${orphanProfile.length} (диагностика покрытия профилей, до 10):`);
    for (const r of orphanProfile.slice(0, 10)) {
      lines.push(`  ${r.normalized}`);
      lines.push(`    Стек: ${r.stack}`);
    }
    lines.push('');
  }

  // Failed examples
  const failedSites = results.filter((r) => !r.ok);
  if (failedSites.length > 0) {
    const errorCounts = new Map<string, number>();
    for (const r of failedSites) {
      const k = r.error ?? 'unknown';
      errorCounts.set(k, (errorCounts.get(k) ?? 0) + 1);
    }
    lines.push('ОШИБКИ ЗАГРУЗКИ:');
    for (const [err, count] of [...errorCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${count.toString().padStart(4)}  ${err}`);
    }
    lines.push('');
  }

  lines.push('═'.repeat(70));
  return lines.join('\n');
}

function writeCsvOutput(results: TestResult[], path: string) {
  const rows = results.map((r) => ({
    url: r.url,
    normalized: r.normalized,
    ok: r.ok ? 'yes' : 'no',
    method: r.method ?? '',
    error: r.error ?? '',
    signal_count: r.signalIds.length,
    stack: r.stack,
    profile: r.profile,
    duration_ms: r.durationMs,
  }));
  const csv = Papa.unparse(rows);
  writeFileSync(path, csv, 'utf-8');
}

async function main() {
  console.log(`\nЧтение CSV: ${CSV_PATH}`);
  const allSites = readCsvWebsites();
  console.log(`Найдено уникальных сайтов: ${allSites.length}`);

  const sample = allSites.slice(0, SAMPLE_SIZE);
  console.log(`Тестируется: ${sample.length} сайтов (concurrency=${CONCURRENCY}, HTTP→Playwright fallback)\n`);

  const t0 = Date.now();
  const results = await runWithConcurrency(sample, CONCURRENCY);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\nЗавершено за ${elapsed}s (${(elapsed / sample.length).toFixed(2)}s на сайт в среднем)\n`);

  const report = buildReport(results);
  console.log(report);

  const outDir = resolve(__dirname, '../../');
  const reportPath = resolve(outDir, 'signal-detector-report.txt');
  const csvPath = resolve(outDir, 'signal-detector-results.csv');
  writeFileSync(reportPath, report, 'utf-8');
  writeCsvOutput(results, csvPath);
  console.log(`Отчёт сохранён: ${reportPath}`);
  console.log(`Результаты CSV:  ${csvPath}\n`);
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
