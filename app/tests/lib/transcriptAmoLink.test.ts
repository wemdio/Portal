import type { SupabaseClient } from '@supabase/supabase-js';
import {
  linkTranscriptBySite,
  linkTranscriptToAmoLead,
  parseAmoDealFromCaption,
  parseSitesFromCaption,
} from '@/lib/transcriptAmoLink';
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

describe('parseSitesFromCaption', () => {
  it('достаёт домены с протоколом, www и без', () => {
    expect(parseSitesFromCaption('https://itprotect.ru/')).toEqual(['itprotect.ru']);
    expect(parseSitesFromCaption('Заявка: experum.ru | обсудили')).toEqual(['experum.ru']);
    expect(parseSitesFromCaption('www.prpartner.ru')).toEqual(['prpartner.ru']);
  });

  it('исключает свой домен и не ловит числа/даты', () => {
    expect(parseSitesFromCaption('см. polzaagency.ru/clients и ОС 09.09, чек 259 к')).toEqual([]);
    expect(parseSitesFromCaption('Бинант - продление, условия возврата')).toEqual([]);
  });
});

describe('linkTranscriptBySite', () => {
  it('линкует при единственном активном матче (confidence 0.8, caption_heuristic)', async () => {
    const db = createMockSupabase({
      tables: {
        amo_leads: [
          { id: 90, amo_id: 34156879, name: '@ztnalex', company_website: 'itprotect.ru', status_id: 123 },
          // закрытая сделка того же клиента не считается
          { id: 91, amo_id: 11111111, name: 'itprotect.ru старая', company_website: 'itprotect.ru', status_id: 143 },
        ],
      },
    });
    const ok = await linkTranscriptBySite(db as unknown as SupabaseClient, 'tr-10', 'https://itprotect.ru/');
    expect(ok).toBe(true);
    expect(db.getRows('transcript_amo_lead_link')).toEqual([
      { id: 'mock-transcript_amo_lead_link-1', transcript_id: 'tr-10', amo_lead_id: 90, confidence: 0.8, method: 'caption_heuristic' },
    ]);
  });

  it('не линкует при неоднозначном матче', async () => {
    const db = createMockSupabase({
      tables: {
        amo_leads: [
          { id: 90, name: 'uprav один', company_website: 'uprav.ru', status_id: 123 },
          { id: 91, name: 'uprav два', company_website: 'uprav.ru', status_id: 124 },
        ],
      },
    });
    expect(await linkTranscriptBySite(db as unknown as SupabaseClient, 'tr-11', '#Продление | https://uprav.ru/')).toBe(false);
    expect(db.getRows('transcript_amo_lead_link')).toEqual([]);
  });
});
