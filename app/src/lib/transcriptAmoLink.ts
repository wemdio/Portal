/**
 * Прямая привязка транскриптов видеозвонков к сделкам AMO.
 *
 * Менеджеры подписывают записи встреч в групповых чатах как
 *   «#34548997| https://kkt63.ru/ | вела с автоаутрича...»
 * где число — номер сделки AMO (amo_leads.amo_id). Старая связка транскриптов
 * по TG-юзернейму клиента на групповые чаты не работает, поэтому линк
 * материализуем в таблице transcript_amo_lead_link.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Достаёт #<номер сделки AMO> из подписи к видео; 6–10 цифр после «#». */
export function parseAmoDealFromCaption(caption: string | null | undefined): number | null {
  if (!caption) return null;
  const m = caption.match(/#\s?(\d{6,10})(?!\d)/);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isSafeInteger(num) ? num : null;
}

const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]{1,}\.[a-z]{2,10})/gi;
/** Свои домены в подписях встречаются (полезные ссылки) — это не клиент. */
const OWN_DOMAINS = new Set(['polzaagency.ru']);

/** Домены-кандидаты из подписи (сайт клиента без #номера сделки). */
export function parseSitesFromCaption(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const out = new Set<string>();
  for (const m of caption.toLowerCase().matchAll(DOMAIN_RE)) {
    const domain = m[1];
    if (!OWN_DOMAINS.has(domain)) out.add(domain);
  }
  return [...out];
}

/**
 * Best-effort: создаёт transcript_amo_lead_link по #номеру из подписи.
 * Ошибка линка не должна ронять транскрипцию — глотаем и возвращаем false.
 */
export async function linkTranscriptToAmoLead(
  db: SupabaseClient,
  transcriptId: string,
  caption: string | null | undefined,
): Promise<boolean> {
  const amoDealNumber = parseAmoDealFromCaption(caption);
  if (!amoDealNumber) return false;
  try {
    const { data: leads, error: leadErr } = await db
      .from('amo_leads')
      .select('id')
      .eq('amo_id', amoDealNumber)
      .limit(1);
    if (leadErr) throw new Error(leadErr.message);
    const leadId = (leads?.[0] as { id: number } | undefined)?.id;
    if (!leadId) return false;
    const { error: linkErr } = await db
      .from('transcript_amo_lead_link')
      .upsert(
        { transcript_id: transcriptId, amo_lead_id: leadId, confidence: 1.0, method: 'caption_deal_number' },
        { onConflict: 'transcript_id,amo_lead_id', ignoreDuplicates: true },
      );
    if (linkErr) throw new Error(linkErr.message);
    return true;
  } catch (error) {
    console.warn(
      `[tg-transcribe] Не удалось привязать транскрипт ${transcriptId} к сделке #${amoDealNumber}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Fallback-линк по сайту клиента в подписи: ищем активные сделки
 * (не won/lost) с этим доменом в company_website или названии. Линкуем
 * только если матч ровно один — «1001polis» или «uprav» ведут на несколько
 * сделок, неоднозначное угадывать нельзя.
 */
export async function linkTranscriptBySite(
  db: SupabaseClient,
  transcriptId: string,
  caption: string | null | undefined,
): Promise<boolean> {
  const sites = parseSitesFromCaption(caption);
  if (!sites.length) return false;
  try {
    const leadIds = new Set<number>();
    for (const site of sites) {
      const { data: leads, error } = await db
        .from('amo_leads')
        .select('id, company_website, name')
        .not('status_id', 'in', '(142,143)')
        .or(`company_website.ilike.%${site}%,name.ilike.%${site}%`)
        .limit(50);
      if (error) throw new Error(error.message);
      for (const lead of (leads ?? []) as Array<{ id: number }>) leadIds.add(lead.id);
    }
    if (leadIds.size !== 1) return false;
    const leadId = [...leadIds][0];
    const { error: linkErr } = await db
      .from('transcript_amo_lead_link')
      .upsert(
        { transcript_id: transcriptId, amo_lead_id: leadId, confidence: 0.8, method: 'caption_heuristic' },
        { onConflict: 'transcript_id,amo_lead_id', ignoreDuplicates: true },
      );
    if (linkErr) throw new Error(linkErr.message);
    return true;
  } catch (error) {
    console.warn(
      `[tg-transcribe] Не удалось привязать транскрипт ${transcriptId} по сайту из подписи:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Пытается привязать транскрипт: сначала #номер, потом сайт. */
export async function linkTranscriptToLead(
  db: SupabaseClient,
  transcriptId: string,
  caption: string | null | undefined,
): Promise<boolean> {
  return (await linkTranscriptToAmoLead(db, transcriptId, caption))
    || (await linkTranscriptBySite(db, transcriptId, caption));
}
