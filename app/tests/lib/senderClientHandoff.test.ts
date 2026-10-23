/** @jest-environment node */
/**
 * Передача лида клиенту из «Рассылки»: адреса копии из карточки проекта и
 * текст письма с цитатой ответа лида. Чистая логика без БД.
 */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

import {
  buildSenderHandoffBody,
  handoffLeadName,
  mergeHandoffCc,
  parseEmailList,
  splitHandoffEmails,
} from '@/lib/sender/clientHandoff';

describe('передача лида клиенту', () => {
  it('разбирает адреса передачи проекта: запятые, точки с запятой, пробелы, повторы', () => {
    expect(splitHandoffEmails(' Sales@Client.ru; boss@client.ru,  sales@client.ru  не-адрес ')).toEqual([
      'sales@client.ru',
      'boss@client.ru',
    ]);
  });

  it('цитирует ответ лида под легендой с датой по Москве', () => {
    const body = buildSenderHandoffBody('Знакомлю вас с коллегой.', { body: 'Интересно.\nПозвоните.', at: '2026-10-23T09:05:00Z' }, 'Иван');
    expect(body).toBe('Знакомлю вас с коллегой.\n\n23.10.2026, 12:05, Иван писал(а):\n> Интересно.\n> Позвоните.');
    expect(buildSenderHandoffBody('Текст', null, 'Иван')).toBe('Текст');
  });

  it('копия оператора: опечатку возвращает, а не выбрасывает молча', () => {
    expect(parseEmailList('boss@client.ru, boss@client, ,sales@client.ru')).toEqual({
      emails: ['boss@client.ru', 'sales@client.ru'],
      invalid: ['boss@client'],
    });
  });

  it('«ответить всем»: клиент и коллеги лида в копии, без нашего ящика и адресата', () => {
    expect(mergeHandoffCc(
      ['sales@client.ru'],
      ['Ivan@Lead.ru', 'we@our-box.ru', 'Colleague@lead.ru', 'sales@client.ru'],
      ['ivan@lead.ru', 'we@our-box.ru'],
    )).toEqual(['sales@client.ru', 'colleague@lead.ru']);
  });

  it('имя для приветствия: коллега — его имя, компания вместо имени — без имени', () => {
    const base = { recipientEmail: 'info@lead.ru', companyName: 'ООО Ромашка' };
    expect(handoffLeadName({ ...base, recipientName: 'Иван', replyFrom: 'info@lead.ru', replyFromName: 'Ivan P' })).toBe('Иван');
    expect(handoffLeadName({ ...base, recipientName: 'Иван', replyFrom: 'olga@lead.ru', replyFromName: 'Ольга' })).toBe('Ольга');
    expect(handoffLeadName({ ...base, recipientName: 'Иван', replyFrom: 'olga@lead.ru', replyFromName: null })).toBeNull();
    expect(handoffLeadName({ ...base, recipientName: 'ооо ромашка', replyFrom: 'info@lead.ru', replyFromName: null })).toBeNull();
  });
});
