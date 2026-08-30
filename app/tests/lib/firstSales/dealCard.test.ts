import { readDealCardFields } from '@/lib/firstSales/dealCard';

function raw(fields: Array<{ field_name: string; values: unknown[] }>) {
  return { custom_fields_values: fields };
}

const one = (name: string, value: unknown) => ({ field_name: name, values: [{ value }] });

describe('readDealCardFields', () => {
  it('содержательные поля проходят', () => {
    const fields = readDealCardFields(raw([one('Источник', 'Аутрич'), one('ИНН', '7714379242')]));
    expect(fields).toEqual([
      { name: 'Источник', value: 'Аутрич' },
      { name: 'ИНН', value: '7714379242' },
    ]);
  });

  it('техническая разметка форм и рекламы скрыта', () => {
    const fields = readDealCardFields(
      raw([
        one('utm_source', 'yandex'),
        one('utm_campaign', '12345'),
        one('COOKIES', '_ym_uid=1'),
        one('FORMID', '99'),
        one('_ym_uid', '17'),
        one('yclid', '42'),
        one('Источник', 'Аутрич'),
      ]),
    );
    expect(fields).toEqual([{ name: 'Источник', value: 'Аутрич' }]);
  });

  it('латиница сама по себе не признак технического поля', () => {
    // Telegram и CTA названы латиницей и вполне содержательны — правило
    // «прячем всё латиницей» выбросило бы их вместе с utm-метками.
    const fields = readDealCardFields(raw([one('Telegram', '@user'), one('CTA', 'Записаться')]));
    expect(fields.map((f) => f.name)).toEqual(['Telegram', 'CTA']);
  });

  it('регистр в названии не спасает техническое поле от отсева', () => {
    expect(readDealCardFields(raw([one('Utm_Source', 'yandex')]))).toEqual([]);
  });

  it('мультиселект склеивается, а не обрезается до первого значения', () => {
    // «Аутрич, ЛинкедИн» и «Аутрич» — разные ответы, и терять хвост нельзя.
    const fields = readDealCardFields(
      raw([{ field_name: 'Услуги', values: [{ value: 'Аутрич' }, { value: 'ЛинкедИн' }] }]),
    );
    expect(fields).toEqual([{ name: 'Услуги', value: 'Аутрич, ЛинкедИн' }]);
  });

  it('пустые значения не дают строк', () => {
    const fields = readDealCardFields(
      raw([one('Оффер', ''), one('Сайт', null), { field_name: 'Контур', values: [] }]),
    );
    expect(fields).toEqual([]);
  });

  it('сломанный raw не роняет разбор', () => {
    expect(readDealCardFields(null)).toEqual([]);
    expect(readDealCardFields({})).toEqual([]);
    expect(readDealCardFields({ custom_fields_values: 'не массив' })).toEqual([]);
    expect(readDealCardFields({ custom_fields_values: [null, 'мусор'] })).toEqual([]);
  });

  it('числа приводятся к строке, а не выбрасываются', () => {
    expect(readDealCardFields(raw([one('Сумма продления, ₽', 159000)]))).toEqual([
      { name: 'Сумма продления, ₽', value: '159000' },
    ]);
  });
});
