/**
 * Кандидаты оффера «Автоматизация аутрича» из AMO — прошлые лиды и клиенты Polza.
 *
 * prior_contact=true ставится только при записанном разговоре: у сделки есть
 * хотя бы одно примечание в amo_notes. Сделка без примечаний даёт cold —
 * фраза «мы с вами уже общались» ей запрещена (INSTRUCTION_03 шаг 2).
 *
 * Берём закрытые/отложенные сделки основных воронок. Сделки в работе и
 * текущие клиенты на продлении не трогаем: им пишет менеджер, а не рассылка.
 * Воронки «Для Вадима» и «Холод коробка айти» не наши разговоры об аутриче —
 * не берём (решение 22.09.2026, при необходимости расширить список ниже).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { domainFromEmail, normalizeDomain, normalizeInn } from '../company';

const PIPELINES = ['Воронка - новые лиды', 'Вторичные (и не только) продажи', 'Работа с базой'];
const STATUSES = [
  'Закрыто и не реализовано',
  'Успешно реализовано',
  'Перенос',
  'Отвал / не продлен',
  'Пауза',
  'Отказ',
];
/** Свежий отказ — не повод писать снова через неделю. */
const RECENT_CONTACT_DAYS = 30;

export interface AmoCandidate {
  amoId: number;
  companyName: string;
  domain: string;
  website: string | null;
  inn: string | null;
  statusName: string;
  priorContact: boolean;
  priorContactDate: string | null;
  recentlyContacted: boolean;
}

export async function loadAmoCandidates(db: SupabaseClient): Promise<AmoCandidate[]> {
  const leads: Array<Record<string, unknown>> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('amo_leads')
      .select('amo_id,name,company_name,company_website,contact_email,status_name,pipeline_name,updated_at,closed_at,raw')
      .in('pipeline_name', PIPELINES)
      .in('status_name', STATUSES)
      .order('updated_at', { ascending: false })
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

  const now = Date.now();
  const byDomain = new Map<string, AmoCandidate>();
  for (const lead of leads) {
    const website = typeof lead.company_website === 'string' ? lead.company_website : null;
    const domain = normalizeDomain(website) ?? domainFromEmail(typeof lead.contact_email === 'string' ? lead.contact_email : null);
    if (!domain) continue;
    const amoId = Number(lead.amo_id);
    const contactDate = (lead.closed_at ?? lead.updated_at) ? String(lead.closed_at ?? lead.updated_at) : null;
    const recentlyContacted = contactDate ? now - new Date(contactDate).getTime() < RECENT_CONTACT_DAYS * 86_400_000 : false;
    const raw = (lead.raw ?? {}) as { custom_fields_values?: Array<{ field_name?: string; values?: Array<{ value?: unknown }> }> };
    const innField = raw.custom_fields_values?.find((f) => f.field_name === 'ИНН');
    const candidate: AmoCandidate = {
      amoId,
      companyName: String(lead.company_name || lead.name || domain).trim(),
      domain,
      website: website ?? `https://${domain}`,
      inn: normalizeInn(innField?.values?.[0]?.value),
      statusName: String(lead.status_name ?? ''),
      priorContact: withNotes.has(amoId),
      priorContactDate: contactDate,
      recentlyContacted,
    };
    // Несколько сделок одной компании: берём последнюю, а «был разговор» —
    // если он был хоть в одной из них.
    const existing = byDomain.get(domain);
    if (!existing) byDomain.set(domain, candidate);
    else if (candidate.priorContact && !existing.priorContact) byDomain.set(domain, { ...existing, priorContact: true });
  }
  return Array.from(byDomain.values());
}
