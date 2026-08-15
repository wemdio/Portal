import dotenv from 'dotenv';
import { resolve, basename } from 'path';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { promises as dns } from 'node:dns';
import * as cheerio from 'cheerio';
import Papa from 'papaparse';

// .env лежит в корне репо; скрипт собирается в app/dist/scripts и запускается
// из корня: `node app/dist/scripts/test-gis-signals-batch.cjs`.
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../../../.env') });
dotenv.config({ path: resolve(__dirname, '../../.env') });

import {
  detectOutreachSignals,
  emptySignals as emptySignalSet,
  SIGNAL_COLUMNS,
  ONLINE_FORMAT_RE,
  ONLINE_NEGATIVE_RE,
  ONLINE_EVIDENCE_MAX,
  type OutreachSignalSet,
  type SignalVerdict,
} from '../src/lib/gisSignalOutreach/signals';
import { scrapeEmails } from '../src/lib/enrich/emailScraper';
import { fetchHtmlWithRetry } from '../src/lib/enrich/websiteParser';

/**
 * Локальный тест-ран gis-signals пайплайна на сэмпле компаний (TSV:
 * segment, id, company, city, phone, email_2gis, site, category, subcategory).
 * Меряет воронку конверсии: кандидаты → сайт доступен → есть ≥1 сигнал →
 * есть email → финальные контакты. Без записей в прод, без SMTP-проб
 * (недоступны локально — вместо них MX-проверка домена через DNS).
 *
 * Стадии на компанию (в порядке пайплайна):
 *   1. detectOutreachSignals(site, twogisPhone) — keep при signalsCount >= 1.
 *   1.5. online_format: ОДИН повторный fetch главной (только для прошедших
 *      сигналы) + regex маркеров онлайн-формата по видимому тексту. Нужен
 *      клиенту для фильтрации базы по формату (онлайн-школы vs офлайн).
 *   2. Emails: email_2gis первым + scrapeEmails(stopAtFirstUsableEmail: false,
 *      maxPages: 8), кап 8 адресов с сайта; dedup case-insensitively.
 *   3. MX-чек домена (resolveMx + кэш) — замена SMTP-проб; timeout/servfail →
 *      mx_unknown, email СОХРАНЯЕТСЯ (fail-open как keepUnverifiable).
 *   4. Кап 5 email на компанию (2gis первым, дальше в порядке скрейпа).
 *      Отличие от прода: там ранжирование по ok/catch_all статусам SMTP-проб,
 *      здесь статусов нет — просто порядок скрейпа.
 *
 * Параллелизм: 8 воркеров на компанию (стадии 1-2), MX — общий семафор 20.
 * На компанию мягкий таймаут 90s — застрявшая пропускается с пометкой.
 * Resume: результаты компаний аппендятся в <base>-progress.jsonl, при старте
 * уже обработанные id пропускаются.
 *
 * Запуск: node app/dist/scripts/test-gis-signals-batch.cjs [tsv] [limit] [concurrency]
 */

const INPUT_TSV = process.argv[2] ?? resolve(process.cwd(), '.tmp/gis-test-2000.tsv');
const LIMIT = Number(process.argv[3] ?? '0'); // 0 = все
const CONCURRENCY = Number(process.argv[4] ?? '8');

const BASE_NAME = basename(INPUT_TSV).replace(/\.[^.]+$/, '');
const OUT_CSV = resolve(process.cwd(), `.tmp/${BASE_NAME}-base.csv`);
const OUT_FUNNEL = resolve(process.cwd(), `.tmp/${BASE_NAME}-funnel.json`);
const PROGRESS_JSONL = resolve(process.cwd(), `.tmp/${BASE_NAME}-progress.jsonl`);

const COMPANY_TIMEOUT_MS = 90_000;
const MX_TIMEOUT_MS = 5_000;
const MX_CONCURRENCY = 20;
const MAX_SCRAPED_EMAILS = 8; // кап адресов с сайта
const MAX_FINAL_EMAILS = 5;   // кап контактов на компанию
const PROGRESS_LOG_EVERY = 50;

// Маркеры онлайн-формата и стоп-фразы импортируются из signals.ts
// (ONLINE_FORMAT_RE / ONLINE_NEGATIVE_RE / ONLINE_EVIDENCE_MAX) — единый
// источник с прод-пайплайном, здесь своих копий нет.

type SignalKey = keyof OutreachSignalSet;
type MxStatus = 'yes' | 'no' | 'unknown';

