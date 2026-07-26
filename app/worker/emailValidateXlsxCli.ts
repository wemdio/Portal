/**
 * Standalone CLI: валидирует Email-колонку в xlsx через тот же движок, что и
 * портальный worker (app/src/lib/emailValidation/validator.ts).
 *
 * Использование:
 *   node --env-file=../.env dist/workers/emailValidateXlsxCli.js \
 *        "input.xlsx" "output.xlsx" [--column Email] [--concurrency 20]
 *
 * Требует env:
 *   SMTP_PROXY_URLS      csv-список http-прокси со /smtp-check endpoint
 *   SMTP_PROXY_API_KEY   Bearer для прокси
 *
 * Что делает:
 *   1. Читает первый лист xlsx.
 *   2. Находит уникальные email из указанной колонки.
 *   3. Прогоняет validateEmail() с общим domainCache (MX/catch-all lookup 1× на домен).
 *   4. Пишет xlsx: оригинальные колонки + добавленные "Валидация", "Качество", …
 */

import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { validateEmail, normalizeEmail } from '@/lib/emailValidation/validator';
import type { DomainInfo, ValidationResult } from '@/lib/emailValidation/shared';

const RESULT_LABEL_RU: Record<ValidationResult['result'], string> = {
  ok: 'Валидный',
  invalid: 'Невалидный',
  disposable: 'Одноразовый',
  catch_all: 'Catch-all (домен принимает всё)',
  unknown: 'Не удалось проверить',
};

const QUALITY_LABEL_RU: Record<ValidationResult['quality'], string> = {
  good: 'Хороший',
  bad: 'Плохой',
  risky: 'Рискованный',
};

type InputRow = Record<string, unknown> & { __rowIndex: number };

function ynRu(v: boolean): string { return v ? 'Да' : 'Нет'; }

async function readInput(inputPath: string, emailCol: string): Promise<{
  headers: string[];
  rows: InputRow[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inputPath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('В xlsx нет листов');

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? '').trim();
  });

  if (!headers.includes(emailCol)) {
    throw new Error(
      `В xlsx нет колонки "${emailCol}". Есть: ${headers.filter(Boolean).join(', ')}`,
    );
  }

  const rows: InputRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const rec: InputRow = { __rowIndex: rowNumber - 1 };
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const key = headers[colNumber - 1];
      if (!key) return;
      let v: unknown = cell.value;
      if (v && typeof v === 'object' && 'text' in (v as any)) v = (v as any).text;
      if (v && typeof v === 'object' && 'result' in (v as any)) v = (v as any).result;
      if (v && typeof v === 'object' && 'richText' in (v as any)) {
        v = (v as any).richText.map((t: any) => t.text).join('');
      }
      rec[key] = v;
    });
    rows.push(rec);
  });
  return { headers, rows };
}

/**
 * Промышленная валидация: работаем пулом из N воркеров, общий domainCache,
 * общий счётчик прогресса, сохранение промежуточных результатов на диск.
 */
async function validateAll(
  emails: string[],
  concurrency: number,
  onProgress: (done: number, total: number, rate: number) => void,
  cachePath: string,
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();
  const domainCache = new Map<string, DomainInfo>();

  // Восстановление кэша если крашнулись раньше
  if (fs.existsSync(cachePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [k, v] of Object.entries(raw)) results.set(k, v as ValidationResult);
      console.log(`[cache] Восстановлено ${results.size} готовых результатов из ${cachePath}`);
    } catch { /* пусто/битый файл — начинаем с нуля */ }
  }

  const queue = emails.filter((e) => !results.has(e));
  if (queue.length === 0) return results;

  const total = emails.length;
  const startedAt = Date.now();
  let nextIndex = 0;
  let sinceLastSave = 0;

  const saveCache = () => {
    const obj: Record<string, ValidationResult> = {};
    for (const [k, v] of results) obj[k] = v;
    fs.writeFileSync(cachePath, JSON.stringify(obj));
  };

  const worker = async (workerId: number) => {
    void workerId;
    while (nextIndex < queue.length) {
      const idx = nextIndex++;
      const email = queue[idx];
      try {
        const r = await validateEmail(email, domainCache);
        results.set(email, r);
      } catch (err) {
        results.set(email, {
          result: 'unknown', quality: 'risky',
          is_free: false, is_role: false, is_disposable: false, is_catch_all: false,
          did_you_mean: null, mx_found: false, smtp_code: 0,
          details: { fatal: err instanceof Error ? err.message : String(err) },
          error: err instanceof Error ? err.message : String(err),
        });
      }
      sinceLastSave++;
      const done = results.size;
      if (done % 100 === 0) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rate = (done - (total - queue.length)) / Math.max(1, elapsedSec);
        onProgress(done, total, rate);
      }
      if (sinceLastSave >= 500) {
        sinceLastSave = 0;
        try { saveCache(); } catch { /* игнор */ }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, (_, i) => worker(i)));
  try { saveCache(); } catch { /* игнор */ }
  return results;
}

