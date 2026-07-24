import { buildRow, type AmoLead } from '@/lib/leadsReport/rowBuilder';
import { marketingConfig, outreachConfig } from '@/lib/leadsReport/config';

const baseLead: AmoLead = {
  amo_id: 12345,
  name: 'Иванов Иван',
  status_name: 'Первый контакт',
  contact_phone: '79001234567',
  contact_email: 'ivan@example.com',
  company_name: 'ООО Ромашка',
  company_website: 'romashka.ru',
  responsible_name: 'Софья',
  created_at: '2026-07-01T10:15:00Z',
  raw: {
    custom_fields_values: [
      { field_name: 'utm_source', values: [{ value: 'yandex' }] },
      { field_name: 'utm_medium', values: [{ value: 'cpc' }] },
    ],
  },
};

describe('buildRow', () => {
  it('маркетинг: заполняет 9 автоматических колонок под структуру «Лиды маркетинг», ручные оставляет пустыми, AMO id пишет в позицию N (index 13)', () => {
    const row = buildRow(baseLead, marketingConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      'https://polzaagency.amocrm.ru/leads/detail/12345', // A: Ссылка на лид в амо
      'UTM source: yandex\nUTM medium: cpc',              // B: UTM
      'Я.Директ',                                          // C: Площадка
      '2026-07-01',                                        // D: Дата
      '79001234567',                                       // E: Телефон
      'ivan@example.com',                                  // F: email
      'Иванов Иван',                                       // G: Имя
      '',                                                  // H: Дата последнего контакта (ручная)
      '',                                                  // I: Качество лида (ручная)
      'Софья',                                             // J: Кто обрабатывает лид
      '',                                                  // K: На чем остановились (ручная)
      '',                                                  // L: метрика (ручная)
      'Лиды Директ',                                       // M: источник для отчета по маркетингу
      '12345',                                             // N: AMO id
    ]);
  });

  it('аутрич: заполняет 6 автоматических колонок под структуру боевого листа, ручные оставляет пустыми, AMO id пишет в позицию P (index 15)', () => {
    const outreachLead: AmoLead = { ...baseLead, status_name: 'Назначена встреча' };
    const row = buildRow(outreachLead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      '',              // A: Оффер (ручная)
      '',              // B: Сфера деятельности (ручная)
      'Иванов Иван',   // C: Имя
      '79001234567',   // D: Контакт
      '',              // E: Ком-й (ручная)
      'ivan@example.com', // F: Email
      'ООО Ромашка',   // G: Организация
      'romashka.ru',   // H: Сайт
      '2026-07-01',    // I: Дата передачи лида
      '',              // J: Из какой кампании (ручная)
      '',              // K: @dropdown
      '',              // L: Статус (ручная)
      '',              // M: Дата последнего контакта (ручная)
      '',              // N: Качество лида (ручная)
      '',              // O: Кто обрабатывает лид (ручная)
      '12345',         // P: AMO id (служебная — для дедупа)
    ]);
  });

  it('пустые контактные поля пишет как пустая строка, не null', () => {
    const lead: AmoLead = { ...baseLead, contact_phone: null, contact_email: null };
    const row = buildRow(lead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row[3]).toBe(''); // D: Контакт
    expect(row[5]).toBe(''); // F: Email
  });
});