interface InputRow {
  segment: string;
  id: string;
  company: string;
  city: string;
  phone: string;
  email2gis: string;
  site: string;
  category: string;
  subcategory: string;
}

interface EmailRec {
  email: string;
  source: '2gis' | 'site';
  mx: MxStatus;
}

interface CompanyResult {
  id: string;
  segment: string;
  company: string;
  city: string;
  phone: string;
  site: string;
  siteOk: boolean;
  signalsPass: boolean;
  signalsCount: number;
  note: string;
  signals: Record<SignalKey, SignalVerdict>;
  /** Признак онлайн-формата ('да'/'нет') — только для прошедших сигналы. */
  onlineFormat: 'да' | 'нет';
  /** Сниппет-доказательство ≤120 символов; '' когда 'нет'. */
  onlineEvidence: string;
  /** 2gis+scrape после dedup, ДО капа 5. */
  emailsFound: EmailRec[];
  /** Сколько адресов дал скрейп сайта (до капа 8). */
  emailsScraped: number;
  /** ≤5 финальных контактов. */
  finalEmails: EmailRec[];
  skipped: string;
  durationMs: number;
}

// ─── Вход ────────────────────────────────────────────────────────────────────

function readInputRows(): InputRow[] {
  const raw = readFileSync(INPUT_TSV, 'utf-8');
  const rows: InputRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 7) continue;
    const site = (c[6] ?? '').trim();
    if (!site) continue;
    rows.push({
      segment: (c[0] ?? '').trim(),
      id: (c[1] ?? '').trim(),
      company: (c[2] ?? '').trim(),
      city: (c[3] ?? '').trim(),
      // Телефонов может быть несколько через запятую — берём первый (как в калибровке).
      phone: (c[4] ?? '').split(',')[0].trim(),
      email2gis: (c[5] ?? '').split(/[,;]/)[0].trim(),
      site,
      category: (c[7] ?? '').trim(),
      subcategory: (c[8] ?? '').trim(),
    });
  }
  return LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
}

// ─── Resume ──────────────────────────────────────────────────────────────────

function loadProgress(): Map<string, CompanyResult> {
  const done = new Map<string, CompanyResult>();
  if (!existsSync(PROGRESS_JSONL)) return done;
  for (const line of readFileSync(PROGRESS_JSONL, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as CompanyResult;
      if (rec.id) done.set(rec.id, rec);
    } catch { /* битая строка — игнор */ }
  }
  return done;
}

// ─── MX (замена SMTP-проб) ───────────────────────────────────────────────────

const mxCache = new Map<string, MxStatus>();

function createSemaphore(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((res) => waiters.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}
const withMxSlot = createSemaphore(MX_CONCURRENCY);

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

/** yes = есть MX; no = домен без MX; unknown = DNS сбой (email сохраняем). */
async function resolveMxStatus(domain: string): Promise<MxStatus> {
  if (!domain) return 'no';
  const cached = mxCache.get(domain);
  if (cached) return cached;
  const status = await withMxSlot(async () => {
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<'unknown'>((res) => {
      timer = setTimeout(() => res('unknown'), MX_TIMEOUT_MS);
    });
    try {
      const out = await Promise.race([dns.resolveMx(domain), guard]);
      clearTimeout(timer);
      if (out === 'unknown') return 'unknown';
      return out.length > 0 ? 'yes' : 'no';
    } catch (err) {
      clearTimeout(timer);
      const code = (err as { code?: string }).code ?? '';
      // ENOTFOUND/ENODATA — домена/MX нет; ETIMEOUT/ESERVFAIL/EAI_AGAIN и
      // прочие сбои резолвера — unknown (fail-open, email сохраняем).
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'no' : 'unknown';
    }
  });
  mxCache.set(domain, status);
  return status;
}

// ─── Стадии пайплайна ────────────────────────────────────────────────────────

// Ключи набора перечислены ТОЛЬКО в signals.ts (emptySignals) — иначе каждый
// новый сигнал ломал бы компиляцию всех калибраторов сразу.
function emptySignals(): Record<SignalKey, SignalVerdict> {
  return emptySignalSet();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), ms);
  });
  const out = await Promise.race([promise, guard]);
  clearTimeout(timer);
  return out;
}

/**
 * Стадия 1.5: признак онлайн-формата по главной странице. Один повторный
 * fetch (сайт уже прошёл сигналы, главная почти наверняка жива); сбой →
 * 'нет' без ретраев (fail-open). Стоп-фразы («онлайн-запись», «записаться
 * онлайн», «онлайн заявка») вырезаем из текста ДО матчинга — это кнопки
 * записи офлайн-школ, а не формат обучения.
 */
