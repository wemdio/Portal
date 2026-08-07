import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';

type Scalar = string | null;

type CatalogRow = {
  yandex_id: string;
  name?: Scalar;
  categories?: Scalar;
  subcategories?: Scalar;
  query?: Scalar;
  country?: Scalar;
  region?: Scalar;
  district?: Scalar;
  city?: Scalar;
  address?: Scalar;
  postal_code?: Scalar;
  phone?: Scalar;
  mobile_phone?: Scalar;
  all_phones?: Scalar;
  email?: Scalar;
  website?: Scalar;
  all_sites?: Scalar;
  working_hours?: Scalar;
  payment_methods?: Scalar;
  attributes?: Scalar;
  latitude?: Scalar;
  longitude?: Scalar;
  rating?: Scalar;
  reviews_count?: Scalar;
  network_id?: Scalar;
  network_name?: Scalar;
  telegram?: Scalar;
  vkontakte?: Scalar;
  odnoklassniki?: Scalar;
  facebook?: Scalar;
  instagram?: Scalar;
  youtube?: Scalar;
  twitter?: Scalar;
  viber?: Scalar;
  whatsapp?: Scalar;
  fax?: Scalar;
  rutube?: Scalar;
  yandex_zen?: Scalar;
  card_url?: Scalar;
  booking_url?: Scalar;
  order_url?: Scalar;
  priority_placement?: Scalar;
  logo?: Scalar;
  source_extra?: Record<string, string>;
  source_kind: 'csv' | 'region' | 'rubric';
  source_file: string;
  source_row: number;
};

const DATA_ROOT = process.env.YANDEX_MAPS_CATALOG_SOURCE_DIR?.trim() || '';
let sourceRoot = DATA_ROOT;
const DATABASE_URL = process.env.YANDEX_MAPS_CATALOG_DATABASE_URL?.trim()
  || process.env.SUPABASE_DB_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || '';

const TARGET_COLUMNS = [
  'yandex_id', 'name', 'categories', 'subcategories', 'query', 'country', 'region', 'district', 'city',
  'address', 'postal_code', 'phone', 'mobile_phone', 'all_phones', 'email', 'website', 'all_sites',
  'working_hours', 'payment_methods', 'attributes', 'latitude', 'longitude', 'rating', 'reviews_count',
  'network_id', 'network_name', 'telegram', 'vkontakte', 'odnoklassniki', 'facebook', 'instagram',
  'youtube', 'twitter', 'viber', 'whatsapp', 'fax', 'rutube', 'yandex_zen', 'card_url', 'booking_url',
  'order_url', 'priority_placement', 'logo', 'source_extra', 'source_kind', 'source_file', 'source_row',
] as const;

const DATA_COLUMNS = TARGET_COLUMNS.slice(0, -4);

const HEADER_ALIASES: Record<string, keyof CatalogRow> = {
  'id': 'yandex_id',
  'название': 'name',
  'категории': 'categories',
  'рубрика': 'categories',
  'подрубрика': 'subcategories',
  'запрос': 'query',
  'страна': 'country',
  'регион': 'region',
  'район': 'district',
  'город': 'city',
  'полный адрес': 'address',
  'адрес': 'address',
  'индекс': 'postal_code',
  'мобильные': 'mobile_phone',
  'мобильный телефон': 'mobile_phone',
  'немобильные': 'phone',
  'телефон': 'phone',
  'все телефоны': 'all_phones',
  'email': 'email',
  'email с сайта компании': 'email',
  'сайт': 'website',
  'все сайты': 'all_sites',
  'график': 'working_hours',
  'время работы': 'working_hours',
  'способы оплаты': 'payment_methods',
  'атрибуты': 'attributes',
  'широта': 'latitude',
  'долгота': 'longitude',
  'оценок': 'reviews_count',
  'кол-во оценок': 'reviews_count',
  'отзывов': 'reviews_count',
  'кол-во отзывов': 'reviews_count',
  'рейтинг': 'rating',
  'id сети': 'network_id',
  'сеть': 'network_name',
  'вконтакте': 'vkontakte',
  'одноклассники': 'odnoklassniki',
  'facebook': 'facebook',
  'instagram': 'instagram',
  'youtube': 'youtube',
  'twitter': 'twitter',
  'telegram': 'telegram',
  'viber': 'viber',
  'whatsapp': 'whatsapp',
  'факс': 'fax',
  'rutube': 'rutube',
  'yandex zen': 'yandex_zen',
  'карточка организации': 'card_url',
  'ссылка на онлайн-запись': 'booking_url',
  'ссылка на оформление заказа': 'order_url',
  'приоритетное размещение': 'priority_placement',
  'логотип': 'logo',
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const candidate = value as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (candidate.text !== undefined) return asText(candidate.text);
    if (candidate.result !== undefined) return asText(candidate.result);
    if (candidate.hyperlink !== undefined) return asText(candidate.hyperlink);
  }
  return String(value).replace(/\u0000/g, '').trim();
}

