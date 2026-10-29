/**
 * Сбор кандидатов из выбранных источников и склейка в одну карточку на компанию.
 *
 * Склейка по ИНН → домен → работодатель hh → нормализованное название:
 * компания, найденная и в hh, и в каталоге выставки, получает одну карточку
 * со всеми своими поводами — одна компания, одна цепочка.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { dueDate, type CascadeReturn } from './cascade';
import { lookupCascade, selectByIn, type CascadeCompany, type CascadeIndex } from './cascadeIndex';
import { companyKey, normalizeDomain } from './company';
import { loadDirectoryCandidates } from './sources/directory';
import { loadDirectHits } from './sources/direct';
import { reactivationCandidates, type AmoIndex, type AmoRecord } from './sources/amo';
import { loadHhEmployers, SALES_TITLE_PATTERN, type HhVacancyRef } from './sources/hhPool';
import { loadSignalRows } from './sources/uploads';
import { loadGisCandidates } from './sources/gis';
import { loadYmapsNewBranches } from './sources/ymaps';
import { loadYmapsCatalogCandidates } from './sources/ymapsCatalog';
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
  /** Почты из загруженной базы: поиск почты проверяет их наравне с сайтом. */
  knownEmails: string[];
  /**
   * Компания, которой уже писали и у которой прошла пауза каскада: следующий
   * продукт и что уже предлагали. Ставит раннер по индексу каскада.
   */
  cascade?: CascadeReturn;
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
    knownEmails: [],
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

/** «a@x.ru, b@x.ru; c@x.ru» → адреса по одному (в базах их пишут списком в одной ячейке). */
function splitEmails(value: string | null | undefined): string[] {
  return Array.from(new Set(String(value ?? '').toLowerCase().split(/[\s,;]+/).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e))));
}

