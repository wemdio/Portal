/**
 * Линковка сделки со связанными данными:
 * - переписка ТГ по contact_tg_username → sales_chat_dialogs.peer_username
 * - расшифровки звонков по домену сайта → sales_chat_messages.text ILIKE
 *   (в диалоге, привязанном к сделке; клиент присылал ссылку и потом созвон)
 *
 * Возвращает найденные dialog_id + список tg_message_id-ов транскриптов.
 * Далее contextBuilder тянет собственно тексты сообщений/транскриптов.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const MESSAGE_LIMIT = Number(process.env.SALES_AI_CHAT_MSG_LIMIT ?? 40);

export interface LeadLinks {
  dialog_id: string | null;
  transcript_ids: string[];
}

export interface LeadForLinking {
  id: number;
  contact_tg_username: string | null;
  company_website: string | null;
}

/**
 * Находит связанный диалог + расшифровки для одной сделки.
 */
export async function linkLead(
  db: SupabaseClient,
  lead: LeadForLinking,
): Promise<LeadLinks> {
  const links: LeadLinks = { dialog_id: null, transcript_ids: [] };

  // 1. Диалог по TG-юзеру
  if (lead.contact_tg_username) {
    const uname = lead.contact_tg_username.toLowerCase();
    const { data: dialogs, error } = await db
      .from('sales_chat_dialogs')
      .select('id, tg_peer_id, peer_username, last_message_at')
      .ilike('peer_username', uname)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) throw new Error(`linkLead dialog: ${error.message}`);
    if (dialogs && dialogs.length > 0) {
      links.dialog_id = (dialogs[0] as { id: string }).id;
    }
  }

  // 2. Транскрипты — если есть диалог и есть сайт, ищем упоминания домена
  //    в сообщениях этого диалога; для каждого такого сообщения смотрим,
  //    не привязана ли к нему транскрипция.
  //    Fallback: если диалога нет — ищем сайт в переписках всех sales-chat
  //    аккаунтов (менеджеры Егор/Саша) за последние 90 дней.
  if (lead.company_website) {
    const site = lead.company_website.toLowerCase();
    const tsIds = await findTranscriptsForSite(db, site, links.dialog_id);
    links.transcript_ids = tsIds;
  }

  return links;
}

async function findTranscriptsForSite(
  db: SupabaseClient,
  site: string,
  dialogId: string | null,
): Promise<string[]> {
  // Ограничиваем окно: 90 дней назад.
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

  // Ищем tg_chat_id, где в тексте сообщения (в диалоге) встречается сайт.
  let q = db
    .from('sales_chat_messages')
    .select('tg_peer_id, sent_at')
    .ilike('text', `%${site}%`)
    .gte('sent_at', since)
    .limit(50);
  if (dialogId) q = q.eq('dialog_id', dialogId);

  const { data: msgs, error: msgErr } = await q;
  if (msgErr) return [];
  if (!msgs?.length) return [];

  const peerIds = Array.from(new Set(
    msgs.map((m) => (m as { tg_peer_id: number }).tg_peer_id).filter(Boolean),
  ));
  if (!peerIds.length) return [];

  // Транскрипты по этим peer_id — те что готовы (completed).
  const { data: transcripts, error: tErr } = await db
    .from('tg_video_transcripts')
    .select('id')
    .in('tg_chat_id', peerIds)
    .eq('status', 'completed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);
  if (tErr) return [];
  return (transcripts ?? []).map((t) => (t as { id: string }).id);
}

/**
 * Забирает последние N сообщений из диалога, направление и текст.
 * Возвращает готовый форматированный текст для промта.
 */
export async function fetchChatMessages(
  db: SupabaseClient,
  dialogId: string | null,
): Promise<{ text: string; count: number; lastMessageAt: string | null }> {
  if (!dialogId) return { text: '', count: 0, lastMessageAt: null };

  const { data, error } = await db
    .from('sales_chat_messages')
    .select('direction, sender_name, sent_at, text')
    .eq('dialog_id', dialogId)
    .not('text', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(MESSAGE_LIMIT);
  if (error || !data?.length) return { text: '', count: 0, lastMessageAt: null };

  // Разворачиваем в хронологический порядок для чтения.
  const msgs = [...data].reverse() as Array<{
    direction: string; sender_name: string | null; sent_at: string; text: string;
  }>;
  const lines = msgs.map((m) => {
    const who = m.direction === 'out' ? `МЕНЕДЖЕР (${m.sender_name ?? '?'})` : 'КЛИЕНТ';
    const when = m.sent_at.slice(0, 16).replace('T', ' ');
    return `[${when}] ${who}: ${m.text}`;
  });
  return {
    text: lines.join('\n'),
    count: msgs.length,
    lastMessageAt: msgs[msgs.length - 1]?.sent_at ?? null,
  };
}

export async function fetchTranscripts(
  db: SupabaseClient,
  transcriptIds: string[],
): Promise<{ text: string; count: number; lastTranscriptAt: string | null }> {
  if (!transcriptIds.length) return { text: '', count: 0, lastTranscriptAt: null };

  const { data, error } = await db
    .from('tg_video_transcripts')
    .select('id, created_at, sender_name, duration_seconds, text')
    .in('id', transcriptIds)
    .order('created_at', { ascending: false });
  if (error || !data?.length) return { text: '', count: 0, lastTranscriptAt: null };

  const items = data as Array<{
    id: string; created_at: string; sender_name: string | null;
    duration_seconds: number | null; text: string;
  }>;
  const parts = items.map((t) => {
    const dur = t.duration_seconds ? `${Math.round(t.duration_seconds)}с` : '?';
    const when = t.created_at.slice(0, 16).replace('T', ' ');
    return `── Транскрипт (${when}, ${dur}, ${t.sender_name ?? '?'}) ──\n${t.text}`;
  });

  return {
    text: parts.join('\n\n'),
    count: items.length,
    lastTranscriptAt: items[0]?.created_at ?? null,
  };
}
