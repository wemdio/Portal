/**
 * Сбор кандидатов из выбранных источников и склейка в одну карточку на компанию.
 *
 * Склейка по ИНН → домен → работодатель hh → нормализованное название:
 * компания, найденная и в hh, и в каталоге выставки, получает одну карточку
 * со всеми своими поводами — одна компания, одна цепочка.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { companyKey, normalizeDomain } from './company';
import { loadDirectoryCandidates } from './sources/directory';
import { loadDirectHits } from './sources/direct';
import { reactivationCandidates, type AmoIndex, type AmoRecord } from './sources/amo';
import { loadHhEmployers, SALES_TITLE_PATTERN, type HhVacancyRef } from './sources/hhPool';
import { loadSignalRows } from './sources/uploads';
import { loadGisCandidates } from './sources/gis';
import { loadYmapsNewBranches } from './sources/ymaps';
import type { RuOutreachConfig, Signal, SourceCode } from './types';

export interface Candidate {
  key: string;
  sources: SourceCode[];
  sourceRecordId: string | null;
  sourceUrls: string[];
  companyName: string;
  inn: string | null;
  website: string | null;
  hhEmployerId: string | null;
  /** Сделка AMO, из которой пришла компания (цепочка «Возврат»). */
  amo: AmoRecord | null;
  signals: Signal[];
  vacancies: HhVacancyRef[];
  vacancyCount: number;
  revenue: number | null;
  employees: number | null;
}

function base(partial: Partial<Candidate> & Pick<Candidate, 'key' | 'companyName'> & { source: SourceCode }): Candidate {
  const { source, ...rest } = partial;
  return {
    sources: [source],
    sourceRecordId: null,
    sourceUrls: [],
    inn: null,
    website: null,
    hhEmployerId: null,
    amo: null,
    signals: [],
    vacancies: [],
    vacancyCount: 0,
    revenue: null,
    employees: null,
    ...rest,
  };
}

const SITE_UNIVERSE_LIMIT = 2000;

async function loadSiteUniverse(db: SupabaseClient): Promise<Candidate[]> {
  const { data, error } = await db
    .from('polza_ru_outreach_companies')
    .select('company_name,normalized_domain,company_website,inn')
    .not('normalized_domain', 'is', null)
    .order('created_at', { ascending: false })
    .limit(SITE_UNIVERSE_LIMIT * 3);
  if (error) throw new Error(`site universe load failed: ${error.message}`);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of data ?? []) {
    const domain = String(r.normalized_domain);
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(
      base({
        key: `domain:${domain}`,
        source: 'site_news',
        sourceRecordId: `site:${domain}`,
        companyName: String(r.company_name),
        inn: r.inn ? String(r.inn) : null,
        website: r.company_website ? String(r.company_website) : `https://${domain}`,
      }),
    );
    if (out.length >= SITE_UNIVERSE_LIMIT) break;
  }
  return out;
}

export interface CollectResult {
  pool: Candidate[];
  /** Источник упал — запуск идёт без него, причина показывается на экране. */
  sourceErrors: Partial<Record<SourceCode, string>>;
  /** Сколько компаний не взято: их недавно уже отсеяли (recentlyRejectedDomains). */
  skippedRecent: number;
}

/** Сколько дней не проверяем повторно компанию с окончательным отказом. */
const REJECT_MEMORY_DAYS = 30;
/**
 * «Почты нет» до этой даты не помнится: тогда бесплатные адреса и второй домен
 * компании отбрасывались (findEmail.ts), и такие компании стоит проверить заново.
 */
const EMAIL_RULES_SINCE = '2026-10-08T00:00:00Z';

/**
 * Домены, которые за последние 30 дней уже отсеяли окончательно: не B2B,
 * исключённая категория, нет рабочей почты. 07.10.2026 так было 57% лимита
 * просмотра: источник site_news берёт домены из прошлых строк, и автосбор
 * перепроверял 2 596 уже отсеянных компаний из 3 000 — готовых из них 0.
 * Слабый повод и «нет цепочки» не помним: новость может появиться завтра.
 */
