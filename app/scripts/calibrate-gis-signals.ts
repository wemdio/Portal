import dotenv from 'dotenv';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import Papa from 'papaparse';

// .env лежит в корне репо; скрипт собирается в app/dist/scripts и запускается
// из корня: `node app/dist/scripts/calibrate-gis-signals.cjs`.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env') });

import {
  detectOutreachSignals,
  emptySignals,
  SIGNAL_COLUMNS,
  type OutreachSignalSet,
  type SignalVerdict,
} from '../src/lib/gisSignalOutreach/signals';

/**
 * Калибровка детектора outreach-сигналов против референсного CSV клиента
 * (518 мебельных компаний Москвы, вердикты Да/Нет по 6 сигналам).
 *
 * Берём ПЕРВЫЕ N строк с непустым `сайт`, прогоняем detectOutreachSignals
 * (реальная сеть, concurrency 3, сторожевой таймаут 45s на сайт) и сравниваем
 * наши вердикты с референсными. Референс сам машинный — расхождения это
 * кандидаты на ревью, а не автоматически баги детектора.
 *
 * llmExtract НЕ передаём: дефолтный добор fail-open — при наличии ключа
 * OPENROUTER_* сделает один реальный вызов gpt-4o-mini на сайт (как в проде),
 * без ключа мгновенно вернёт null.
 *
 * Запуск: см. README-блок в отчёте. Паттерн повторяет test-signal-detector.ts.
 */

const CSV_PATH = process.argv[2] ?? resolve(process.cwd(), '.tmp/gis-signals-reference.csv');
const LIMIT = Number(process.argv[3] ?? '40');
const CONCURRENCY = Number(process.argv[4] ?? '3');
const SITE_TIMEOUT_MS = 45_000;

const OUT_MD = resolve(process.cwd(), '.tmp/gis-signals-calibration.md');
const OUT_JSON = resolve(process.cwd(), '.tmp/gis-signals-calibration.json');

type SignalKey = keyof OutreachSignalSet;

interface RefRow {
  id: string;
  company: string;
  site: string;
  checkedUrl: string;
  phone: string;
  ref: Record<SignalKey, { hit: boolean; evidence: string }>;
  refNote: string;
}

interface RowRun extends RefRow {
  ok: boolean;
  timedOut: boolean;
  note: string;
  signalsCount: number;
  ours: Record<SignalKey, SignalVerdict>;
  llmFailed: boolean;
  durationMs: number;
}

function readReferenceRows(): RefRow[] {
  const raw = readFileSync(CSV_PATH, 'utf-8');
  const parsed = Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true });

  const rows: RefRow[] = [];
  for (const row of parsed.data) {
    const site = (row['сайт'] ?? '').trim();
    if (!site) continue;
    const ref = {} as RefRow['ref'];
    for (const col of SIGNAL_COLUMNS) {
      ref[col.key] = {
        hit: (row[col.title] ?? '').trim() === 'Да',
        evidence: (row[`${col.title} — уточнение`] ?? '').trim(),
      };
    }
    rows.push({
      id: (row['id'] ?? '').trim(),
      company: (row['компания'] ?? '').trim(),
      site,
      checkedUrl: (row['Проверенный сайт'] ?? '').trim(),
      // Телефонов в ячейке может быть несколько через запятую — берём первый.
      phone: (row['phone'] ?? '').split(',')[0].trim(),
      ref,
      refNote: (row['Проверка — примечание'] ?? '').trim(),
    });
    if (rows.length >= LIMIT) break;
  }
  return rows;
}

