/**
 * Бэкфилл seen-журнала B2B-поиска из base_constructor_jobs.data.
 *
 * Зачем: сами файлы B2B-выгрузок мы не храним, но если клиент загружал свою
 * выгрузку в Конструктор баз — полный ИСХОДНЫЙ файл (до чисток, с колонкой
 * «ИНН») лежит в base_constructor_jobs.data. Этот скрипт достаёт оттуда ИНН,
 * резолвит их в companies_directory.id и помечает компании выгруженными
 * задним числом (source='backfill_constructor', ON CONFLICT DO NOTHING —
 * повторный запуск безопасен, первая дата сохраняется).
 *
 * Кейс: SANDS (июль 2026) — выгрузка 08.06 (403 строки) целиком лежит в его
 * job companies_2026-06-08.xlsx.
 *
 * Запуск ИЗ КОНТЕЙНЕРА portal (там есть DATABASE_URL):
 *   node scripts/backfill-seen-from-constructor.mjs \
 *     --user 81d8a009-f8bc-4fe1-953b-37cae7e2dcd6 \
 *     --job d93bcaf2-be06-4095-b54f-d101f5155f08 --date 2026-06-08 \
 *     [--dry-run]
 *
 * --job можно повторять; --date применяется ко всем указанным job'ам
 * (для разных дат — отдельные запуски). Требует применённой миграции
 * 20260712_0001 (таблица client_companies_search_seen).
 */

import { Client } from 'pg';

function parseArgs(argv) {
  const out = { jobs: [], dryRun: false, user: null, date: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') out.user = argv[++i];
    else if (a === '--job') out.jobs.push(argv[++i]);
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  if (!out.user) throw new Error('--user <uuid> обязателен');
  if (out.jobs.length === 0) throw new Error('--job <id> обязателен (можно несколько)');
  return out;
}

const INN_RE = /^\d{10}$|^\d{12}$/;
const BATCH = 1000;

async function main() {
  const args = parseArgs(process.argv);
  const exportedAt = args.date ? new Date(args.date) : new Date();
  if (Number.isNaN(exportedAt.getTime())) throw new Error(`Некорректная --date: ${args.date}`);

  const db = new Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 120_000 });
  await db.connect();

  try {
    // 1. Собираем ИНН из data указанных job'ов (с проверкой владельца).
    const inns = new Set();
    for (const jobId of args.jobs) {
      const { rows } = await db.query(
        'SELECT user_id, file_name, data FROM base_constructor_jobs WHERE id = $1',
        [jobId],
      );
      if (rows.length === 0) throw new Error(`Job ${jobId} не найден`);
      const job = rows[0];
      if (job.user_id !== args.user) {
        throw new Error(`Job ${jobId} (${job.file_name}) принадлежит другому пользователю: ${job.user_id}`);
      }
      const data = Array.isArray(job.data) ? job.data : [];
      if (data.length < 2) {
        console.warn(`! Job ${jobId} (${job.file_name}): пустые данные — пропускаю`);
        continue;
      }
      const header = data[0].map((h) => String(h ?? '').trim().toLowerCase());
      const innIdx = header.findIndex((h) => h === 'инн' || h === 'inn');
      if (innIdx < 0) {
        console.warn(`! Job ${jobId} (${job.file_name}): колонки «ИНН» нет — пропускаю`);
        continue;
      }
      let found = 0;
      for (let i = 1; i < data.length; i++) {
        const v = String(data[i]?.[innIdx] ?? '').trim();
        if (INN_RE.test(v)) { inns.add(v); found++; }
      }
      console.log(`✓ Job ${job.file_name}: строк ${data.length - 1}, валидных ИНН ${found}`);
    }
    const innList = [...inns];
    console.log(`Всего уникальных ИНН: ${innList.length}`);
    if (innList.length === 0) return;

    // 2. Резолв ИНН → companies_directory.id (idx_companies_directory_inn).
    const companyIds = [];
    const matchedInns = new Set();
    for (let i = 0; i < innList.length; i += BATCH) {
      const batch = innList.slice(i, i + BATCH);
      const { rows } = await db.query(
        'SELECT id, inn FROM companies_directory WHERE inn = ANY($1)',
        [batch],
      );
      for (const r of rows) {
        companyIds.push(r.id);
        matchedInns.add(r.inn);
      }
    }
    console.log(`Найдено в каталоге: ${companyIds.length} строк (${matchedInns.size} ИНН); не найдено ИНН: ${innList.length - matchedInns.size}`);

    if (args.dryRun) {
      console.log('[dry-run] Запись пропущена.');
      return;
    }

    // 3. Пишем журнал (идемпотентно, первая дата сохраняется).
    let inserted = 0;
    for (let i = 0; i < companyIds.length; i += BATCH) {
      const batch = companyIds.slice(i, i + BATCH);
      const res = await db.query(
        `INSERT INTO client_companies_search_seen (user_id, company_id, exported_at, source)
         SELECT $1, unnest($2::bigint[]), $3, 'backfill_constructor'
         ON CONFLICT (user_id, company_id) DO NOTHING`,
        [args.user, batch, exportedAt.toISOString()],
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(`Записано в журнал: ${inserted} (дата ${exportedAt.toISOString().slice(0, 10)}, дубли пропущены)`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
