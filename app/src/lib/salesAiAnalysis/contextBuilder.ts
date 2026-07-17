/**
 * Собирает пакет-контекст для LLM: карточка сделки + переписка + транскрипты.
 * Форматирует в человекочитаемые строки, которые пойдут в user-промт.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchChatMessages, fetchTranscripts, linkLead, type LeadForLinking } from './linker';

export interface LeadFullContext {
  lead: {
    id: number;
    amo_id: number;
    name: string | null;
    status_name: string | null;
    pipeline_name: string | null;
    responsible_name: string | null;
    amount: number | null;
    company_name: string | null;
    company_website: string | null;
    contact_phone: string | null;
    contact_email: string | null;
    contact_tg_username: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  amoText: string;
  chatText: string;
  chatCount: number;
  transcriptText: string;
  transcriptCount: number;
  lastMessageAt: string | null;
  lastTranscriptAt: string | null;
  dialogId: string | null;
}

interface LeadRow {
  id: number;
  amo_id: number;
  name: string | null;
  status_name: string | null;
  pipeline_name: string | null;
  responsible_name: string | null;
  amount: number | null;
  company_name: string | null;
  company_website: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  contact_tg_username: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function buildContext(
  db: SupabaseClient,
  amoLeadId: number,
): Promise<LeadFullContext | null> {
  const { data: leadRow, error } = await db
    .from('amo_leads')
    .select(
      'id, amo_id, name, status_name, pipeline_name, responsible_name, amount, ' +
      'company_name, company_website, contact_phone, contact_email, contact_tg_username, ' +
      'created_at, updated_at'
    )
    .eq('id', amoLeadId)
    .maybeSingle();
  if (error) throw new Error(`buildContext lead: ${error.message}`);
  if (!leadRow) return null;
  // supabase-js в новых версиях выводит тип select-строки как GenericStringError,
  // прямой каст (leadRow as LeadRow) TS не пропускает. Двойной каст через unknown —
  // стандартный обход. См. https://github.com/supabase/supabase-js/issues/2504.
  const lead = leadRow as unknown as LeadRow;

  const forLink: LeadForLinking = {
    id: lead.id,
    contact_tg_username: lead.contact_tg_username,
    company_website: lead.company_website,
  };
  const links = await linkLead(db, forLink);
  const chat = await fetchChatMessages(db, links.dialog_id);
  const transcripts = await fetchTranscripts(db, links.transcript_ids);

  return {
    lead,
    amoText: formatAmoCard(lead),
    chatText: chat.text,
    chatCount: chat.count,
    transcriptText: transcripts.text,
    transcriptCount: transcripts.count,
    lastMessageAt: chat.lastMessageAt,
    lastTranscriptAt: transcripts.lastTranscriptAt,
    dialogId: links.dialog_id,
  };
}

function formatAmoCard(l: LeadRow): string {
  const rows: string[] = [
    `AMO ID: ${l.amo_id}`,
    `Название сделки: ${l.name ?? '—'}`,
    `Этап: ${l.status_name ?? '—'} (${l.pipeline_name ?? '—'})`,
    `Ответственный: ${l.responsible_name ?? '—'}`,
    `Сумма: ${l.amount != null ? l.amount : '—'} руб.`,
    `Компания: ${l.company_name ?? '—'}`,
    `Сайт: ${l.company_website ?? '—'}`,
    `Контакт: телефон ${l.contact_phone ?? '—'} | email ${l.contact_email ?? '—'} | TG @${l.contact_tg_username ?? '—'}`,
    `Создана: ${l.created_at?.slice(0, 10) ?? '—'} | Обновлена: ${l.updated_at?.slice(0, 10) ?? '—'}`,
  ];
  return rows.join('\n');
}