async function writeOutput(
  outputPath: string,
  headers: string[],
  rows: InputRow[],
  emailCol: string,
  results: Map<string, ValidationResult>,
) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Portal email validator CLI';
  wb.created = new Date();

  const ws = wb.addWorksheet('Validation');

  // Оригинальные заголовки + новые
  const extraHeaders = [
    'Email (нормализованный)',
    'Валидация',
    'Качество',
    'MX найден',
    'Бесплатный провайдер',
    'Ролевой ящик',
    'Одноразовый',
    'Catch-all',
    'SMTP код',
    'Опечатка (did_you_mean)',
    'Ошибка',
  ];
  const allHeaders = [...headers, ...extraHeaders];
  ws.columns = allHeaders.map((h) => ({ header: h, key: h, width: Math.min(40, Math.max(12, h.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    const rawEmail = String(row[emailCol] ?? '').trim();
    const norm = normalizeEmail(rawEmail);
    const r = norm ? results.get(norm) : null;
    const record: Record<string, unknown> = {};
    for (const h of headers) record[h] = row[h] ?? '';
    if (r) {
      record['Email (нормализованный)'] = norm;
      record['Валидация'] = RESULT_LABEL_RU[r.result];
      record['Качество'] = QUALITY_LABEL_RU[r.quality];
      record['MX найден'] = ynRu(r.mx_found);
      record['Бесплатный провайдер'] = ynRu(r.is_free);
      record['Ролевой ящик'] = ynRu(r.is_role);
      record['Одноразовый'] = ynRu(r.is_disposable);
      record['Catch-all'] = ynRu(r.is_catch_all);
      record['SMTP код'] = r.smtp_code || '';
      record['Опечатка (did_you_mean)'] = r.did_you_mean ?? '';
      record['Ошибка'] = r.error ?? '';
    } else {
      record['Email (нормализованный)'] = norm ?? '';
      record['Валидация'] = 'Пустой/невалидный формат';
      record['Качество'] = 'Плохой';
      record['MX найден'] = 'Нет';
      record['Бесплатный провайдер'] = '';
      record['Ролевой ящик'] = '';
      record['Одноразовый'] = '';
      record['Catch-all'] = '';
      record['SMTP код'] = '';
      record['Опечатка (did_you_mean)'] = '';
      record['Ошибка'] = 'Не удалось нормализовать email';
    }
    ws.addRow(record);
  }

  // Summary sheet
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Метрика', key: 'k', width: 40 },
    { header: 'Значение', key: 'v', width: 20 },
  ];
  const counts: Record<string, number> = {
    ok: 0, invalid: 0, disposable: 0, catch_all: 0, unknown: 0,
  };
  let good = 0, risky = 0, bad = 0, roleN = 0, freeN = 0, catchN = 0;
  for (const row of rows) {
    const norm = normalizeEmail(String(row[emailCol] ?? '').trim());
    const r = norm ? results.get(norm) : null;
    if (!r) { counts.invalid += 1; bad += 1; continue; }
    counts[r.result] = (counts[r.result] ?? 0) + 1;
    if (r.quality === 'good') good += 1;
    else if (r.quality === 'risky') risky += 1;
    else bad += 1;
    if (r.is_role) roleN += 1;
    if (r.is_free) freeN += 1;
    if (r.is_catch_all) catchN += 1;
  }
  summary.addRows([
    { k: 'Всего строк', v: rows.length },
    { k: 'Уникальных email', v: results.size },
    { k: '', v: '' },
    { k: 'Валидных (ok)', v: counts.ok },
    { k: 'Невалидных (invalid)', v: counts.invalid },
    { k: 'Одноразовых (disposable)', v: counts.disposable },
    { k: 'Catch-all', v: counts.catch_all },
    { k: 'Не удалось проверить (unknown)', v: counts.unknown },
    { k: '', v: '' },
    { k: 'Качество: хороший (good)', v: good },
    { k: 'Качество: рискованный (risky)', v: risky },
    { k: 'Качество: плохой (bad)', v: bad },
    { k: '', v: '' },
    { k: 'Ролевые ящики (info@, sales@…)', v: roleN },
    { k: 'Бесплатные провайдеры (gmail, yandex…)', v: freeN },
    { k: 'Catch-all адреса', v: catchN },
  ]);
  summary.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(outputPath);
}

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let emailCol = 'Email';
  let concurrency = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--column') { emailCol = argv[++i]; continue; }
    if (a === '--concurrency') { concurrency = Number(argv[++i]); continue; }
    positional.push(a);
  }
  const [inputArg, outputArg] = positional;
  if (!inputArg || !outputArg) {
    console.error('Usage: node emailValidateXlsxCli.js <input.xlsx> <output.xlsx> [--column Email] [--concurrency 20]');
    process.exit(2);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg);
  const cachePath = outputPath.replace(/\.xlsx$/i, '.cache.json');

  console.log(`[email-cli] Input     : ${inputPath}`);
  console.log(`[email-cli] Output    : ${outputPath}`);
  console.log(`[email-cli] Cache     : ${cachePath}`);
  console.log(`[email-cli] Col       : ${emailCol}`);
  console.log(`[email-cli] Concur    : ${concurrency}`);
  console.log(`[email-cli] SMTP prox : ${process.env.SMTP_PROXY_URLS ? 'set' : 'MISSING'}`);
  console.log('');

  if (!process.env.SMTP_PROXY_URLS && !process.env.SMTP_PROXY_URL) {
    console.error('SMTP_PROXY_URLS не задан — прямое SMTP отключено в валидаторе. Прерываю.');
    process.exit(3);
  }

  console.log('[email-cli] Читаю xlsx...');
  const { headers, rows } = await readInput(inputPath, emailCol);
  console.log(`[email-cli] Строк: ${rows.length}, колонок: ${headers.length}`);

  const rawEmails = rows.map((r) => String(r[emailCol] ?? '').trim()).filter(Boolean);
  const uniqueSet = new Set<string>();
  for (const e of rawEmails) {
    const n = normalizeEmail(e);
    if (n) uniqueSet.add(n);
  }
  const uniqueEmails = Array.from(uniqueSet);
  console.log(`[email-cli] Уникальных email после нормализации: ${uniqueEmails.length}`);
  console.log('');
  console.log('[email-cli] Стартую валидацию...');
  console.log('');

  const startedAt = Date.now();
  const results = await validateAll(uniqueEmails, concurrency, (done, total, rate) => {
    const remaining = total - done;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
    const etaMin = Math.floor(etaSec / 60);
    const etaS = etaSec % 60;
    console.log(
      `[email-cli] progress: ${done}/${total} (${((done / total) * 100).toFixed(1)}%) — ${rate.toFixed(1)}/s — ETA ${etaMin}:${String(etaS).padStart(2, '0')}`,
    );
  }, cachePath);
  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`[email-cli] Валидация завершена за ${took}s. Уникальных: ${results.size}`);

  // Распределение
  const dist: Record<string, number> = {};
  for (const r of results.values()) dist[r.result] = (dist[r.result] ?? 0) + 1;
  for (const [k, v] of Object.entries(dist)) console.log(`  ${k.padEnd(12)} ${v}`);

  console.log('');
  console.log('[email-cli] Пишу xlsx...');
  await writeOutput(outputPath, headers, rows, emailCol, results);
  console.log(`[email-cli] Saved → ${outputPath}`);
  try { fs.unlinkSync(cachePath); } catch { /* ok */ }
}

main().catch((err) => {
  console.error('[email-cli] FAILED:', err);
  process.exit(1);
});
