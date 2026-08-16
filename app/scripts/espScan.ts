/**
 * Локальный CLI: сканирование pdl_companies на ESP-маркеры в SPF — с ПК,
 * без сервера/воркеров/миграций. Готовит базы для захода «вы уже делаете
 * email-маркетинг — попробуйте аутрич».
 *
 * Что делает:
 *   1. Читает pdl_companies из Supabase (read-only REST, keyset-пагинация)
 *      с фильтрами страна/индустрия/размер.
 *   2. Для каждого website резолвит SPF TXT-запись локально (node:dns,
 *      публичные резолверы 8.8.8.8/1.1.1.1).
 *   3. Скорит по словарю ESP (см. src/lib/espScan/espDictionary.ts):
 *      score дают только marketing-ESP (Mailchimp, Klaviyo, HubSpot...).
 *   4. Пишет CSV-базу: домен + метаданные компании + найденные ESP + score.
 *   5. Прогресс чекпоинтится локально (.esp-scan/state-*.json) — прогон
 *      можно прервать Ctrl-C и продолжить с того же места теми же фильтрами.
 *
 * Сборка:  npm run build:esp-scan  (в app/)
 * Запуск:  node app/dist/scripts/espScan.cjs --country="united kingdom" --limit=5000
 *
 * Флаги:
 *   --country=united kingdom   фильтр pdl_companies.country (lowercase)
 *   --industry=retail           фильтр pdl_companies.industry
 *   --size=11-50                фильтр pdl_companies.size
 *   --limit=50000               максимум строк pdl на прогон
 *   --out=path.csv              куда писать CSV (по умолчанию esp-scan-<ts>.csv в cwd)
 *   --concurrency=50            параллельных DNS-резолвов
 *   --include-zero              писать в CSV и score=0 строки (по умолчанию только хиты)
 *   --reset                     игнорировать/стереть чекпоинт и начать с начала
 *   --list-filters              показать топ стран/индустрий/размеров и выйти
 *
 * Env (из корневого .env, подхватывает dotenv): SUPABASE_URL (fallback NEXT_PUBLIC_SUPABASE_URL),
 * SUPABASE_SERVICE_ROLE_KEY.
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';

// .env лежит в корне репо; скрипт собирается в app/dist/scripts и запускается
// из корня: `node app/dist/scripts/espScan.cjs` (паттерн test-gis-signals-batch).
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env') });

import { lookupSpf, normalizeDomain } from '../src/lib/espScan/spfResolver';
import { scoreSpf } from '../src/lib/espScan/scoreSpf';

// ---------- CLI args ----------

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq > 2) args.set(raw.slice(2, eq), raw.slice(eq + 1));
    else args.set(raw.slice(2), '');
  }
  return args;
}

const args = parseArgs(process.argv);
const opt = {
  country: args.get('country') ?? null,
  industry: args.get('industry') ?? null,
  size: args.get('size') ?? null,
  limit: Number(args.get('limit') ?? 0) || null,
  out: args.get('out') ?? `esp-scan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`,
  concurrency: Math.max(1, Math.min(500, Number(args.get('concurrency') ?? 50))),
  includeZero: args.has('include-zero'),
  reset: args.has('reset'),
  listFilters: args.has('list-filters'),
};

// ---------- Supabase REST (read-only) ----------

// Локальный .env: SUPABASE_URL (self-hosted, polza-portal.ru) согласован с
// SUPABASE_SERVICE_ROLE_KEY; NEXT_PUBLIC_SUPABASE_URL указывает на другой
// (облачный) проект — с этим ключом он отвечает 401. Поэтому приоритет — SUPABASE_URL.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Нужны NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (корневой .env).');
  process.exit(1);
}

interface PdlRow {
  id: string;
  name: string | null;
  website: string | null;
  country: string | null;
  industry: string | null;
  size: string | null;
}

async function supabaseGet<T>(path: string, tries = 4): Promise<T[]> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
          apikey: SERVICE_KEY!,
          Authorization: `Bearer ${SERVICE_KEY}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, attempt * 1500));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return (await res.json()) as T[];
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr ?? new Error('supabaseGet failed');
}

function pdlQuery(lastId: string | null, limit: number): string {
  const params = new URLSearchParams({
    select: 'id,name,website,country,industry,size',
    order: 'id.asc',
    limit: String(limit),
  });
  // PDL id — буквенно-цифровые строки; спецсимволы URLSearchParams закодирует сам.
  if (lastId) params.set('id', `gt.${lastId}`);
  if (opt.country) params.set('country', `eq.${opt.country}`);
  if (opt.industry) params.set('industry', `eq.${opt.industry}`);
  if (opt.size) params.set('size', `eq.${opt.size}`);
  return `pdl_companies?${params.toString()}`;
}

// ---------- Чекпоинт ----------

const STATE_DIR = resolve(process.cwd(), '.esp-scan');

interface ScanState {
  lastId: string | null;
  scanned: number;
  resolved: number;
  hits: number;
  errors: number;
  updatedAt: string;
}

function statePath(): string {
  const profile = [opt.country ?? 'all', opt.industry ?? 'all', opt.size ?? 'all']
    .map((s) => s.replace(/[^a-z0-9-]+/gi, '_').slice(0, 40))
    .join('__');
  return resolve(STATE_DIR, `state-${profile}.json`);
}

function loadState(): ScanState {
  const path = statePath();
  if (opt.reset) {
    if (existsSync(path)) writeFileSync(path, JSON.stringify(freshState(), null, 2));
    return freshState();
  }
  if (existsSync(path)) {
    try {
      return { ...freshState(), ...(JSON.parse(readFileSync(path, 'utf8')) as ScanState) };
    } catch {
      console.warn('Чекпоинт повреждён — начинаю с начала.');
    }
  }
  return freshState();
}

function freshState(): ScanState {
  return { lastId: null, scanned: 0, resolved: 0, hits: 0, errors: 0, updatedAt: new Date().toISOString() };
}

function saveState(state: ScanState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

// ---------- CSV ----------

const CSV_COLUMNS = [
  'domain', 'company_name', 'country', 'industry', 'size', 'website',
  'esps', 'score', 'grade', 'spf',
] as const;

function csvEscape(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(row: Record<(typeof CSV_COLUMNS)[number], string | number | null>): string {
  return CSV_COLUMNS.map((c) => csvEscape(row[c])).join(',') + '\n';
}

// ---------- DNS-скан с ограничением параллелизма ----------

interface DomainResult {
  domain: string;
  status: 'ok' | 'no_spf' | 'no_domain' | 'transient';
  spf: string | null;
  score: number;
  grade: string | null;
  esps: string;
}

async function resolveDomain(domain: string): Promise<DomainResult> {
  const lookup = await lookupSpf(domain);
  const scored = scoreSpf(lookup.spf);
  const esps = scored.matched
    .filter((m) => m.category === 'marketing')
    .map((m) => m.label)
    .join(', ');
  return {
    domain,
    status: lookup.status,
    spf: lookup.spf,
    score: scored.score,
    grade: scored.grade,
    esps,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------- list-filters ----------

async function listFilters(): Promise<void> {
  console.log('Топ стран / индустрий / размеров в pdl_companies (pdl_facets RPC)…\n');
  const facets = await supabaseGet<{ industries: { value: string; count: number }[]; countries: { value: string; count: number }[]; sizes: { value: string; count: number }[] }>(
    'rpc/pdl_facets',
  ).catch(() => null);
  const data = facets?.[0];
  if (!data) {
    console.error('Не удалось получить facets (rpc/pdl_facets).');
    process.exit(1);
  }
  const print = (title: string, rows: { value: string; count: number }[], top: number) => {
    console.log(`\n${title} (топ ${Math.min(top, rows.length)} из ${rows.length}):`);
    for (const r of rows.slice(0, top)) console.log(`  ${String(r.count).padStart(9)}  ${r.value}`);
  };
  print('Страны', data.countries, 25);
  print('Индустрии', data.industries, 30);
  print('Размеры', data.sizes, 10);
}

// ---------- Основной цикл ----------

async function main(): Promise<void> {
  if (opt.listFilters) return listFilters();

  console.log('ESP-скан pdl_companies (локально, без записи в БД)');
  console.log(`  фильтры: country=${opt.country ?? '—'} industry=${opt.industry ?? '—'} size=${opt.size ?? '—'} limit=${opt.limit ?? '∞'}`);
  console.log(`  CSV: ${opt.out}  (include-zero=${opt.includeZero})`);

  const state = loadState();
  if (state.lastId && !opt.reset) {
    console.log(`  resume с чекпоинта: lastId=${state.lastId}, scanned=${state.scanned}, hits=${state.hits}`);
  }

  if (!existsSync(opt.out)) {
    appendFileSync(opt.out, CSV_COLUMNS.join(',') + '\n', 'utf8');
  }

  const espCounts = new Map<string, number>();
  const startedAt = Date.now();
  const BATCH = 1000;
  let rowsFetched = 0;

  while (true) {
    const remaining = opt.limit ? opt.limit - rowsFetched : null;
    const batch = await supabaseGet<PdlRow>(pdlQuery(state.lastId, remaining ? Math.min(BATCH, remaining) : BATCH));
    if (batch.length === 0) {
      console.log('\nДостигнут конец выборки по фильтрам.');
      break;
    }

    // Домены батча (дедуп внутри батча — один домен один резолв; несколько
    // компаний на одном домене пишутся отдельными строками CSV. Повтор домена
    // в другом батче — редкость, дешевле перерезолвить, чем держать сет прогона).
    const rowsByDomain = new Map<string, PdlRow[]>();
    let noSite = 0;
    for (const row of batch) {
      const domain = normalizeDomain(row.website);
      if (!domain) {
        noSite++;
        continue;
      }
      const existing = rowsByDomain.get(domain);
      if (existing) existing.push(row);
      else rowsByDomain.set(domain, [row]);
    }
    const domains = [...rowsByDomain.keys()];

    const results = await mapWithConcurrency(domains, opt.concurrency, resolveDomain);
    const resultByDomain = new Map(results.map((r) => [r.domain, r]));

    let batchHits = 0;
    let csvLines = '';
    for (const [domain, rows] of rowsByDomain) {
      const r = resultByDomain.get(domain)!;
      if (r.status === 'transient') {
        state.errors++;
        continue;
      }
      state.resolved++;
      if (r.score > 0) {
        batchHits++;
        for (const m of r.esps.split(', ').filter(Boolean)) {
          espCounts.set(m, (espCounts.get(m) ?? 0) + rows.length);
        }
      }
      if (r.score > 0 || opt.includeZero) {
        for (const row of rows) {
          csvLines += toCsvRow({
            domain,
            company_name: row.name,
            country: row.country,
            industry: row.industry,
            size: row.size,
            website: row.website,
            esps: r.esps || null,
            score: r.score,
            grade: r.grade,
            spf: r.spf,
          });
        }
      }
    }
    if (csvLines) appendFileSync(opt.out, csvLines, 'utf8');

    state.lastId = batch[batch.length - 1].id;
    state.scanned += batch.length;
    state.hits += batchHits;
    rowsFetched += batch.length;
    saveState(state);

    const elapsedMin = (Date.now() - startedAt) / 60_000;
    const rate = elapsedMin > 0 ? Math.round(state.scanned / elapsedMin) : 0;
    console.log(
      `  батч: +${batch.length} строк (${noSite} без сайта), DNS: ${domains.length}, хиты: +${batchHits}` +
      ` | всего: scanned=${state.scanned} hits=${state.hits} errors=${state.errors}` +
      ` | ${rate}/мин`,
    );

    if (batch.length < BATCH) {
      console.log('\nДостигнут конец выборки по фильтрам.');
      break;
    }
    if (opt.limit && rowsFetched >= opt.limit) {
      console.log(`\nДостигнут --limit=${opt.limit}.`);
      break;
    }
  }

  const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\nГотово за ${mins} мин.`);
  console.log(`  строк просмотрено: ${state.scanned}`);
  console.log(`  доменов отрезолвлено: ${state.resolved}`);
  console.log(`  хитов (score > 0): ${state.hits}`);
  console.log(`  transient DNS-ошибок: ${state.errors}`);
  console.log(`  CSV: ${opt.out}`);
  console.log(`  чекпоинт: ${statePath()}`);
  if (espCounts.size > 0) {
    console.log('\nТоп ESP среди хитов:');
    const sorted = [...espCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [esp, count] of sorted.slice(0, 15)) {
      console.log(`  ${String(count).padStart(6)}  ${esp}`);
    }
  }
}

main().catch((err) => {
  console.error('Скан упал:', err);
  process.exit(1);
});
