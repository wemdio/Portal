import {
  amoDateToDayKey,
  mapAmoRenewals,
  normalizeAmount,
  readCustomField,
  type AmoLeadRow,
  type AmoStatusEventRow,
  type AmoStatusRow,
} from '@/lib/renewals/amoRenewals';

/** Этапы боевой воронки «Вторичные (и не только) продажи» — те же номера и
 *  тот же `sort`, что в AMO, чтобы тест ловил в том числе путаницу «Пауза
 *  идёт после Продлено, значит она тоже продление». */
const statuses: AmoStatusRow[] = [
  { status_id: 87712790, status_name: 'Передан в работу', sort: 20 },
  { status_id: 87712810, status_name: 'Продление обсуждается', sort: 70 },
  { status_id: 87712814, status_name: 'Счет / договор на продление', sort: 80 },
  { status_id: 87712818, status_name: 'Продлено', sort: 90 },
  { status_id: 87712822, status_name: 'Пауза', sort: 100 },
  { status_id: 87712830, status_name: 'Отвал / не продлен', sort: 120 },
];

/** Полночь 17.08.2026 по МСК в unix-секундах — ровно так AMO хранит поля-даты. */
const AUG_17 = 1786914000;

function field(name: string, value: string | number) {
  return { field_name: name, values: [{ value }] };
}

function lead(over: Partial<AmoLeadRow> = {}, fields: unknown[] = []): AmoLeadRow {
  return {
    amo_id: 1,
    name: 'Заявка с сайта',
    company_name: 'ООО Ромашка',
    responsible_name: 'Вова С.',
    status_id: 87712818,
    status_name: 'Продлено',
    raw: { custom_fields_values: fields },
    ...over,
  };
}

function statusEvent(over: Partial<AmoStatusEventRow> = {}): AmoStatusEventRow {
  return { amo_deal_id: 1, to_value: '87712818', changed_at: '2026-08-17T10:00:00.000Z', ...over };
}

describe('amoDateToDayKey', () => {
  it('unix-полночь по МСК не съезжает на вчера', () => {
    // Наивное срезание по UTC дало бы 2026-08-16: AMO пишет полночь МСК как
    // 21:00 предыдущего дня.
    expect(amoDateToDayKey(String(AUG_17))).toBe('2026-08-17');
  });

  it('принимает ISO-строку', () => {
    expect(amoDateToDayKey('2026-08-17')).toBe('2026-08-17');
  });

  it('мусор и пустоту отдаёт как null, а не как «сегодня»', () => {
    expect(amoDateToDayKey(null)).toBeNull();
    expect(amoDateToDayKey('')).toBeNull();
    expect(amoDateToDayKey('скоро')).toBeNull();
    expect(amoDateToDayKey('0')).toBeNull();
  });
});

describe('normalizeAmount', () => {
  it('число проходит как есть', () => {
    expect(normalizeAmount('159000')).toBe('159000');
  });

  it('ноль — это «сумму не заполнили», а не бесплатное продление', () => {
    expect(normalizeAmount('0')).toBeNull();
    expect(normalizeAmount(' 0,00 ')).toBeNull();
  });

  it('нечисловое значение не глотается молча — уходит дальше как есть', () => {
    // Пусть его покажет амбером таблица, а не спрячет этот слой.
    expect(normalizeAmount('около 150к')).toBe('около 150к');
  });
});

describe('readCustomField', () => {
  it('достаёт первое значение поля по имени', () => {
    const raw = { custom_fields_values: [field('Сумма продления, ₽', 159000)] };
    expect(readCustomField(raw, 'Сумма продления, ₽')).toBe('159000');
  });

  it('сломанный или пустой raw не роняет разбор', () => {
    expect(readCustomField(null, 'Что угодно')).toBeNull();
    expect(readCustomField({}, 'Что угодно')).toBeNull();
    expect(readCustomField({ custom_fields_values: 'не массив' }, 'Что угодно')).toBeNull();
    expect(readCustomField({ custom_fields_values: [{ field_name: 'X', values: [] }] }, 'X')).toBeNull();
  });
});