async function detectOnlineFormat(site: string): Promise<{ onlineFormat: 'да' | 'нет'; onlineEvidence: string }> {
  try {
    const res = await fetchHtmlWithRetry(site, { allowHttpErrors: false });
    if (!res || res.status < 200 || res.status >= 300 || !res.html) {
      return { onlineFormat: 'нет', onlineEvidence: '' };
    }
    const $ = cheerio.load(res.html);
    $('script, style, noscript, svg, template, link, meta').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    if (!text) return { onlineFormat: 'нет', onlineEvidence: '' };

    const cleaned = text.replace(ONLINE_NEGATIVE_RE, ' ');
    const m = cleaned.match(ONLINE_FORMAT_RE);
    if (!m || typeof m.index !== 'number') return { onlineFormat: 'нет', onlineEvidence: '' };

    const start = Math.max(0, m.index - 40);
    const end = Math.min(cleaned.length, m.index + m[0].length + 40);
    let evidence = cleaned.slice(start, end).replace(/\s+/g, ' ').trim();
    if (evidence.length > ONLINE_EVIDENCE_MAX) {
      evidence = `${evidence.slice(0, ONLINE_EVIDENCE_MAX - 1).trimEnd()}…`;
    }
    return { onlineFormat: 'да', onlineEvidence: evidence };
  } catch {
    return { onlineFormat: 'нет', onlineEvidence: '' };
  }
}

async function processCompany(row: InputRow): Promise<CompanyResult> {
  const start = Date.now();
  const result: CompanyResult = {
    id: row.id, segment: row.segment, company: row.company, city: row.city,
    phone: row.phone, site: row.site,
    siteOk: false, signalsPass: false, signalsCount: 0, note: '',
    signals: emptySignals(),
    onlineFormat: 'нет', onlineEvidence: '',
    emailsFound: [], emailsScraped: 0, finalEmails: [],
    skipped: '', durationMs: 0,
  };

  const work = (async () => {
    // ── 1. Сигналы ──
    let sig: Awaited<ReturnType<typeof detectOutreachSignals>>;
    try {
      sig = await detectOutreachSignals({ siteUrl: row.site, twogisPhone: row.phone || null });
    } catch (err) {
      result.note = `signals error: ${err instanceof Error ? err.message : 'unknown'}`;
      return;
    }
    result.siteOk = sig.ok;
    result.signals = sig.signals;
    result.signalsCount = sig.signalsCount;
    result.note = sig.note;
    if (!sig.ok || sig.signalsCount < 1) return;
    result.signalsPass = true;

    // ── 1.5. Онлайн-формат (только для прошедших сигналы — экономим fetch'и) ──
    const online = await detectOnlineFormat(row.site);
    result.onlineFormat = online.onlineFormat;
    result.onlineEvidence = online.onlineEvidence;

    // ── 2. Emails: 2GIS первым + скрейп сайта ──
    const merged: EmailRec[] = [];
    if (row.email2gis && row.email2gis.includes('@')) {
      merged.push({ email: row.email2gis, source: '2gis', mx: 'unknown' });
    }
    try {
      const scrape = await scrapeEmails(row.site, {
        stopAtFirstUsableEmail: false,
        maxPages: MAX_SCRAPED_EMAILS,
      });
      const scraped = scrape.emails.slice(0, MAX_SCRAPED_EMAILS);
      result.emailsScraped = scraped.length;
      for (const email of scraped) merged.push({ email, source: 'site', mx: 'unknown' });
    } catch { /* скрейп best-effort — без email компания просто выпадает из базы */ }

    // dedup case-insensitively, порядок: 2gis первым, дальше в порядке скрейпа
    const seen = new Set<string>();
    const unique: EmailRec[] = [];
    for (const rec of merged) {
      const key = rec.email.trim().toLowerCase();
      if (!key || !key.includes('@') || seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...rec, email: rec.email.trim() });
    }

    // ── 3. MX-чек доменов (кэш + семафор 20) ──
    for (const rec of unique) {
      rec.mx = await resolveMxStatus(emailDomain(rec.email));
    }
    result.emailsFound = unique;

    // ── 4. Кап 5 на компанию ──
    result.finalEmails = unique.slice(0, MAX_FINAL_EMAILS);
  })();

  const raced = await withTimeout(work, COMPANY_TIMEOUT_MS);
  if (raced === 'timeout') {
    result.skipped = `soft timeout ${COMPANY_TIMEOUT_MS / 1000}s`;
  }
  result.durationMs = Date.now() - start;
  return result;
}