async function recentlyRejectedDomains(db: SupabaseClient, now = new Date()): Promise<Set<string>> {
  const since = new Date(now.getTime() - REJECT_MEMORY_DAYS * 86_400_000).toISOString();
  const emailSince = since > EMAIL_RULES_SINCE ? since : EMAIL_RULES_SINCE;
  const out = new Set<string>();
  const page = 1000;
  for (const [reasons, from] of [
    [['NOT_B2B', 'EXCLUDED_CATEGORY'], since],
    [['EMAIL_NOT_FOUND', 'EMAIL_INVALID'], emailSince],
  ] as const) {
    for (let offset = 0; ; offset += page) {
      const { data, error } = await db
        .from('polza_ru_outreach_companies')
        .select('normalized_domain')
        .in('reason_code', [...reasons])
        .gte('created_at', from)
        .not('normalized_domain', 'is', null)
        .order('id')
        .range(offset, offset + page - 1);
      if (error) throw new Error(`rejected domains load failed: ${error.message}`);
      for (const r of data ?? []) out.add(String(r.normalized_domain));
      if (!data || data.length < page) break;
    }
  }
  return out;
}

const SOURCE_POOL_LIMIT = 5000;

export async function collectCandidates(
  db: SupabaseClient,
  config: RuOutreachConfig,
  amo: AmoIndex,
  poolTarget: number,
): Promise<CollectResult> {
  const src = new Set(config.sources);
  const all: Candidate[] = [];
  const sourceErrors: CollectResult['sourceErrors'] = {};
  const attempt = async (code: SourceCode, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      sourceErrors[code] = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
  };

  if (src.has('crm')) {
    await attempt('crm', async () => {
      for (const rec of reactivationCandidates(amo)) {
        all.push(
          base({
            key: `domain:${rec.domain}`,
            source: 'crm',
            sourceRecordId: `amo:${rec.amoId}`,
            companyName: rec.companyName as string,
            inn: rec.inn,
            website: `https://${rec.domain}`,
            amo: rec,
            signals: [{ type: 'crm_lost', source: 'crm', title: rec.statusName, date: rec.lastContactAt, url: null, quote: null, level: 'B' }],
          }),
        );
      }
    });
  }

  if (src.has('hh')) {
    await attempt('hh', async () => {
      const employers = await loadHhEmployers(db, { pattern: SALES_TITLE_PATTERN, freshnessDays: config.freshness_days });
      for (const e of employers) {
        all.push(
          base({
            key: e.employerId ? `hh:${e.employerId}` : `name:${companyKey(e.companyName)}`,
            source: 'hh',
            sourceRecordId: e.vacancies[0] ? `hh:${e.vacancies[0].vacancy_id}` : null,
            sourceUrls: e.vacancies.map((v) => v.url).filter((u): u is string => Boolean(u)),
            companyName: e.companyName,
            website: e.companySiteUrl,
            hhEmployerId: e.employerId,
            vacancies: e.vacancies,
            vacancyCount: e.vacancyCount,
          }),
        );
      }
    });
  }

  if (src.has('direct')) {
    await attempt('direct', async () => {
      for (const hit of await loadDirectHits(db, config.freshness_days)) {
        all.push(
          base({
            key: `domain:${hit.domain}`,
            source: 'direct',
            sourceRecordId: `direct:${hit.domain}`,
            sourceUrls: hit.url ? [hit.url] : [],
            // Название компании Директ не даёт: бренд подтверждается со страницы сайта.
            companyName: hit.domain,
            website: `https://${hit.domain}`,
            signals: [{ type: 'ad_running', source: 'direct', title: hit.keyword ?? hit.title ?? '', date: hit.seenAt, url: hit.url, quote: null, level: 'B', meta: { keyword: hit.keyword } }],
          }),
        );
      }
    });
  }

  const uploadKinds: Array<['exhibitors' | 'contracts' | 'growth' | 'tenders', Signal['type']]> = [
    ['exhibitors', 'trade_show_exhibitor'],
    ['contracts', 'contract_won'],
    ['tenders', 'tender_won'],
    ['growth', 'grant_or_accelerator'],
  ];
  for (const [kind, type] of uploadKinds) {
    if (!src.has(kind)) continue;
    await attempt(kind, async () => {
      for (const r of await loadSignalRows(db, kind, config.freshness_days)) {
        if ((kind === 'contracts' || kind === 'tenders') && !(Number(r.details.amount ?? 0) >= config.min_contract_amount)) continue;
        const url = r.record_url ?? r.upload.official_url;
        const title =
          kind === 'exhibitors'
            ? r.upload.title
            : String((r.details.subject as string | undefined) ?? (r.details.program as string | undefined) ?? r.upload.title);
        all.push(
          base({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.company_name)}`,
            source: kind,
            sourceRecordId: `${kind}:${r.id}`,
            sourceUrls: url ? [url] : [],
            companyName: r.company_name,
            inn: r.inn,
            website: r.company_website,
            signals: [{
              type,
              source: kind,
              title,
              date: kind === 'exhibitors' ? r.upload.event_start : r.record_date,
              url,
              quote: null,
              level: 'B',
              meta: { customer: r.details.customer ?? null, event_start: r.upload.event_start, program: r.details.program ?? r.upload.title },
            }],
          }),
        );
      }
    });
  }

  if (src.has('site_news')) {
    await attempt('site_news', async () => {
      all.push(...(await loadSiteUniverse(db)));
    });
  }

  if (src.has('directory')) {
    await attempt('directory', async () => {
      const rows = await loadDirectoryCandidates(db, {
        minRevenue: config.min_revenue,
        maxRevenue: config.max_revenue,
        minEmployees: config.min_employees,
        limit: Math.min(5000, Math.max(500, poolTarget)),
      });
      for (const r of rows) {
        all.push(
          base({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.name)}`,
            source: 'directory',
            sourceRecordId: r.inn ? `inn:${r.inn}` : null,
            companyName: r.name,
            inn: r.inn,
            website: r.website,
            revenue: r.revenue,
            employees: r.employees,
          }),
        );
      }
    });
  }

  if (src.has('gis')) {
    await attempt('gis', async () => {
      for (const g of await loadGisCandidates(db, config.freshness_days, SOURCE_POOL_LIMIT)) {
        all.push(
          base({
            key: `domain:${g.domain}`,
            source: 'gis',
            sourceRecordId: `gis:${g.twogisId}`,
            sourceUrls: [`https://2gis.ru/firm/${g.twogisId}`],
            companyName: g.companyName,
            website: `https://${g.domain}`,
            signals: g.signals,
          }),
        );
      }
    });
  }

  if (src.has('ymaps')) {
    await attempt('ymaps', async () => {
      for (const y of await loadYmapsNewBranches(db, config.freshness_days, SOURCE_POOL_LIMIT)) {
        all.push(
          base({
            key: `domain:${y.domain}`,
            source: 'ymaps',
            sourceRecordId: `ymaps:${y.networkId}`,
            sourceUrls: y.signal.url ? [y.signal.url] : [],
            companyName: y.companyName,
            website: `https://${y.domain}`,
            signals: [y.signal],
          }),
        );
      }
    });
  }

  // Рост выручки проверяется в раннере по ИНН (ФНС); здесь — компании общей
  // базы с ИНН в заданном размере, чтобы было у кого проверять.
  if (src.has('revenue_growth') && !src.has('directory')) {
    await attempt('revenue_growth', async () => {
      const rows = await loadDirectoryCandidates(db, {
        minRevenue: config.min_revenue,
        maxRevenue: config.max_revenue,
        minEmployees: config.min_employees,
        limit: Math.min(SOURCE_POOL_LIMIT, Math.max(500, poolTarget)),
      });
      for (const r of rows) {
        if (!r.inn) continue;
        all.push(
          base({
            key: `inn:${r.inn}`,
            source: 'revenue_growth',
            sourceRecordId: `inn:${r.inn}`,
            companyName: r.name,
            inn: r.inn,
            website: r.website,
            revenue: r.revenue,
            employees: r.employees,
          }),
        );
      }
    });
  }

  const merged = merge(all);
  // Память отказов не должна ронять запуск: без неё он просто медленнее.
  let rejected = new Set<string>();
  try {
    rejected = await recentlyRejectedDomains(db);
  } catch {
    /* таблица недоступна — проверяем всех, как раньше */
  }
  const fresh = merged.filter((c) => {
    const domain = normalizeDomain(c.website);
    return !domain || !rejected.has(domain);
  });
  // Сначала источники с лучшей доходимостью, затем компании с поводом и
  // несколькими источниками, затем свежие; профиль — в конце.
  const pool = fresh.sort(
    (a, b) =>
      sourceRank(b) - sourceRank(a) ||
      Number(hasOutsideSignal(b)) - Number(hasOutsideSignal(a)) ||
      sourceWeight(b) - sourceWeight(a) ||
      latest(b) - latest(a),
  );
  return { pool, sourceErrors, skippedRecent: merged.length - fresh.length };
}