describe('mapAmoRenewals — что считается продлением', () => {
  it('сделка на этапе «Продлено» попадает в выборку', () => {
    const { rows } = mapAmoRenewals([lead()], statuses, []);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_type).toBe('Продление');
  });

  it('сделка, побывавшая на «Продлено» и уехавшая в «Паузу», остаётся продлением', () => {
    // Иначе продление молча исчезало бы из истории задним числом, когда
    // продлённый клиент через месяц уходит на паузу.
    const rows = mapAmoRenewals(
      [lead({ status_id: 87712822, status_name: 'Пауза' })],
      statuses,
      [statusEvent()],
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('Пауза');
  });

  it('«Пауза» и «Отвал» сами по себе продлением не считаются, хотя sort у них больше 90', () => {
    const rows = mapAmoRenewals(
      [
        lead({ amo_id: 1, status_id: 87712822, status_name: 'Пауза' }),
        lead({ amo_id: 2, status_id: 87712830, status_name: 'Отвал / не продлен' }),
        lead({ amo_id: 3, status_id: 87712814, status_name: 'Счет / договор на продление' }),
      ],
      statuses,
      [],
    ).rows;
    expect(rows).toHaveLength(0);
  });

  it('этапы чужих воронок в истории игнорируются', () => {
    const rows = mapAmoRenewals(
      [lead({ status_id: 87712790, status_name: 'Передан в работу' })],
      statuses,
      [statusEvent({ to_value: '63384122' })],
    ).rows;
    expect(rows).toHaveLength(0);
  });

  it('тип вторичной сделки не фильтрует: реанимация — тоже деньги от клиента', () => {
    const rows = mapAmoRenewals(
      [lead({}, [field('Тип вторичной сделки', 'реанимация')])],
      statuses,
      [],
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('реанимация');
  });
});

describe('mapAmoRenewals — поля строки', () => {
  it('дата и сумма берутся из полей карточки, а не из даты перетаскивания', () => {
    const { rows } = mapAmoRenewals(
      [
        lead({}, [
          field('Дата оплаты продления', AUG_17),
          field('Сумма продления, ₽', 93500),
        ]),
      ],
      statuses,
      // Карточку двигали 20.08 — на дату оплаты это влиять не должно.
      [statusEvent({ changed_at: '2026-08-20T09:00:00.000Z' })],
    );
    expect(rows[0].payment_date).toBe('2026-08-17');
    expect(rows[0].budget).toBe('93500');
  });

  it('незаполненные дата и сумма дают null — строка уйдёт в «без даты»/«без суммы»', () => {
    const { rows } = mapAmoRenewals([lead()], statuses, []);
    expect(rows[0].payment_date).toBeNull();
    expect(rows[0].budget).toBeNull();
  });

  it('клиент — название компании, имя сделки только запасной вариант', () => {
    const withCompany = mapAmoRenewals([lead()], statuses, []).rows[0];
    const withoutCompany = mapAmoRenewals([lead({ company_name: null })], statuses, []).rows[0];
    expect(withCompany.client).toBe('ООО Ромашка');
    expect(withoutCompany.client).toBe('Заявка с сайта');
  });

  it('дата договора — самый ранний переход на «Счет / договор на продление»', () => {
    const { rows } = mapAmoRenewals(
      [lead()],
      statuses,
      [
        statusEvent({ to_value: '87712814', changed_at: '2026-08-14T08:00:00.000Z' }),
        // Возврат на этап после правок в документах не должен сдвигать дату.
        statusEvent({ to_value: '87712814', changed_at: '2026-08-19T08:00:00.000Z' }),
        statusEvent({ changed_at: '2026-08-20T08:00:00.000Z' }),
      ],
    );
    expect(rows[0].contract_date).toBe('2026-08-14');
  });

  it('id помечен префиксом сделки AMO', () => {
    expect(mapAmoRenewals([lead({ amo_id: 25642515 })], statuses, []).rows[0].id).toBe('amo-25642515');
  });
});

describe('mapAmoRenewals — история периодов для цикла', () => {
  it('конец оплаченного периода отдаётся в форме project_periods', () => {
    const { periods } = mapAmoRenewals(
      [lead({ amo_id: 7 }, [field('Дата окончания оплаченного периода', AUG_17)])],
      statuses,
      [],
    );
    expect(periods).toEqual([{ project_id: 'amo-7', period_start: null, period_end: '2026-08-17' }]);
  });

  it('без заполненного поля периода не выдумываются', () => {
    expect(mapAmoRenewals([lead()], statuses, []).periods).toHaveLength(0);
  });
});
