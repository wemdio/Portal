/**
 * Сегментация ESP-баз (esp-base-*.csv от app/scripts/espScan.ts) в порядке
 * приоритета, с отсевом прямых конкурентов (агентства маркетинга/рекламы).
 *
 * Вход:  CSV-базы espScan (колонки domain,company_name,country,industry,size,
 *        website,esps,score,grade,spf). По умолчанию — все esp-base-*.csv в cwd.
 * Выход: каталог esp-segments/ с файлами по сегментам (p1-…p4-…),
 *        excluded-competitors.csv (кого выкинули — для контроля),
 *        all-prioritized.csv (всё вместе + колонки priority/segment).
 *
 * Модель приоритетов (под питч «вы уже делаете email-маркетинг → аутрич»):
 *   P1 p1-email-mature     grade A — стэк из 2+ систем, бюджет на маркетинг есть
 *   P2 p2-automation-crm   grade C — marketing automation (HubSpot/Pardot/…)
 *                          без платформы рассылок: питч «исходящий канал поверх CRM»
 *   P3 p3-smb-platform     grade B, размер 1–50 — SMB на платформе (Mailchimp/
 *                          Brevo/…): ядро питча
 *   P4 p4-midplus-platform grade B, размер 51+ — средние+ на платформе
 *
 * Конкуренты (исключаются): industry = 'marketing and advertising' ИЛИ имя
 * компании матчится на агентские маркеры (agency/marketing/SEO/lead gen/outreach…).
 *
 * Сборка: npm run build:esp-segment (в app/)
 * Запуск: node app/dist/scripts/espSegment.cjs [--in=f1.csv,f2.csv] [--out-dir=esp-segments]
 */

import { resolve } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

// ---------- CLI ----------

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
  inFiles: (args.get('in') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  outDir: args.get('out-dir') ?? 'esp-segments',
};

// ---------- CSV (полный парсер: кавычки, запятые, переносы внутри полей) ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c === '\r') {
      // пропускаем — нормализуем к \n
    } else cur += c;
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value: string | number | null): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------- Типы и словари ----------

interface BaseRow {
  domain: string;
  companyName: string;
  country: string;
  industry: string;
  size: string;
  website: string;
  esps: string[];
  score: number;
  grade: string;
  spf: string;
}

const SIZE_ORDER: Record<string, number> = {
  '1-10': 1,
  '11-50': 2,
  '51-200': 3,
  '201-500': 4,
  '501-1000': 5,
  '1001-5000': 6,
  '5001-10000': 7,
  '10001+': 8,
};

const COMPETITOR_INDUSTRY = new Set(['marketing and advertising']);

const COMPETITOR_NAME_RE =
  /(\bagenc(?:y|ies)\b|\bmarketing\b|\badvertis(?:ing|ement|er)\b|\bseo\b|\bsmm\b|\bppc\b|lead[\s-]?gen|outreach|demand[\s-]?gen|growth[\s-]?(?:hack|agency|marketing)|digital[\s-]agency|creative[\s-]agency|media[\s-]buy(?:ing)?|email[\s-]marketing|performance[\s-]marketing|content[\s-]marketing|inbound[\s-]agency|crm[\s-]agency|\bpr[\s-]agency\b|\bbranding\b)/i;

interface SegmentDef {
  file: string;
  title: string;
  match: (r: BaseRow) => boolean;
}

const SEGMENTS: SegmentDef[] = [
  {
    file: 'p1-email-mature.csv',
    title: 'P1 · Зрелый маркетинг (grade A, стэк 2+ систем)',
    match: (r) => r.grade === 'A',
  },
  {
    file: 'p2-automation-crm.csv',
    title: 'P2 · Automation/CRM без платформы (grade C: HubSpot/Pardot/Marketo/…)',
    match: (r) => r.grade === 'C',
  },
  {
    file: 'p3-smb-platform.csv',
    title: 'P3 · SMB на платформе (grade B, 1–50 чел.)',
    match: (r) => r.grade === 'B' && (SIZE_ORDER[r.size] ?? 0) <= 2,
  },
  {
    file: 'p4-midplus-platform.csv',
    title: 'P4 · Средние+ на платформе (grade B, 51+ чел.)',
    match: (r) => r.grade === 'B' && (SIZE_ORDER[r.size] ?? 0) >= 3,
  },
];

const OUT_COLUMNS = [
  'priority', 'segment', 'domain', 'company_name', 'country', 'industry', 'size',
  'website', 'esps', 'score', 'grade', 'spf',
] as const;

// ---------- Основная логика ----------

function rowFromCsv(cols: string[]): BaseRow | null {
  if (cols.length < 10) return null;
  const score = Number(cols[7]);
  if (!Number.isFinite(score)) return null;
  return {
    domain: cols[0],
    companyName: cols[1],
    country: cols[2],
    industry: cols[3] || '—',
    size: cols[4] || '—',
    website: cols[5],
    esps: (cols[6] || '').split(', ').filter(Boolean),
    score,
    grade: cols[8] || '',
    spf: cols[9] || '',
  };
}

