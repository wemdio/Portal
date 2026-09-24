/**
 * AMO: фильтр до генерации и источник цепочки «Возврат».
 *
 * Индекс строится по ВСЕМ сделкам всех воронок — по домену сайта, домену
 * почты контакта и ИНН. Правила RU_OUTREACH_HANDOFF:
 *  - открытая сделка или действующий клиент — холодную цепочку не генерируем;
 *  - старый отказ — цепочка reactivation, но фраза «мы с вами уже общались»
 *    разрешена только при записанном разговоре (есть примечание в amo_notes);
 *  - отказ свежее 30 дней — не пишем вовсе.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { domainFromEmail, normalizeDomain, normalizeInn } from '../company';

const CLIENT_STATUSES = new Set([
  'Успешно реализовано',
  'Передан в работу',
  'Продлено',
  'Счет / договор на продление',
  'Продление обсуждается',
  'Риск / нужен контроль',
  'Пауза',
]);
const LOST_STATUSES = new Set(['Закрыто и не реализовано', 'Отвал / не продлен', 'Отказ']);
/** Воронки, где сделка — это разговор Polza об аутриче (а не чужой холод). */
const REACTIVATION_PIPELINES = new Set(['Воронка - новые лиды', 'Вторичные (и не только) продажи', 'Работа с базой']);
const RECENT_CONTACT_DAYS = 30;

export type AmoStatus = 'open_deal' | 'client' | 'lost_recent' | 'lost' | 'none';

export interface AmoRecord {
  amoId: number;
  status: AmoStatus;
  statusName: string;
  pipelineName: string;
  companyName: string | null;
  domain: string | null;
  inn: string | null;
  contactEmail: string | null;
  priorContact: boolean;
  lastContactAt: string | null;
}

export interface AmoIndex {
  byDomain: Map<string, AmoRecord>;
  byInn: Map<string, AmoRecord>;
  records: AmoRecord[];
}

/** Самый «запрещающий» статус побеждает: клиент > открытая сделка > свежий отказ > отказ. */
const RANK: Record<AmoStatus, number> = { client: 4, open_deal: 3, lost_recent: 2, lost: 1, none: 0 };

function classify(statusName: string, lastContactAt: string | null): AmoStatus {
  if (CLIENT_STATUSES.has(statusName)) return 'client';
  if (LOST_STATUSES.has(statusName)) {
    const t = lastContactAt ? new Date(lastContactAt).getTime() : NaN;
    return Number.isFinite(t) && Date.now() - t < RECENT_CONTACT_DAYS * 86_400_000 ? 'lost_recent' : 'lost';
  }
  return 'open_deal';
}

export async function loadAmoIndex(db: SupabaseClient): Promise<AmoIndex> {
  const leads: Array<Record<string, unknown>> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('amo_leads')
      .select('amo_id,company_name,company_website,contact_email,status_name,pipeline_name,updated_at,closed_at,raw')
      .order('amo_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`amo_leads load failed: ${error.message}`);
    leads.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const withNotes = new Set<number>();
  const ids = leads.map((l) => Number(l.amo_id)).filter(Number.isFinite);
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db.from('amo_notes').select('amo_deal_id').in('amo_deal_id', ids.slice(i, i + 500));
    if (error) throw new Error(`amo_notes load failed: ${error.message}`);
    for (const n of data ?? []) withNotes.add(Number(n.amo_deal_id));
  }

  const index: AmoIndex = { byDomain: new Map(), byInn: new Map(), records: [] };
  const put = (map: Map<string, AmoRecord>, key: string | null, rec: AmoRecord) => {
    if (!key) return;
    const prev = map.get(key);
    if (!prev || RANK[rec.status] > RANK[prev.status] || (RANK[rec.status] === RANK[prev.status] && rec.priorContact && !prev.priorContact)) {
      map.set(key, rec);
    }
  };

  for (const lead of leads) {
    const email = typeof lead.contact_email === 'string' ? lead.contact_email.trim().toLowerCase() : null;
    const siteDomain = normalizeDomain(typeof lead.company_website === 'string' ? lead.company_website : null);
    const emailDomain = domainFromEmail(email);
    const raw = (lead.raw ?? {}) as { custom_fields_values?: Array<{ field_name?: string; values?: Array<{ value?: unknown }> }> };
    const inn = normalizeInn(raw.custom_fields_values?.find((f) => f.field_name === 'ИНН')?.values?.[0]?.value);
    const lastContactAt = (lead.closed_at ?? lead.updated_at) ? String(lead.closed_at ?? lead.updated_at) : null;
    const statusName = String(lead.status_name ?? '');
    const amoId = Number(lead.amo_id);
    const domain = siteDomain ?? emailDomain;
    const rec: AmoRecord = {
      amoId,
      status: classify(statusName, lastContactAt),
      statusName,
      pipelineName: String(lead.pipeline_name ?? ''),
      companyName: typeof lead.company_name === 'string' && lead.company_name.trim() ? lead.company_name.trim() : null,
      domain,
      inn,
      contactEmail: email && emailDomain && domain && (emailDomain === domain || emailDomain.endsWith(`.${domain}`)) ? email : null,
      priorContact: withNotes.has(amoId),
      lastContactAt,
    };
    index.records.push(rec);
    put(index.byDomain, siteDomain, rec);
    put(index.byDomain, emailDomain, rec);
    put(index.byInn, inn, rec);
  }
  return index;
}

export function amoLookup(index: AmoIndex, domain: string | null, inn: string | null): AmoRecord | null {
  const a = domain ? index.byDomain.get(domain) ?? null : null;
  const b = inn ? index.byInn.get(inn) ?? null : null;
  if (a && b) return RANK[a.status] >= RANK[b.status] ? a : b;
  return a ?? b;
}

/**
 * Кандидаты цепочки «Возврат»: давний отказ в воронках Polza с записанным
 * разговором и названием компании (название сделки в AMO — не название компании).
 */
export function reactivationCandidates(index: AmoIndex): AmoRecord[] {
  const seen = new Set<string>();
  const out: AmoRecord[] = [];
  for (const rec of index.records) {
    if (rec.status !== 'lost' || !rec.priorContact || !rec.companyName || !rec.domain) continue;
    if (!REACTIVATION_PIPELINES.has(rec.pipelineName)) continue;
    // Итоговый статус компании — по индексу: у неё может быть и более новая сделка.
    if (amoLookup(index, rec.domain, rec.inn)?.status !== 'lost') continue;
    if (seen.has(rec.domain)) continue;
    seen.add(rec.domain);
    out.push(rec);
  }
  return out;
}
