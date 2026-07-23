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
  it('маркетинг: заполняет все ожидаемые колонки', () => {
    const row = buildRow(baseLead, marketingConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      'https://polzaagency.amocrm.ru/leads/detail/12345',
      'UTM source: yandex\nUTM medium: cpc',
      'Я.Директ',
      '2026-07-01',
      '79001234567',
      'ivan@example.com',
      'Иванов Иван',
      'Софья',
      'Лиды Директ',
      '12345',
    ]);
  });

  it('аутрич: заполняет только свой набор колонок', () => {
    const outreachLead: AmoLead = { ...baseLead, status_name: 'Назначена встреча' };
    const row = buildRow(outreachLead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row).toEqual([
      'Иванов Иван',
      '79001234567',
      'ivan@example.com',
      'ООО Ромашка',
      'romashka.ru',
      '2026-07-01',
      'Назначена встреча',
      '12345',
    ]);
  });

  it('пустые поля пишет как пустая строка, не null', () => {
    const lead: AmoLead = { ...baseLead, contact_phone: null, contact_email: null };
    const row = buildRow(lead, outreachConfig, 'polzaagency.amocrm.ru');
    expect(row[1]).toBe('');
    expect(row[2]).toBe('');
  });
});