function isCompetitor(r: BaseRow): boolean {
  if (COMPETITOR_INDUSTRY.has(r.industry.trim().toLowerCase())) return true;
  return COMPETITOR_NAME_RE.test(r.companyName);
}

function toOutputLine(r: BaseRow, priority: number, segment: string): string {
  const cells: Record<string, string | number | null> = {
    priority,
    segment,
    domain: r.domain,
    company_name: r.companyName,
    country: r.country,
    industry: r.industry,
    size: r.size,
    website: r.website,
    esps: r.esps.join(', ') || null,
    score: r.score,
    grade: r.grade,
    spf: r.spf,
  };
  return OUT_COLUMNS.map((c) => csvEscape(cells[c])).join(',') + '\n';
}

function main(): void {
  const files = opt.inFiles.length
    ? opt.inFiles
    : readdirSync(process.cwd())
        .filter((f) => /^esp-base-.*\.csv$/.test(f))
        .map((f) => resolve(process.cwd(), f));

  if (files.length === 0) {
    console.error('Нет входных файлов: передайте --in=file1.csv,file2.csv или положите esp-base-*.csv в cwd.');
    process.exit(1);
  }

  const rows: BaseRow[] = [];
  const dedupe = new Set<string>();
  for (const file of files) {
    const parsed = parseCsv(readFileSync(file, 'utf8'));
    for (const cols of parsed.slice(1)) {
      const r = rowFromCsv(cols);
      if (!r || !r.domain) continue;
      // pk = домен+страна: одна компания один раз; дубли по домену между странами оставляем (контекст разный)
      const pk = `${r.country}|${r.domain}|${r.companyName}`;
      if (dedupe.has(pk)) continue;
      dedupe.add(pk);
      rows.push(r);
    }
  }
  console.log(`Прочитано: ${files.length} файл(ов), ${rows.length} компаний (после дедупа).`);

  const competitors: BaseRow[] = [];
  const kept: BaseRow[] = [];
  for (const r of rows) (isCompetitor(r) ? competitors : kept).push(r);
  console.log(`Конкуренты отсеяны: ${competitors.length} (${((competitors.length / rows.length) * 100).toFixed(1)}%). Осталось: ${kept.length}.`);

  if (!existsSync(opt.outDir)) mkdirSync(opt.outDir, { recursive: true });
  const header = OUT_COLUMNS.join(',') + '\n';

  const buckets: { def: SegmentDef; rows: BaseRow[] }[] = SEGMENTS.map((def) => ({ def, rows: [] }));
  const rest: BaseRow[] = [];
  for (const r of kept) {
    const bucket = buckets.find((b) => b.def.match(r));
    if (bucket) bucket.rows.push(r);
    else rest.push(r);
  }

  const byPriority = (a: BaseRow, b: BaseRow) => b.score - a.score || (SIZE_ORDER[b.size] ?? 0) - (SIZE_ORDER[a.size] ?? 0) || a.domain.localeCompare(b.domain);

  console.log('\nСегменты в порядке приоритета:');
  buckets.forEach((b, idx) => {
    b.rows.sort(byPriority);
    const path = resolve(opt.outDir, b.def.file);
    writeFileSync(path, header + b.rows.map((r) => toOutputLine(r, idx + 1, b.def.file.replace('.csv', ''))).join(''), 'utf8');
    console.log(`  ${b.def.title}: ${b.rows.length} → ${path}`);
  });
  if (rest.length > 0) {
    writeFileSync(resolve(opt.outDir, 'zz-unclassified.csv'), header + rest.map((r) => toOutputLine(r, 99, 'unclassified')).join(''), 'utf8');
    console.log(`  Без сегмента (нестандартный grade): ${rest.length} → zz-unclassified.csv`);
  }

  competitors.sort(byPriority);
  writeFileSync(
    resolve(opt.outDir, 'excluded-competitors.csv'),
    header + competitors.map((r) => toOutputLine(r, 0, 'competitor')).join(''),
    'utf8',
  );
  console.log(`  Конкуренты (для контроля): ${competitors.length} → excluded-competitors.csv`);

  const all = [...kept].sort(byPriority);
  const priorityOf = (r: BaseRow): number => {
    const idx = buckets.findIndex((b) => b.def.match(r));
    return idx === -1 ? 99 : idx + 1;
  };
  const segOf = (r: BaseRow): string => (priorityOf(r) === 99 ? 'unclassified' : SEGMENTS[priorityOf(r) - 1].file.replace('.csv', ''));
  writeFileSync(
    resolve(opt.outDir, 'all-prioritized.csv'),
    header + all.map((r) => toOutputLine(r, priorityOf(r), segOf(r))).join(''),
    'utf8',
  );
  console.log(`  Мастер-файл: ${all.length} → all-prioritized.csv`);

  // Сводка по странам внутри сегментов
  console.log('\nТоп-5 стран по сегментам:');
  for (const b of buckets) {
    const byCountry = new Map<string, number>();
    for (const r of b.rows) byCountry.set(r.country, (byCountry.get(r.country) ?? 0) + 1);
    const top = [...byCountry.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([c, n]) => `${c}: ${n}`).join(', ');
    console.log(`  ${b.def.file}: ${top}`);
  }
}

main();