/**
 * Старый отказ в AMO местом в очереди не распоряжается.
 *
 * Повод `crm_lost` есть у каждого реактивационного кандидата по построению, а
 * источник 'crm' склеивается с hh и новостями сайта — вместе это ставило
 * старые отказы в самое начало очереди. Запуск 01.10.2026 на 100 строк
 * остановился по target_reached, просмотрев 433 кандидата из 35 938 в пуле:
 * 81 готовая строка из 100 — компании, с которыми мы уже общались. В цепочку
 * «Возврат» они по-прежнему попадают, но ждут общей очереди.
 */
function hasOutsideSignal(c: Candidate): boolean {
  // Вакансия продажника hh — тоже повод, хоть и лежит не в signals.
  return c.vacancies.length > 0 || c.signals.some((s) => s.type !== 'crm_lost');
}

/**
 * «Уже видели домен» (site_news без найденной новости) — не второй источник:
 * иначе повторный домен 2ГИС (site_news+gis) шёл раньше свежих hh и Директа.
 */
function sourceWeight(c: Candidate): number {
  return c.sources.filter((s) => s !== 'crm' && s !== 'site_news').length;
}

/**
 * Доходимость источника до готовой строки за 2 недели до 07.10.2026: hh — 8–12%,
 * Директ и загружаемые поводы — ~5%, прочие — 1–3%, 2ГИС без других — меньше 1%.
 * Лучшие стоят первыми, чтобы потолок просмотра не уходил на слабые.
 */