export async function collectCandidates(
  db: SupabaseClient,
  config: RuOutreachConfig,
  amo: AmoIndex,
  poolTarget: number,
  /** Строка в журнал воркера: этап сбора виден, а не «тишина» на загрузке источников. */
  onLog: (message: string) => void = () => {},
): Promise<CollectResult> {
  const src = new Set(config.sources);
  const all: Candidate[] = [];
  const sourceErrors: CollectResult['sourceErrors'] = {};
  const attempt = async (code: SourceCode, fn: () => Promise<void>) => {
    const startedAt = Date.now();
    const before = all.length;
    onLog(`сбор: источник «${code}» — начал`);
    try {
      await fn();
      onLog(`сбор: источник «${code}» — готово, +${all.length - before} кандидатов за ${Math.round((Date.now() - startedAt) / 1000)} с`);
    } catch (err) {
      sourceErrors[code] = err instanceof Error ? err.message.slice(0, 300) : String(err);
      onLog(`сбор: источник «${code}» — ОШИБКА за ${Math.round((Date.now() - startedAt) / 1000)} с: ${sourceErrors[code]}`);
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
              // email — адрес из каталога выставки: поиск почты проверяет его наравне с сайтом.
              meta: { customer: r.details.customer ?? null, event_start: r.upload.event_start, program: r.details.program ?? r.upload.title, email: r.details.email ?? null },
            }],
          }),
        );
      }
    });
  }

  // Своя база (загруженная): компания с почтой, без повода — цепочка «только профиль».
  if (src.has('base')) {
    await attempt('base', async () => {
      for (const r of await loadSignalRows(db, 'base')) {
        const emails = splitEmails(typeof r.details.email === 'string' ? r.details.email : null);
        all.push(
          base({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.company_name)}`,
            source: 'base',
            sourceRecordId: `base:${r.id}`,
            companyName: r.company_name,
            inn: r.inn,
            website: r.company_website,
            revenue: typeof r.details.revenue === 'number' ? r.details.revenue : null,
            knownEmails: emails,
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
        okvedPrefixes: config.okved_prefixes,
        limit: Math.min(100_000, Math.max(500, poolTarget)),
      });
      for (const r of rows) {
        all.push(
          base({
            key: r.inn ? `inn:${r.inn}` : `name:${companyKey(r.name)}`,
            source: 'directory',
            knownEmails: splitEmails(r.email),
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

  if (src.has('ymaps_catalog')) {
    await attempt('ymaps_catalog', async () => {
      for (const y of await loadYmapsCatalogCandidates(db, Math.min(100_000, Math.max(500, poolTarget)), onLog)) {
        const domain = normalizeDomain(y.website);
        if (!domain) continue;
        all.push(
          base({
            key: `domain:${domain}`,
            source: 'ymaps_catalog',
            sourceRecordId: y.yandexId ? `ymaps_catalog:${y.yandexId}` : null,
            companyName: y.name,
            website: y.website.startsWith('http') ? y.website : `https://${domain}`,
            knownEmails: splitEmails(y.email),
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

  onLog(`сбор: всего кандидатов ${all.length}, склеиваю по ИНН/домену`);
  const merged = merge(all);
  onLog(`сбор: после склейки ${merged.length}, проверяю память отказов`);
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
  onLog(`сбор: готово, в пуле ${pool.length} (пропущено по памяти отказов ${merged.length - fresh.length})`);
  return { pool, sourceErrors, skippedRecent: merged.length - fresh.length };
}

/** Поводы, которые запуск находит заново (разбор сайта, новости, ФНС): прежние не берём, иначе будет два одинаковых. */
const RECHECKED_SOURCES: ReadonlySet<SourceCode> = new Set<SourceCode>(['site_news', 'news', 'revenue_growth']);

/**
 * Прежние поводы вернувшейся компании, которые не устарели. Повод без даты не
 * стареет никогда (реклама в Директе висела бы вечно) — не берём; кроме давнего
 * отказа в AMO: это факт прошлого, а не событие.
 */
function priorSignals(company: CascadeCompany, since: number): Signal[] {
  return company.signals.filter((s) => {
    if (RECHECKED_SOURCES.has(s.source)) return false;
    if (s.type === 'crm_lost') return true;
    if (!s.date) return false;
    const at = new Date(s.date).getTime();
    return Number.isFinite(at) && at >= since;
  });
}

/** Строка прошлого запуска для «недавно уже пробовали»: поля, которые читает recentlyAttempted. */
export interface AttemptRow {
  id: string;
  normalized_domain: string | null;
  inn: string | null;
  created_at: string | null;
  row_status: string | null;
  reason_code: string | null;
}

/** Сколько дней помним неудачную попытку вернувшейся компании: потом она снова в начале пула. */
export const ATTEMPT_MEMORY_DAYS = 14;

/**
 * Отсев, который не говорит о компании ничего: не дошла очередь (квота реактивации,
 * лимит готовых), пауза или закрытый каскад по индексу того запуска, повтор строки
 * в запуске, прежнее «уже выгружалась» (до каскада).
 */
const NOT_AN_ATTEMPT = new Set(['CASCADE_CAP', 'LIMIT_REACHED', 'CASCADE_WAIT', 'CASCADE_CLOSED', 'DUPLICATE_COMPANY', 'PREVIOUSLY_EXPORTED']);

/**
 * Вернувшиеся компании, которых недавно уже пробовали: после того, как пауза
 * прошла, и не раньше ATTEMPT_MEMORY_DAYS дней назад есть их строка, которая не
 * стала готовой (нет повода, оценка ниже порога, нет почты, не B2B, спорная…).
 * Без этого компания с такой попыткой навсегда стояла бы первой в индексе и
 * каждый запуск занимала бы начало пула. Через ATTEMPT_MEMORY_DAYS дней она
 * снова в очереди.
 */
export function recentlyAttempted(index: CascadeIndex, rows: AttemptRow[], pauseDays: number, now: Date): Set<CascadeCompany> {
  const since = now.getTime() - ATTEMPT_MEMORY_DAYS * 86_400_000;
  const out = new Set<CascadeCompany>();
  for (const row of rows) {
    if (row.row_status === 'ready' || (row.reason_code && NOT_AN_ATTEMPT.has(row.reason_code))) continue;
    const at = row.created_at ? new Date(row.created_at).getTime() : NaN;
    if (!Number.isFinite(at) || at < since) continue;
    // И по домену, и по ИНН: у строки они могут вести к разным компаниям индекса.
    const companies = [
      row.normalized_domain ? index.byDomain.get(row.normalized_domain) : undefined,
      row.inn ? index.byInn.get(row.inn) : undefined,
    ];
    for (const company of companies) {
      if (!company || company.decision.kind !== 'due') continue;
      const due = dueDate(company.facts, pauseDays);
      if (due && at > due.getTime()) out.add(company);
    }
  }
  return out;
}

/**
 * Строки прошлых запусков (не `excludeJobId`) за ATTEMPT_MEMORY_DAYS дней, не
 * готовые, по доменам и ИНН вернувшихся компаний — вход recentlyAttempted.
 */
export async function loadRecentAttempts(
  db: SupabaseClient,
  index: CascadeIndex,
  excludeJobId: string,
  pauseDays: number,
  now: Date,
): Promise<Set<CascadeCompany>> {
  const since = new Date(now.getTime() - ATTEMPT_MEMORY_DAYS * 86_400_000).toISOString();
  const domains = [...new Set(index.due.map((c) => c.domain).filter((d): d is string => Boolean(d)))];
  const inns = [...new Set(index.due.map((c) => c.inn).filter((i): i is string => Boolean(i)))];
  const columns = 'id,normalized_domain,inn,created_at,row_status,reason_code';
  const byKey = async (column: 'normalized_domain' | 'inn', values: string[]) =>
    selectByIn<AttemptRow>(`attempts by ${column}`, 'id', values, (chunk, after) => {
      const query = db
        .from('polza_ru_outreach_companies')
        .select(columns)
        .in(column, chunk)
        .neq('row_status', 'ready')
        .neq('job_id', excludeJobId)
        .gte('created_at', since);
      // 1000 — размер страницы selectByIn (PAGE в cascadeIndex.ts): короче — последняя.
      return (after === null ? query : query.gt('id', after)).order('id', { ascending: true }).limit(1000);
    });
  const rows = [...(await byKey('normalized_domain', domains)), ...(await byKey('inn', inns))];
  return recentlyAttempted(index, rows, pauseDays, now);
}

export interface CascadePool {
  /** Вернувшиеся компании: прошла пауза — следующий продукт (Candidate.cascade). */
  returning: Candidate[];
  /** Новые кандидаты из источников — без вернувшихся. */
  fresh: Candidate[];
}

/**
 * Вернувшиеся компании каскада — не больше `limit`, в порядке индекса: раньше
 * всех писали — первыми. Остальным карточку собираем по прошлой строке:
 * источник 'cascade', домен, ИНН, название, прежние поводы.
 *
 * Компания, которую нашли и источники запуска: первые `head` вернувшихся (они
 * встанут в начало пула) идут карточкой источника — со свежими поводами,
 * вакансиями, сделкой AMO, — она уходит из новых и получает недостающие домен и
 * ИНН из индекса; своих поводов у неё нет — берём прежние, если не устарели.
 * Дальше такая карточка остаётся среди новых на своём месте (каскад ей даст
 * раннер), а своей карточки из индекса компания не получает — две карточки
 * одной компании не нужны.
 *
 * `skip` — компания уже в журнале запуска (продолжение после перезапуска) или её
 * недавно уже пробовали (recentlyAttempted).
 */
export function cascadeCandidates(
  index: CascadeIndex,
  limit: number,
  options: {
    sources: Candidate[];
    freshnessDays: number;
    /** Сколько вернувшихся встанет в начало пула (cascadeHead); по умолчанию — все. */
    head?: number;
    skip?: (company: CascadeCompany) => boolean;
    now?: Date;
  },
): CascadePool {
  const since = (options.now ?? new Date()).getTime() - options.freshnessDays * 86_400_000;
  const head = options.head ?? limit;
  const found = new Map<CascadeCompany, Candidate>();
  for (const c of options.sources) {
    const company = lookupCascade(index, normalizeDomain(c.website), c.inn);
    if (company?.decision.kind === 'due' && !found.has(company)) found.set(company, c);
  }
  const returning: Candidate[] = [];
  const pulled = new Set<Candidate>();
  for (const company of index.due) {
    if (returning.length >= limit) break;
    const decision = company.decision;
    if (decision.kind !== 'due' || options.skip?.(company)) continue;
    const cascade = { next: decision.next, offered: [...company.facts.offered] };
    const source = found.get(company);
    if (source) {
      if (returning.length >= head) continue;
      if (!source.signals.length && !source.vacancies.length) source.signals.push(...priorSignals(company, since));
      // Ключи индекса — карточке: по ним раннер узнает компанию и не пустит вторую её карточку.
      source.inn ??= company.inn;
      if (!normalizeDomain(source.website) && company.domain) source.website = `https://${company.domain}`;
      source.cascade = cascade;
      returning.push(source);
      pulled.add(source);
      continue;
    }
    returning.push({
      key: company.domain ? `domain:${company.domain}` : `inn:${company.inn}`,
      sources: [],
      sourceRecordId: `cascade:${company.lastRowId}`,
      sourceUrls: [],
      // Без названия бренд подтвердится со страницы сайта, как у кандидатов Директа.
      companyName: company.companyName ?? company.domain ?? '',
      inn: company.inn,
      website: company.domain ? `https://${company.domain}` : null,
      hhEmployerId: null,
      amo: null,
      signals: priorSignals(company, since),
      vacancies: [],
      vacancyCount: 0,
      revenue: null,
      employees: null,
      knownEmails: [],
      cascade,
    });
  }
  return { returning, fresh: options.sources.filter((c) => !pulled.has(c)) };
}

/** Источник строки журнала: источники компании через «+», у вернувшейся из каскада — 'cascade'. */
export function sourceTypeOf(c: Candidate): string {
  return c.sources.length ? c.sources.join('+') : 'cascade';
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
    existing.knownEmails = Array.from(new Set([...existing.knownEmails, ...c.knownEmails]));
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
