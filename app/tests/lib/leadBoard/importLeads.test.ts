/** @jest-environment node */

import * as XLSX from 'xlsx';
import { parseImportedCsv, parseImportedXlsx, parseImportDate } from '@/lib/leadBoard/importLeads';

const ASTI_HEADER = 'Контакт,Email,Имя,Организация,Сайт,Запрос клиента,Качество лида,Комментарий,Из какой кампании,После какого письма пришел лид,Дата лида,Взяли в работу';

describe('parseImportedCsv', () => {
  it('маппит базовый формат Asti Group со всеми колонками', () => {
    const csv = `${ASTI_HEADER}
896190599001,ooogcrb@mail.ru,Ольга Валерьевна,ГК Романовский Бройлер,rombr.ru,"Здравствуйте! наберите 896190599001",не заинтересован,направили предложение,ASTI GROUP 2GIS,3,24/08/2025,TRUE
89001234567,,,ООО Без Почты,,Позвонить,не отвечает,,Asti group,2,9.9.2025,x`;

    const r = parseImportedCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      lead_email: 'ooogcrb@mail.ru',
      lead_name: 'Ольга Валерьевна',
      company_name: 'ГК Романовский Бройлер',
      phone: '896190599001',
      website: 'rombr.ru',
      request_text: 'Здравствуйте! наберите 896190599001',
      quality: 'не заинтересован',
      comment: 'направили предложение',
      campaign_name: 'ASTI GROUP 2GIS',
      step_number: 3,
      taken: true,
      sourceIndex: 1,
    });
    expect(Date.parse(r.rows[0].reply_timestamp!)).toBe(Date.UTC(2025, 7, 24));
    // Вторая строка: без email — но с телефоном → импортируется
    expect(r.rows[1].lead_email).toBeNull();
    expect(r.rows[1].phone).toBe('89001234567');
    expect(Date.parse(r.rows[1].reply_timestamp!)).toBe(Date.UTC(2025, 8, 9));
    expect(r.rows[1].taken).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('формат АДК с колонкой ИНН → ИНН в ignoredColumns', () => {
    const csv = `Контакт,Email,Имя,Организация,ИНН,Сайт,Запрос клиента,Качество лида,Комментарий,Из какой кампании,После какого письма пришел лид,Дата лида,Взяли в работу
89060571212,office@vergiz.ru,Алексей,ВЕРГИЗ,7727826314,vergiz.ru,Напишите Алексей!,ответил,,Вакансия:Логист,1,02/07/2026,FALSE`;

    const r = parseImportedCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].company_name).toBe('ВЕРГИЗ');
    expect(r.ignoredColumns).toEqual(['ИНН']);
  });

  it('неизвестное «Качество лида» → null + warning; дата мусорная → null', () => {
    const csv = `${ASTI_HEADER}
89000000000,a@b.ru,,,,,горячий клиент,,,1,вчера,`;

    const r = parseImportedCsv(csv);
    expect(r.rows[0].quality).toBeNull();
    expect(r.rows[0].reply_timestamp).toBeNull();
    expect(r.warnings.some((w) => w.includes('горячий клиент'))).toBe(true);
  });

  it('строка с данными, но без email И контакта → skipped с номером строки', () => {
    const csv = `${ASTI_HEADER}
,,Иван Безконтактный,,,,,,,,,
89000000000,a@b.ru,,,,,,,,,,`;

    const r = parseImportedCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toEqual([{ index: 1, reason: 'нет email и контакта' }]);
  });

  it('полностью пустая строка молча игнорируется (не мусорит в skipped)', () => {
    const csv = `${ASTI_HEADER}
,,,,,,,,,,,
89000000000,a@b.ru,,,,,,,,,,`;

    const r = parseImportedCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('заголовок без знакомых колонок → warning, строк нет', () => {
    const r = parseImportedCsv('foo,bar,baz\n1,2,3');
    expect(r.rows).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('не найдено ни одной знакомой колонки'))).toBe(true);
    expect(r.ignoredColumns).toEqual(['foo', 'bar', 'baz']);
  });

  it('обрезает до IMPORT_MAX_ROWS с warning', async () => {
    const { IMPORT_MAX_ROWS } = await import('@/lib/leadBoard/importLeads');
    const lines = [`Email,Контакт`];
    for (let i = 0; i < IMPORT_MAX_ROWS + 5; i++) lines.push(`lead${i}@x.ru,8900000000${i % 10}`);
    const r = parseImportedCsv(lines.join('\n'));
    expect(r.rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(r.warnings.some((w) => w.includes('обрезан'))).toBe(true);
  });
});

describe('parseImportedXlsx', () => {
  it('парсит настоящий xlsx (генерируем в тесте)', () => {
    const aoa = [
      ['Email', 'Имя', 'Качество лида', 'Дата лида', 'Взяли в работу'],
      ['x@y.ru', 'Мария', 'есть интерес', '15/09/25', 'TRUE'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Лиды');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const r = parseImportedXlsx(buf);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      lead_email: 'x@y.ru',
      lead_name: 'Мария',
      quality: 'есть интерес',
      taken: true,
    });
    expect(Date.parse(r.rows[0].reply_timestamp!)).toBe(Date.UTC(2025, 8, 15));
  });
});

describe('parseImportDate', () => {
  it('форматы: dd.mm.yyyy, dd/mm/yy, ISO, мусор', () => {
    expect(Date.parse(parseImportDate('02.07.2026')!)).toBe(Date.UTC(2026, 6, 2));
    expect(Date.parse(parseImportDate('24/08/25')!)).toBe(Date.UTC(2025, 7, 24));
    expect(Date.parse(parseImportDate('2026-07-25')!)).toBe(Date.UTC(2026, 6, 25));
    expect(parseImportDate('вчера')).toBeNull();
    expect(parseImportDate('')).toBeNull();
    expect(parseImportDate(null)).toBeNull();
  });
});