// ─── Воркеры ─────────────────────────────────────────────────────────────────

interface RunStats {
  processed: number;
  signalsPass: number;
  withEmail: number;
}

async function runWithConcurrency(
  rows: InputRow[],
  done: Map<string, CompanyResult>,
  limit: number,
): Promise<void> {
  const pending = rows.filter((r) => !done.has(r.id));
  const stats: RunStats = { processed: 0, signalsPass: 0, withEmail: 0 };
  const t0 = Date.now();
  let idx = 0;

  async function worker() {
    while (idx < pending.length) {
      const row = pending[idx++];
      let result: CompanyResult;
      try {
        result = await processCompany(row);
      } catch (err) {
        result = {
          id: row.id, segment: row.segment, company: row.company, city: row.city,
          phone: row.phone, site: row.site,
          siteOk: false, signalsPass: false, signalsCount: 0,
          note: `script error: ${err instanceof Error ? err.message : 'unknown'}`,
          signals: emptySignals(), onlineFormat: 'нет', onlineEvidence: '',
          emailsFound: [], emailsScraped: 0, finalEmails: [],
          skipped: 'script error', durationMs: 0,
        };
      }
      done.set(result.id, result);
      appendFileSync(PROGRESS_JSONL, JSON.stringify(result) + '\n', 'utf-8');

      stats.processed++;
      if (result.signalsPass) stats.signalsPass++;
      if (result.emailsFound.length > 0) stats.withEmail++;
      if (stats.processed % PROGRESS_LOG_EVERY === 0 || stats.processed === pending.length) {
        const elapsed = (Date.now() - t0) / 1000;
        const eta = stats.processed > 0 ? (elapsed / stats.processed) * (pending.length - stats.processed) : 0;
        console.log(
          `  [${stats.processed}/${pending.length}] signals_pass=${stats.signalsPass} with_email=${stats.withEmail} ` +
          `elapsed=${Math.round(elapsed)}s ETA=${Math.round(eta)}s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, () => worker()));
}

// ─── Выходные файлы ──────────────────────────────────────────────────────────

function buildBaseCsv(results: CompanyResult[]): string {
  const columns = [
    'segment', 'id', 'компания', 'city', 'phone', 'сайт', 'email', 'email_source', 'mx',
    ...SIGNAL_COLUMNS.map((c) => c.title),
    ...SIGNAL_COLUMNS.map((c) => c.clarification),
    'online_format', 'online_evidence',
    'signals_count', 'Проверка — примечание',
  ];
  const rows: Array<Record<string, string | number>> = [];
  for (const r of results) {
    for (const rec of r.finalEmails) {
      const out: Record<string, string | number> = {
        segment: r.segment,
        id: r.id,
        'компания': r.company,
        city: r.city,
        phone: r.phone,
        'сайт': r.site,
        email: rec.email,
        email_source: rec.source,
        mx: rec.mx,
        // Старые записи прогресса (до появления стадии 1.5) — дефолт 'нет'.
        online_format: r.onlineFormat ?? 'нет',
        online_evidence: r.onlineEvidence ?? '',
        signals_count: r.signalsCount,
        'Проверка — примечание': r.skipped ? `${r.note} | ${r.skipped}` : r.note,
      };
      for (const col of SIGNAL_COLUMNS) {
        const verdict = r.signals[col.key];
        out[col.title] = verdict.hit ? 'Да' : 'Нет';
      }
      for (const col of SIGNAL_COLUMNS) {
        const verdict = r.signals[col.key];
        out[col.clarification] = verdict.hit ? verdict.evidence : '';
      }
      rows.push(out);
    }
  }
  return Papa.unparse(rows, { columns });
}

interface FunnelBucket {
  candidates: number;
  site_ok: number;
  signals_pass: number;
  signals_pass_pct: number;
  /** Компаний с признаком онлайн-формата (считается среди signals_pass). */
  online_format_yes: number;
  online_format_yes_pct_of_signals_pass: number;
  with_email: number;
  with_email_pct_of_signals_pass: number;
  emails_total: number;
  emails_mx_ok: number;
  emails_mx_unknown: number;
  emails_mx_fail: number;
  final_contacts: number;
  conversion_candidates_to_contacts_pct: number;
  avg_emails_per_company: number;
}

function bucket(results: CompanyResult[]): FunnelBucket {
  const candidates = results.length;
  const siteOk = results.filter((r) => r.siteOk).length;
  const signalsPass = results.filter((r) => r.signalsPass).length;
  const onlineYes = results.filter((r) => r.signalsPass && r.onlineFormat === 'да').length;
  const withEmail = results.filter((r) => r.emailsFound.length > 0).length;
  const emailsTotal = results.reduce((s, r) => s + r.emailsFound.length, 0);
  const mxOk = results.reduce((s, r) => s + r.emailsFound.filter((e) => e.mx === 'yes').length, 0);
  const mxUnknown = results.reduce((s, r) => s + r.emailsFound.filter((e) => e.mx === 'unknown').length, 0);
  const mxFail = results.reduce((s, r) => s + r.emailsFound.filter((e) => e.mx === 'no').length, 0);
  const finalContacts = results.reduce((s, r) => s + r.finalEmails.length, 0);
  return {
    candidates,
    site_ok: siteOk,
    signals_pass: signalsPass,
    signals_pass_pct: candidates ? Math.round((signalsPass / candidates) * 1000) / 10 : 0,
    online_format_yes: onlineYes,
    online_format_yes_pct_of_signals_pass: signalsPass ? Math.round((onlineYes / signalsPass) * 1000) / 10 : 0,
    with_email: withEmail,
    with_email_pct_of_signals_pass: signalsPass ? Math.round((withEmail / signalsPass) * 1000) / 10 : 0,
    emails_total: emailsTotal,
    emails_mx_ok: mxOk,
    emails_mx_unknown: mxUnknown,
    emails_mx_fail: mxFail,
    final_contacts: finalContacts,
    conversion_candidates_to_contacts_pct: candidates ? Math.round((finalContacts / candidates) * 1000) / 10 : 0,
    avg_emails_per_company: withEmail ? Math.round((finalContacts / withEmail) * 100) / 100 : 0,
  };
}

function buildFunnel(results: CompanyResult[]) {
  const segments = Array.from(new Set(results.map((r) => r.segment))).sort();
  const perSegment: Record<string, FunnelBucket> = {};
  for (const seg of segments) {
    perSegment[seg] = bucket(results.filter((r) => r.segment === seg));
  }
  return {
    input: INPUT_TSV,
    generated_at: new Date().toISOString(),
    notes: [
      'MX-проверка вместо SMTP-проб (локально недоступны): unknown = DNS сбой, email сохранён fail-open.',
      'Ранжирование email — 2gis первым, дальше порядок скрейпа (в проде — по ok/catch_all статусам SMTP-проб).',
      'emails_total/mx_* — по всем найденным адресам до капа 5; final_contacts — строки в base CSV.',
      'online_format считается только для signals_pass (стадия 1.5, один fetch главной); online_format_yes — доля от signals_pass.',
    ],
    total: bucket(results),
    per_segment: perSegment,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nВход: ${INPUT_TSV}`);
  const rows = readInputRows();
  const done = loadProgress();
  const pending = rows.filter((r) => !done.has(r.id));
  console.log(`Строк: ${rows.length}, уже обработано (resume): ${done.size}, к обработке: ${pending.length}`);
  console.log(`Concurrency=${CONCURRENCY}, MX concurrency=${MX_CONCURRENCY}, timeout=${COMPANY_TIMEOUT_MS / 1000}s/компания\n`);

  const t0 = Date.now();
  await runWithConcurrency(rows, done, CONCURRENCY);
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  console.log(`\nОбработка завершена за ${elapsedSec}s`);

  // Результаты в порядке исходного TSV (только обработанные id).
  const results = rows.map((r) => done.get(r.id)).filter((r): r is CompanyResult => Boolean(r));

  writeFileSync(OUT_CSV, buildBaseCsv(results), 'utf-8');
  const funnel = buildFunnel(results);
  writeFileSync(OUT_FUNNEL, JSON.stringify(funnel, null, 2), 'utf-8');
  console.log(`База:   ${OUT_CSV} (${funnel.total.final_contacts} контактов)`);
  console.log(`Воронка: ${OUT_FUNNEL}`);
  console.log(`Прогресс: ${PROGRESS_JSONL}\n`);

  console.log('ВОРОНКА (total):');
  console.log(JSON.stringify(funnel.total, null, 2));
  console.log('По сегментам:');
  for (const [seg, b] of Object.entries(funnel.per_segment)) {
    console.log(
      `  ${seg}: candidates=${b.candidates} signals_pass=${b.signals_pass} (${b.signals_pass_pct}%) ` +
      `online=${b.online_format_yes} with_email=${b.with_email} contacts=${b.final_contacts} conv=${b.conversion_candidates_to_contacts_pct}%`,
    );
  }
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