function normalizeHeader(value: unknown): string {
  return asText(value).replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim().toLowerCase();
}

function sourceKind(filePath: string): CatalogRow['source_kind'] {
  const rel = relative(sourceRoot, filePath).split(sep);
  if (extname(filePath).toLowerCase() === '.csv') return 'csv';
  return rel.some((part) => part.toLowerCase().includes('рубрик')) ? 'rubric' : 'region';
}

// Лист региона/района («Алтайский край.xlsx», «Агдамский район.xlsx») содержит
// организации, не попавшие ни в один городской лист. Их город неизвестен —
// подставлять сюда название региона нельзя, иначе фильтр по городу выдаст
// «Алтайский край» как город.
const NON_CITY_LEAF = /(^|\s)(область|край|район|округ|республика|аобл|ао)$/i;

type PathGeo = { country?: string; region?: string; city?: string };

/**
 * В xlsx-выгрузках нет колонки «Страна» — она есть только в 4 CSV. Зато страна
 * (а для разбивки по регионам ещё регион и город) закодирована в пути файла:
 *   Разбивка по регионам\<Страна>\<Регион>\<Город>.xlsx
 *   Разбивка по регионам\<Страна>\<Город>.xlsx
 *   Разбивка по рубрикам\<Страна>\<Рубрика>\<Подрубрика>.xlsx
 * Возвращаем только то, что реально следует из пути; регион и город — как
 * запасной вариант, колонка из файла всегда приоритетнее (см. rowFromValues).
 */
function geoFromPath(filePath: string): PathGeo {
  const rel = relative(sourceRoot, filePath).split(sep);
  if (rel.length < 2 || !rel[0].toLowerCase().includes('разбивка')) return {};
  const country = rel[1]?.trim();
  if (!country) return {};
  // В разбивке по рубрикам сегменты после страны — дерево рубрик, не география.
  if (rel[0].toLowerCase().includes('рубрик')) return { country };

  const leaf = basename(rel[rel.length - 1], extname(rel[rel.length - 1])).trim();
  const region = rel.length >= 4 ? rel[2]?.trim() : undefined;
  const isCity = Boolean(leaf) && leaf !== region && leaf !== country && !NON_CITY_LEAF.test(leaf);
  return { country, region, city: isCity ? leaf : undefined };
}

function sourceExtra(headers: string[], row: unknown[]): Record<string, string> {
  const extra: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (!HEADER_ALIASES[header]) {
      const value = asText(row[index]);
      if (header && value) extra[header] = value;
    }
  });
  return extra;
}

// Путь разбирается один раз на файл, а не на каждую из 20 млн строк.
type FileMeta = { kind: CatalogRow['source_kind']; rel: string; geo: PathGeo };
const fileMetaCache = new Map<string, FileMeta>();

function fileMeta(filePath: string): FileMeta {
  let meta = fileMetaCache.get(filePath);
  if (!meta) {
    meta = { kind: sourceKind(filePath), rel: relative(sourceRoot, filePath), geo: geoFromPath(filePath) };
    fileMetaCache.set(filePath, meta);
  }
  return meta;
}