function sourceRank(c: Candidate): number {
  const has = (s: SourceCode) => c.sources.includes(s);
  if (has('hh') && c.vacancies.length) return 4;
  if (has('direct') || has('exhibitors') || has('contracts') || has('tenders') || has('growth')) return 3;
  if (c.sources.every((s) => s === 'gis' || s === 'site_news')) return 1;
  return 2;
}

function latest(c: Candidate): number {
  const dates = c.signals.map((s) => (s.date ? new Date(s.date).getTime() : 0)).filter(Number.isFinite);
  return Math.max(0, ...dates, c.vacancies[0]?.published_at ? new Date(c.vacancies[0].published_at).getTime() : 0);
}

function keysOf(c: Candidate): string[] {
  const keys: string[] = [];
  if (c.inn) keys.push(`inn:${c.inn}`);
  const domain = normalizeDomain(c.website);
  if (domain) keys.push(`domain:${domain}`);
  if (c.hhEmployerId) keys.push(`hh:${c.hhEmployerId}`);
  if (!c.sources.includes('direct')) keys.push(`name:${companyKey(c.companyName)}`);
  return keys;
}

function merge(list: Candidate[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const out: Candidate[] = [];
  for (const c of list) {
    const keys = keysOf(c);
    const existing = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!existing) {
      out.push(c);
      for (const k of keys) byKey.set(k, c);
      continue;
    }
    existing.sources = Array.from(new Set([...existing.sources, ...c.sources]));
    existing.signals.push(...c.signals);
    existing.sourceUrls = Array.from(new Set([...existing.sourceUrls, ...c.sourceUrls]));
    existing.inn = existing.inn ?? c.inn;
    existing.website = existing.website ?? c.website;
    existing.hhEmployerId = existing.hhEmployerId ?? c.hhEmployerId;
    existing.amo = existing.amo ?? c.amo;
    existing.revenue = existing.revenue ?? c.revenue;
    existing.employees = existing.employees ?? c.employees;
    if (!existing.vacancies.length && c.vacancies.length) {
      existing.vacancies = c.vacancies;
      existing.vacancyCount = c.vacancyCount;
    }
    // Название из Директа — это домен; настоящее название из другого источника лучше.
    if (existing.sources.includes('direct') && existing.companyName === normalizeDomain(existing.website) && c.companyName !== existing.companyName) {
      existing.companyName = c.companyName;
    }
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, existing);
  }
  return out;
}
