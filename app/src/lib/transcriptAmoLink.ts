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