function rowFromValues(headers: string[], values: unknown[], filePath: string, rowNumber: number): CatalogRow | null {
  const result: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    const field = HEADER_ALIASES[header];
    if (field) result[field] = asText(values[index]);
  });
  const yandexId = asText(result.yandex_id);
  if (!yandexId) return null;

  const meta = fileMeta(filePath);
  const row: CatalogRow = {
    yandex_id: yandexId,
    source_kind: meta.kind,
    source_file: meta.rel,
    source_row: rowNumber,
  };
  for (const column of DATA_COLUMNS) {
    if (column === 'yandex_id' || column === 'source_extra') continue;
    const value = asText(result[column]);
    if (value) (row as Record<string, unknown>)[column] = value;
  }

  // Колонка из файла всегда приоритетнее пути: путь только закрывает пробелы.
  if (!row.country && meta.geo.country) row.country = meta.geo.country;
  if (!row.region && meta.geo.region) row.region = meta.geo.region;
  if (!row.city && meta.geo.city) row.city = meta.geo.city;
  // В xlsx нет ссылки на карточку, а Яндекс открывает организацию по одному ID.
  // Без ссылки не работает фоновое дообновление: оно отбирает строки с card_url.
  if (!row.card_url) row.card_url = `https://yandex.ru/maps/org/${yandexId}`;

  const extra = sourceExtra(headers, values);
  if (Object.keys(extra).length) row.source_extra = extra;
  return row;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (/\.(csv|xlsx)$/i.test(entry.name)) out.push(filePath);
    }
  }
  await visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

async function buildSourceKey(files: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    const info = await stat(file);
    hash.update(relative(sourceRoot, file));
    hash.update(String(info.size));
    hash.update(String(info.mtimeMs));
  }
  return hash.digest('hex');
}

function copyField(value: unknown): string {
  if (value === null || value === undefined || value === '') return '\\N';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function rowToCopy(row: CatalogRow): string {
  return TARGET_COLUMNS.map((column) => {
    if (column === 'source_extra') return copyField(row.source_extra ?? {});
    return copyField((row as Record<string, unknown>)[column]);
  }).join(',') + '\n';
}

const STAGE_COLUMNS = TARGET_COLUMNS.map((column) => {
  if (column === 'source_extra') return `${column} jsonb`;
  if (column === 'source_row') return `${column} integer`;
  return `${column} text`;
}).join(',\n');

const INSERT_COLUMNS: string[] = [
  ...DATA_COLUMNS,
  'source_extra', 'source_kinds', 'source_files', 'source_occurrences',
  'last_source_kind', 'last_source_file', 'last_source_row',
];

function mergeSql(): string {
  return `
    with picked as (
      select distinct on (s.yandex_id) s.*
        from yandex_maps_catalog_import_stage s
       where btrim(s.yandex_id) <> ''
       order by s.yandex_id, s.source_file desc, s.source_row desc
    )
    insert into public.yandex_maps_company_catalog as c (
      ${INSERT_COLUMNS.join(', ')}
    )
    select ${DATA_COLUMNS.map((column) => column === 'yandex_id'
      ? `p.${column}`
      : `coalesce(p.${column}, '')`).join(',\n      ')},
      coalesce(p.source_extra, '{}'::jsonb),
      array[p.source_kind], array[p.source_file], 1,
      p.source_kind, p.source_file, p.source_row
    from picked p
    on conflict (yandex_id) do nothing;`;
}

async function copyBatch(client: Client, rows: CatalogRow[]): Promise<void> {
  const copyFrom = (await import('pg-copy-streams')).from;
  // Типы pg не знают про COPY-потоки: client.query объявлен под обычные запросы
  // и возвращает Promise, а pg-copy-streams отдаёт Writable. Приведение точечное
  // и описывает фактическое поведение драйвера.
  const copy = client.query(copyFrom(
    `copy yandex_maps_catalog_import_stage (${TARGET_COLUMNS.join(', ')}) from stdin with (format csv, null '\\N')`,
  ) as unknown as string) as unknown as NodeJS.WritableStream;
  await pipeline(
    Readable.from((function* copyRows() {
      for (const row of rows) yield rowToCopy(row);
    })()),
    copy,
  );
  await client.query(mergeSql());
  await client.query('truncate yandex_maps_catalog_import_stage');
}

// null означает строку без ID организации: обработчик считает такие
// отброшенными, поэтому передаём их, а не молча пропускаем.
type RowHandler = (row: CatalogRow | null) => Promise<void>;

async function readCsv(filePath: string, onRow: RowHandler, startRow = 0): Promise<number> {
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, {
    header: false,
    delimiter: ';',
    skipEmptyLines: true,
  }) as any;
  let headers: string[] | null = null;
  let rowNumber = 0;
  let error: unknown = null;
  parser.on('data', (raw: unknown[]) => {
    parser.pause();
    const values = Array.isArray(raw) ? raw : [];
    if (!headers) {
      headers = values.map(normalizeHeader);
      rowNumber = 1;
      parser.resume();
      return;
    }
    rowNumber += 1;
    if (rowNumber <= startRow) {
      parser.resume();
      return;
    }
    void onRow(rowFromValues(headers, values, filePath, rowNumber))
      .catch((e) => { error = e; parser.destroy(e as Error); })
      .finally(() => { if (!error) parser.resume(); });
  });
  createReadStream(filePath, { encoding: 'utf8' }).pipe(parser);
  await new Promise<void>((resolve, reject) => {
    parser.on('end', resolve);
    parser.on('error', reject);
  });
  if (error) throw error;
  return Math.max(0, rowNumber - 1);
}

