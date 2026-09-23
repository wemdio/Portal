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

export async function collectCandidates(
  db: SupabaseClient,
  config: RuOutreachConfig,
  amo: AmoIndex,
  poolTarget: number,
): Promise<Candidate[]> {
  const src = new Set(config.sources);
  const all: Candidate[] = [];

  if (src.has('crm')) {
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
  }

  if (src.has('hh')) {
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
  }

  if (src.has('direct')) {
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
  }

  const uploadKinds: Array<['exhibitors' | 'contracts' | 'growth', Signal['type']]> = [
    ['exhibitors', 'trade_show_exhibitor'],
    ['contracts', 'contract_won'],
    ['growth', 'grant_or_accelerator'],
  ];
  for (const [kind, type] of uploadKinds) {
    if (!src.has(kind)) continue;
    for (const r of await loadSignalRows(db, kind, config.freshness_days)) {
      if (kind === 'contracts' && !(Number(r.details.amount ?? 0) >= config.min_contract_amount)) continue;
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
  }

  if (src.has('site_news')) all.push(...(await loadSiteUniverse(db)));

  if (src.has('directory')) {
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
  }

  const merged = merge(all);
  // Сначала компании с поводом и несколькими источниками, затем свежие; профиль — в конце.
  return merged.sort(
    (a, b) =>
      Number(b.signals.length > 0) - Number(a.signals.length > 0) ||
      b.sources.length - a.sources.length ||
      latest(b) - latest(a),
  );
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
