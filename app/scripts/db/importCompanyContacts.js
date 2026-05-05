/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Одноразовый скрипт импорта контактных баз компаний из xlsx-файлов
 * в таблицу company_contacts.
 *
 * Запуск (из директории app/):
 *   node scripts/db/importCompanyContacts.js /path/to/xlsx-folder
 *
 * Требует переменную окружения DATABASE_URL (или SUPABASE_DB_URL).
 */
const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const XLSX = require('xlsx');
const dotenv = require('dotenv');

// ── загрузка .env ──────────────────────────────────────────────────
for (const f of ['.env.local', '.env', '../.env.local', '../.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), f) });
}

const BATCH_SIZE = 500;

const COLUMN_MAP = [
  'name',                // Название
  'inn',                 // ИНН
  'kpp',                 // КПП
  'address',             // Адрес
  'director_last_name',  // Фамилия руководителя
  'director_first_name', // Имя руководителя
  'director_middle_name',// Отчество руководителя
  'activity_type',       // Вид деятельности
  'employees_count',     // Количество сотрудников
  'phones',              // Телефоны
  'email',               // email
  'revenue',             // Выручка
  'cost',                // Стоимость
  'edo_id',              // Идентификатор ЭДО
  'okpo',                // ОКПО
  'pf_reg_number',       // Рег. номер ПФ
  'branch_code',         // Код филиала
  'website',             // Сайт
  'egais',               // ЕГАИС
  'gln',                 // GLN
  'ogrn',                // ОГРН
];

const DB_COLUMNS = [...COLUMN_MAP, 'source_file'];

function resolveDbUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    ''
  ).trim();
}

function buildInsertSQL(batchSize) {
  const cols = DB_COLUMNS.join(', ');
  const width = DB_COLUMNS.length; // 22
  const rows = [];
  for (let r = 0; r < batchSize; r++) {
    const placeholders = [];
    for (let c = 0; c < width; c++) {
      placeholders.push(`$${r * width + c + 1}`);
    }
    rows.push(`(${placeholders.join(',')})`);
  }
  return `INSERT INTO public.company_contacts (${cols}) VALUES ${rows.join(',')}`;
}

function parseCell(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === '' || s === ' ') return null;
  return s;
}

function parseIntCell(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? Math.round(val) : null;
  const s = String(val).trim();
  if (s === '' || s === ' ') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function rowToParams(row, sourceFile) {
  const params = [];
  for (let i = 0; i < COLUMN_MAP.length; i++) {
    const col = COLUMN_MAP[i];
    const val = row[i] !== undefined ? row[i] : null;

    if (col === 'employees_count') {
      params.push(parseIntCell(val));
    } else if (col === 'revenue' || col === 'cost') {
      params.push(parseIntCell(val));
    } else {
      params.push(parseCell(val));
    }
  }
  params.push(sourceFile);
  return params;
}

async function importFile(client, filePath) {
  const fileName = path.basename(filePath);
  console.log(`  → Читаю ${fileName}...`);

  const workbook = XLSX.readFile(filePath, { type: 'file' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  if (data.length < 2) {
    console.log(`    Пропускаю ${fileName}: нет данных`);
    return 0;
  }

  const rows = data.slice(1); // пропускаем заголовок
  let imported = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const actualSize = batch.length;

    const sql = buildInsertSQL(actualSize);
    const params = [];
    for (const row of batch) {
      params.push(...rowToParams(row, fileName));
    }

    await client.query(sql, params);
    imported += actualSize;

    if (imported % 10000 === 0 || i + BATCH_SIZE >= rows.length) {
      console.log(`    ${fileName}: ${imported}/${rows.length}`);
    }
  }

  return imported;
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Укажите путь к папке с xlsx-файлами: node scripts/db/importCompanyContacts.js /path/to/folder');
    process.exit(1);
  }

  const absFolder = path.resolve(folder);
  if (!fs.existsSync(absFolder)) {
    console.error(`Папка не найдена: ${absFolder}`);
    process.exit(1);
  }

  const files = fs.readdirSync(absFolder)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort();

  console.log(`Найдено ${files.length} xlsx-файлов в ${absFolder}`);

  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    console.error('DATABASE_URL / SUPABASE_DB_URL не задан');
    process.exit(1);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: dbUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('Подключение к БД установлено');

  let totalImported = 0;

  for (const file of files) {
    const filePath = path.join(absFolder, file);
    try {
      const count = await importFile(client, filePath);
      totalImported += count;
      console.log(`  ✓ ${file}: ${count} строк`);
    } catch (err) {
      console.error(`  ✗ Ошибка при импорте ${file}:`, err.message);
    }
  }

  await client.end();
  console.log(`\nИмпорт завершён. Всего импортировано: ${totalImported} строк`);
}

main().catch(err => {
  console.error('Фатальная ошибка:', err);
  process.exit(1);
});