async function readXlsx(filePath: string, onRow: RowHandler, startRow = 0): Promise<number> {
  const workbook = new (ExcelJS as any).stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore',
  });
  let rows = 0;
  for await (const worksheet of workbook) {
    let headers: string[] | null = null;
    for await (const row of worksheet) {
      rows += 1;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      if (!headers) {
        headers = values.map(normalizeHeader);
        continue;
      }
      if (rows <= startRow) continue;
      const parsed = rowFromValues(headers, values, filePath, rows);
      if (parsed) await onRow(parsed);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const root = getArg('--source') || DATA_ROOT;
  sourceRoot = root;
  const batchSize = Math.max(500, Math.min(500000, Number(getArg('--batch-size') || 200000)));
  const dryRun = hasFlag('--dry-run');
  const noIdCheck = hasFlag('--no-id-check');
  const expectedRows = getArg('--expected-source-rows') ? Number(getArg('--expected-source-rows')) : null;
  const resumeSourceRows = Math.max(0, Number(getArg('--resume-source-rows') || 0));
  // Заливка идёт десятки часов и уже падала молча. С --resume продолжаем с
  // контрольной точки: пропускаем файлы, дочитанные до последнего flush.
  const resume = hasFlag('--resume');
  if (!root) throw new Error('Укажите --source или YANDEX_MAPS_CATALOG_SOURCE_DIR');
  if (!dryRun && !DATABASE_URL) throw new Error('Нужен YANDEX_MAPS_CATALOG_DATABASE_URL, SUPABASE_DB_URL или DATABASE_URL');

  const files = await listSourceFiles(root);
  if (!files.length) throw new Error(`В каталоге нет CSV/XLSX: ${root}`);
  const sourceKey = await buildSourceKey(files);
  const client = dryRun ? null : new Client({ connectionString: DATABASE_URL, statement_timeout: 3_600_000 });
  let resumeAfterFile = '';
  if (client) {
    await client.connect();
    const existing = await client.query(
      `select status, source_rows, unique_ids, current_file
         from public.yandex_maps_catalog_import_runs where source_key = $1`,
      [sourceKey],
    );
    if (existing.rows[0]?.status === 'completed' && !hasFlag('--force')) {
      console.log(JSON.stringify({ status: 'already_current', source_key: sourceKey, ...existing.rows[0] }));
      await client.end();
      return;
    }
    if (resume) {
      resumeAfterFile = asText(existing.rows[0]?.current_file);
      if (resumeAfterFile && !files.some((file) => relative(root, file) === resumeAfterFile)) {
        throw new Error(`Контрольная точка указывает на файл вне источника: ${resumeAfterFile}`);
      }
    }
    await client.query(
      `insert into public.yandex_maps_catalog_import_runs (source_key, status, source_files, metadata)
       values ($1, 'running', $2, $3)
       on conflict (source_key) do update set status='running', source_files=excluded.source_files,
         started_at=case when $4 then public.yandex_maps_catalog_import_runs.started_at else now() end,
         finished_at=null, error_message=null, metadata=excluded.metadata`,
      [sourceKey, files.length, JSON.stringify({
        root, files: files.slice(0, 20), forced: hasFlag('--force'), resume_source_rows: resumeSourceRows,
        resumed_after_file: resumeAfterFile || null,
      }), resume],
    );
    await client.query(`create temp table yandex_maps_catalog_import_stage (${STAGE_COLUMNS}) on commit preserve rows`);
  }

  const seen = noIdCheck ? null : new Set<string>();
  let sourceRows = 0;
  let acceptedRows = 0;
  let duplicateRows = 0;
  let rejectedRows = 0;
  let committedSourceRows = resumeSourceRows;
  // Контрольная точка ставится по файлам, а не по строкам: merge использует
  // «on conflict do nothing», поэтому повторное чтение недодочитанного файла
  // безвредно, а перечитывать миллионы строк ради точности до строки — дорого.
  let lastCompletedFile = resumeAfterFile;
  let batch: CatalogRow[] = [];
  const flush = async () => {
    if (!batch.length || !client) { batch = []; return; }
    await copyBatch(client, batch);
    batch = [];
    committedSourceRows = sourceRows;
    await client.query(
      `update public.yandex_maps_catalog_import_runs
          set source_rows=$2, current_file=$3, checkpoint_at=now()
        where source_key=$1 and status='running'`,
      [sourceKey, committedSourceRows, lastCompletedFile || null],
    );
  };
  const onRow = async (row: CatalogRow | null): Promise<void> => {
    sourceRows += 1;
    if (sourceRows <= resumeSourceRows) return;
    if (!row) { rejectedRows += 1; return; }
    acceptedRows += 1;
    if (seen) {
      if (seen.has(row.yandex_id)) duplicateRows += 1;
      else seen.add(row.yandex_id);
    }
    if (client) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    }
  };

  try {
    let skipping = Boolean(resumeAfterFile);
    if (skipping) console.log(`[yandex-catalog] продолжаю после файла: ${resumeAfterFile}`);
    for (const file of files) {
      const rel = relative(root, file);
      // Пропускаем всё до контрольной точки включительно — эти файлы уже слиты.
      if (skipping) {
        if (rel === resumeAfterFile) skipping = false;
        continue;
      }
      const ext = extname(file).toLowerCase();
      if (ext === '.csv') await readCsv(file, onRow);
      else await readXlsx(file, onRow);
      lastCompletedFile = rel;
      console.log(`[yandex-catalog] ${rel} | source_rows=${sourceRows} | unique=${seen?.size ?? 'unchecked'}`);
    }
    await flush();
    // При возобновлении часть файлов не читалась, поэтому сверять суммарное
    // число строк с ожидаемым бессмысленно.
    if (expectedRows !== null && !resumeAfterFile && expectedRows !== sourceRows) {
      throw new Error(`Ожидалось строк: ${expectedRows}, фактически: ${sourceRows}`);
    }
    const result = {
      status: dryRun ? 'dry_run' : 'completed', source_key: sourceKey, source_files: files.length,
      source_rows: sourceRows, accepted_rows: acceptedRows, duplicate_rows: duplicateRows,
      rejected_rows: rejectedRows, unique_ids: seen?.size ?? null,
    };
    if (client) {
      await client.query(
        `update public.yandex_maps_catalog_import_runs
            set status='completed', source_rows=$2, accepted_rows=$3, duplicate_rows=$4,
                rejected_rows=$5, unique_ids=$6, finished_at=now(), error_message=null
          where source_key=$1`,
        [sourceKey, sourceRows, acceptedRows, duplicateRows, rejectedRows, seen?.size ?? 0],
      );
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (client) {
      await client.query(
        `update public.yandex_maps_catalog_import_runs set status='failed', source_rows=$2,
            accepted_rows=$3, duplicate_rows=$4, rejected_rows=$5, unique_ids=$6,
            finished_at=now(), error_message=$7 where source_key=$1`,
        [sourceKey, committedSourceRows, acceptedRows, duplicateRows, rejectedRows, seen?.size ?? 0, String(error)],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await client?.end();
  }
}

main().catch((error) => {
  console.error(`[yandex-catalog] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