/** Сторожевой таймаут на сайт: null = уложились, 'timeout' = срезали. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), ms);
  });
  const out = await Promise.race([promise, guard]);
  clearTimeout(timer);
  return out;
}

// Ключи набора перечислены ТОЛЬКО в signals.ts (emptySignals) — иначе каждый
// новый сигнал ломал бы компиляцию всех калибраторов сразу.
function emptyOurs(): Record<SignalKey, SignalVerdict> {
  return emptySignals();
}

async function processRow(row: RefRow): Promise<RowRun> {
  const start = Date.now();
  const result = await withTimeout(
    detectOutreachSignals({ siteUrl: row.site, twogisPhone: row.phone || null }),
    SITE_TIMEOUT_MS,
  );
  const durationMs = Date.now() - start;

  if (result === 'timeout') {
    return {
      ...row, ok: false, timedOut: true, note: `Timeout ${SITE_TIMEOUT_MS / 1000}s`,
      signalsCount: 0, ours: emptyOurs(), llmFailed: false, durationMs,
    };
  }

  return {
    ...row,
    ok: result.ok,
    timedOut: false,
    note: result.note,
    signalsCount: result.signalsCount,
    ours: result.signals,
    llmFailed: result.note.includes('LLM fallback failed'),
    durationMs,
  };
}

async function runWithConcurrency(rows: RefRow[], limit: number): Promise<RowRun[]> {
  const results: RowRun[] = new Array(rows.length);
  let idx = 0;
  let completed = 0;

  async function worker() {
    while (idx < rows.length) {
      const myIdx = idx++;
      const row = rows[myIdx];
      try {
        results[myIdx] = await processRow(row);
      } catch (err) {
        results[myIdx] = {
          ...row, ok: false, timedOut: false,
          note: `Script error: ${err instanceof Error ? err.message : 'unknown'}`,
          signalsCount: 0, ours: emptyOurs(), llmFailed: false, durationMs: 0,
        };
      }
      completed++;
      const r = results[myIdx];
      process.stdout.write(
        `  [${completed}/${rows.length}] ${row.site} — ${r.ok ? `ok, сигналов: ${r.signalsCount}` : r.note}\n`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, () => worker()));
  return results;
}

function mdCell(value: string, max = 140): string {
  const t = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function verdict(v: { hit: boolean }): string {
  return v.hit ? 'Да' : 'Нет';
}

function buildReport(results: RowRun[], elapsedSec: number): string {
  const reachable = results.filter((r) => r.ok);
  const unreachable = results.filter((r) => !r.ok);
  const avgSignals =
    results.reduce((sum, r) => sum + r.signalsCount, 0) / Math.max(1, results.length);
  const llmFailedCount = results.filter((r) => r.llmFailed).length;

  const lines: string[] = [];
  lines.push('# Калибровка gisSignalOutreach против референсного CSV');
  lines.push('');
  lines.push(`- Вход: первые ${results.length} строк с непустым \`сайт\` из \`.tmp/gis-signals-reference.csv\` (мебельные компании Москвы).`);
  lines.push(`- Прогон: \`detectOutreachSignals({ siteUrl, twogisPhone: phone })\`, реальная сеть, concurrency=${CONCURRENCY}, сторожевой таймаут ${SITE_TIMEOUT_MS / 1000}s на сайт. Время прогона: ${elapsedSec}s.`);
  lines.push(`- llmExtract не передавался — дефолтный LLM-добор (gpt-4o-mini через Requesty, ключ OPENROUTER_* из .env) работал как в проде; fail-open сработал у ${llmFailedCount} сайтов.`);
  lines.push(`- Недоступно сайтов (ok:false): **${unreachable.length}/${results.length}**${unreachable.some((r) => r.timedOut) ? ` (в т.ч. по таймауту: ${unreachable.filter((r) => r.timedOut).length})` : ''}.`);
  lines.push(`- Средний signalsCount на компанию: **${avgSignals.toFixed(2)}** (по всем ${results.length}; по reachable: ${(reachable.reduce((s, r) => s + r.signalsCount, 0) / Math.max(1, reachable.length)).toFixed(2)}).`);
  lines.push(`- Сравнение идёт по reachable сайтам (N=${reachable.length}); недоступные исключены из метрик согласия.`);
  lines.push('- ВАЖНО: референс машинный и неточный — расхождения это кандидаты на ревью, а не автоматически баги детектора.');
  lines.push('');

  // ── Согласие по сигналам ──
  lines.push('## Согласие по сигналам');
  lines.push('');
  lines.push('| Сигнал | Согласие | Совпало | мы=Да / реф=Нет | мы=Нет / реф=Да | реф=Да всего | мы=Да всего |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  let totalAgree = 0;
  let totalCells = 0;
  for (const col of SIGNAL_COLUMNS) {
    let agree = 0, fp = 0, fn = 0, refYes = 0, ourYes = 0;
    for (const r of reachable) {
      const our = r.ours[col.key].hit;
      const refHit = r.ref[col.key].hit;
      if (our === refHit) agree++;
      else if (our && !refHit) fp++;
      else fn++;
      if (refHit) refYes++;
      if (our) ourYes++;
    }
    totalAgree += agree;
    totalCells += reachable.length;
    const pct = reachable.length ? Math.round((agree / reachable.length) * 100) : 0;
    lines.push(`| ${col.title} | ${pct}% | ${agree}/${reachable.length} | ${fp} | ${fn} | ${refYes} | ${ourYes} |`);
  }
  lines.push(`| **ИТОГО по всем ячейкам** | **${totalCells ? Math.round((totalAgree / totalCells) * 100) : 0}%** | ${totalAgree}/${totalCells} | — | — | — | — |`);
  lines.push('');

  // ── Худшие расхождения ──
  interface Mismatch {
    run: RowRun;
    key: SignalKey;
    title: string;
    kind: 'мы=Да/реф=Нет' | 'мы=Нет/реф=Да';
  }
  const mismatchCountByRun = new Map<RowRun, number>();
  const mismatches: Mismatch[] = [];
  for (const r of reachable) {
    let count = 0;
    for (const col of SIGNAL_COLUMNS) {
      const our = r.ours[col.key].hit;
      const refHit = r.ref[col.key].hit;
      if (our !== refHit) {
        count++;
        mismatches.push({
          run: r, key: col.key, title: col.title,
          kind: our ? 'мы=Да/реф=Нет' : 'мы=Нет/реф=Да',
        });
      }
    }
    mismatchCountByRun.set(r, count);
  }
  mismatches.sort((a, b) =>
    (mismatchCountByRun.get(b.run) ?? 0) - (mismatchCountByRun.get(a.run) ?? 0),
  );

  lines.push(`## Худшие расхождения (top-${Math.min(15, mismatches.length)} из ${mismatches.length}, только reachable)`);
  lines.push('');
  if (mismatches.length === 0) {
    lines.push('Расхождений нет.');
  } else {
    lines.push('| # | Компания | Сайт | Сигнал | Тип | Мы (evidence) | Референс (evidence) |');
    lines.push('| ---: | --- | --- | --- | --- | --- | --- |');
    mismatches.slice(0, 15).forEach((m, i) => {
      const our = m.run.ours[m.key];
      const refV = m.run.ref[m.key];
      lines.push(
        `| ${i + 1} | ${mdCell(m.run.company, 40)} | ${mdCell(m.run.site, 40)} | ${m.title} | ${m.kind} | ${verdict(our)} — ${mdCell(our.evidence, 100)} | ${verdict(refV)} — ${mdCell(refV.evidence, 100)} |`,
      );
    });
  }
  lines.push('');

  // ── Недоступные сайты ──
  lines.push(`## Недоступные сайты (${unreachable.length})`);
  lines.push('');
  if (unreachable.length === 0) {
    lines.push('Все сайты были reachable.');
  } else {
    lines.push('| Компания | Сайт (из CSV) | Проверенный сайт | note |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of unreachable) {
      lines.push(`| ${mdCell(r.company, 40)} | ${mdCell(r.site, 45)} | ${mdCell(r.checkedUrl, 45)} | ${mdCell(r.note, 60)} |`);
    }
  }
  lines.push('');

  // ── Детальная сводка по всем строкам ──
  lines.push('## Детально по строкам');
  lines.push('');
  const headerCells = SIGNAL_COLUMNS.map((c) => c.title.slice(0, 18)).join(' / ');
  lines.push(`Легенда: ✅ = сработал, — = нет. Порядок колонок: ${headerCells}`);
  lines.push('');
  for (const r of results) {
    const marks = SIGNAL_COLUMNS.map((c) => (r.ours[c.key].hit ? '✅' : '—')).join(' ');
    const refMarks = SIGNAL_COLUMNS.map((c) => (r.ref[c.key].hit ? '✅' : '—')).join(' ');
    lines.push(`- ${r.company} (${r.site}) — ${r.ok ? `ok, note: ${r.note}` : `FAIL: ${r.note}`}`);
    lines.push(`  - мы: ${marks} (signalsCount=${r.signalsCount}); реф: ${refMarks}`);
  }
  lines.push('');

  return lines.join('\n');
}

async function main() {
  console.log(`\nЧтение референса: ${CSV_PATH}`);
  const rows = readReferenceRows();
  console.log(`Строк к прогону: ${rows.length} (concurrency=${CONCURRENCY}, timeout=${SITE_TIMEOUT_MS / 1000}s/сайт)\n`);

  const t0 = Date.now();
  const results = await runWithConcurrency(rows, CONCURRENCY);
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  console.log(`\nПрогон завершён за ${elapsedSec}s\n`);

  writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf-8');
  const report = buildReport(results, elapsedSec);
  writeFileSync(OUT_MD, report, 'utf-8');
  console.log(`Отчёт:  ${OUT_MD}`);
  console.log(`Данные: ${OUT_JSON}\n`);

  // Краткая сводка в stdout.
  const reachable = results.filter((r) => r.ok);
  console.log(`Недоступно: ${results.length - reachable.length}/${results.length}`);
  for (const col of SIGNAL_COLUMNS) {
    let agree = 0, fp = 0, fn = 0;
    for (const r of reachable) {
      const our = r.ours[col.key].hit;
      const refHit = r.ref[col.key].hit;
      if (our === refHit) agree++;
      else if (our) fp++;
      else fn++;
    }
    const pct = reachable.length ? Math.round((agree / reachable.length) * 100) : 0;
    console.log(`  ${col.title}: ${pct}% (${agree}/${reachable.length}), мы=Да/реф=Нет: ${fp}, мы=Нет/реф=Да: ${fn}`);
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
