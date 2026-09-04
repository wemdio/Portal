import type { SupabaseClient } from '@supabase/supabase-js';
import { linkTranscriptToAmoLead, parseAmoDealFromCaption } from '@/lib/transcriptAmoLink';
import { createMockSupabase } from '../helpers/mockSupabase';

describe('parseAmoDealFromCaption', () => {
  // Реальные подписи менеджеров из базы.
  it('достаёт номер из подписи с пайпами и текстом', () => {
    expect(parseAmoDealFromCaption('#34548997| https://kkt63.ru/ | вела с автоаутрича, ОС 09.09')).toBe(34548997);
  });

  it('достаёт номер с пробелом после #', () => {
    expect(parseAmoDealFromCaption('#34973489 | bba.expert | обсудили ЦА')).toBe(34973489);
  });

  it('берёт первое #число из середины текста', () => {
    expect(parseAmoDealFromCaption('Встреча по # 35012643 axmit.com, продолжим в понедельник')).toBe(35012643);
  });

  it('null когда подписи нет или в ней нет #номера', () => {
    expect(parseAmoDealFromCaption(null)).toBeNull();
    expect(parseAmoDealFromCaption('Бинант - продление на новый продукт')).toBeNull();
    expect(parseAmoDealFromCaption('Продлили 159к')).toBeNull();
  });

  it('игнорирует числа без решётки и слишком короткие/длинные после #', () => {
    // 159к — сумма без #; номер из 4 цифр — не сделка.
    expect(parseAmoDealFromCaption('чек 259 к + после SDR')).toBeNull();
    expect(parseAmoDealFromCaption('#1234 мало цифр')).toBeNull();
    expect(parseAmoDealFromCaption('#12345678901 слишком много')).toBeNull();
  });
});

describe('linkTranscriptToAmoLead', () => {
  it('создаёт линк caption_deal_number по найденной сделке', async () => {
    const db = createMockSupabase({
      tables: {
        amo_leads: [{ id: 77, amo_id: 34548997 }],
      },
    });
    const ok = await linkTranscriptToAmoLead(db as unknown as SupabaseClient, 'tr-1', '#34548997| https://kkt63.ru/');
    expect(ok).toBe(true);
    expect(db.getRows('transcript_amo_lead_link')).toEqual([
      { id: 'mock-transcript_amo_lead_link-1', transcript_id: 'tr-1', amo_lead_id: 77, confidence: 1.0, method: 'caption_deal_number' },
    ]);
  });

  it('молча пропускает неизвестный номер и подпись без номера', async () => {
    const db = createMockSupabase({ tables: { amo_leads: [] } });
    expect(await linkTranscriptToAmoLead(db as unknown as SupabaseClient, 'tr-2', '#99999999 нет такой сделки')).toBe(false);
    expect(await linkTranscriptToAmoLead(db as unknown as SupabaseClient, 'tr-3', 'просто подпись')).toBe(false);
    expect(db.getRows('transcript_amo_lead_link')).toEqual([]);
  });

  it('не падает и возвращает false при ошибке БД', async () => {
    const db = createMockSupabase({ errorTables: { amo_leads: 'db down' } });
    await expect(linkTranscriptToAmoLead(db as unknown as SupabaseClient, 'tr-4', '#34548997')).resolves.toBe(false);
  });
});
