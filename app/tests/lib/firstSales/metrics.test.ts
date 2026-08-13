import {
  CONTRACT_RULE_SINCE,
  computeFirstSalesSeries,
  type FirstSalesLeadRow,
} from '@/lib/firstSales/metrics';
import { MEETINGS_RELIABLE_SINCE, type MeetingLinkRow } from '@/lib/firstSales/meetings';
import type { FirstSalesPaymentRow } from '@/lib/firstSales/money';

function lead(over: Partial<FirstSalesLeadRow> = {}): FirstSalesLeadRow {
  return {
    amo_id: 1,
    name: 'Обычная сделка',
    responsible_name: 'Менеджер А',
    created_at: '2026-07-15T09:00:00.000Z',
    first_qualified_at: null,
    first_meeting_at: null,
    first_contract_at: null,
    won_at: null,
    history_complete: true,
    raw: {
      custom_fields_values: [
        { field_name: 'Источник', values: [{ value: 'Email Outreach' }] },
      ],
    },
    ...over,
  };
}

function meetingLink(over: Partial<MeetingLinkRow> = {}): MeetingLinkRow {
  return {
    amo_deal_id: 1,
    meeting_at: '2026-07-10T09:00:00.000Z',
    ...over,
  };
}

const from = new Date('2026-07-01T00:00:00.000Z');
// Конец июля по МСК, не по UTC: buildBuckets режет дни в МСК (см.
// firstSales/buckets.ts), и 2026-07-31T23:59:59.999Z — это уже
// 2026-08-01 02:59:59 МСК, то есть корзина 1 августа. 20:59:59.999Z —
// последний момент 31 июля именно в МСК.
const to = new Date('2026-07-31T20:59:59.999Z');

describe('computeFirstSalesSeries', () => {
  it('считает лидов по дате создания', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 }), lead({ amo_id: 2, created_at: '2026-07-16T09:00:00.000Z' })],
      [], from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(2);
    expect(res.series.find((b) => b.key === '2026-07-15')?.leads).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-16')?.leads).toBe(1);
  });

  it('мёртвые сделки и лид-магниты остаются в лидах', () => {
    // Отчёт продаж их выбрасывает; дашборд — нет, иначе прошлое едет.
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, name: 'Бот: Иван' })],
      [], from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.leadMagnets).toBe(1);
  });

  it('сделка с неполной историей не даёт договоров, но остаётся лидом; first_meeting_at (этап AMO) на встречи больше не влияет', () => {
    const res = computeFirstSalesSeries(
      [lead({
        history_complete: false,
        first_meeting_at: '2026-07-10T09:00:00.000Z',
        first_contract_at: '2026-07-12T09:00:00.000Z',
      })],
      [], // без привязок — старый источник встреч (этап AMO) больше не используется
      from, to, 'day', null,
    );
    expect(res.totals.leads).toBe(1);
    expect(res.totals.meetings).toBe(0);
    expect(res.totals.contracts).toBe(0);
  });

  it('фильтр по каналам применяется ко всем метрикам', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),                                            // text:email outreach
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Сайт' }] }] },
        }),                                                             // text:сайт
      ],
      [], from, to, 'day', ['text:email outreach'],
    );
    expect(res.totals.leads).toBe(1);
  });

  it('средний цикл и медиана считаются по оплаченным в периоде', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-11T00:00:00.000Z' }), // 10 дней
        lead({ amo_id: 2, created_at: '2026-07-01T00:00:00.000Z', won_at: '2026-07-21T00:00:00.000Z' }), // 20 дней
        lead({ amo_id: 3, created_at: '2026-01-01T00:00:00.000Z', won_at: '2026-07-31T00:00:00.000Z' }), // 211 дней
      ],
      [], from, to, 'day', null,
    );
    expect(res.totals.wonCount).toBe(3);
    expect(res.totals.cycleMedianDays).toBe(20);
    expect(Math.round(res.totals.cycleAvgDays ?? 0)).toBe(80);
  });

  it('пустая выборка не даёт NaN', () => {
    const res = computeFirstSalesSeries([], [], from, to, 'day', null);
    expect(res.totals.leads).toBe(0);
    expect(res.totals.cycleAvgDays).toBeNull();
    expect(res.totals.cycleMedianDays).toBeNull();
  });

  it('пустые корзины присутствуют в ряду', () => {
    const res = computeFirstSalesSeries([lead()], [], from, to, 'day', null);
    expect(res.series).toHaveLength(31);
    expect(res.series[0]).toEqual(
      expect.objectContaining({ key: '2026-07-01', leads: 0, meetings: 0 }),
    );
  });

  it('считает разбивку по источникам с пометкой неизвестных', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }),
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Нейровыдача' }] }] },
        }),
      ],
      [], from, to, 'day', null,
    );
    const unknown = res.bySource.find((s) => s.source === 'Нейровыдача');
    expect(unknown?.leads).toBe(1);
    expect(res.totals.noSourceLeads).toBe(0);
  });

  it('сделки с одним enum_id сливаются в строку, имя берётся от свежей', () => {
    const withEnum = (value: string, over: Partial<FirstSalesLeadRow>) =>
      lead({
        ...over,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value, enum_id: 11382029 }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [
        withEnum('Партнер', { amo_id: 1, created_at: '2026-07-10T09:00:00.000Z' }),
        withEnum('Партнёрка', { amo_id: 2, created_at: '2026-07-20T09:00:00.000Z' }),
      ],
      [], from, to, 'day', null,
    );

    expect(res.bySource).toHaveLength(1);
    expect(res.bySource[0]!.key).toBe('11382029');
    expect(res.bySource[0]!.source).toBe('Партнёрка');
    expect(res.bySource[0]!.leads).toBe(2);
  });

  it('сделка без источника попадает в отдельную строку и в noSourceLeads', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, raw: { custom_fields_values: [] } })],
      [], from, to, 'day', null,
    );
    expect(res.totals.noSourceLeads).toBe(1);
    expect(res.bySource.find((s) => s.key === 'none')?.leads).toBe(1);
  });

  it('«Контур = Маркетинг» больше ни на что не влияет', () => {
    const res = computeFirstSalesSeries(
      [lead({
        amo_id: 1,
        raw: { custom_fields_values: [{ field_name: 'Контур', values: [{ value: 'Маркетинг' }] }] },
      })],
      [], from, to, 'day', null,
    );
    expect(res.totals.noSourceLeads).toBe(1);
  });

  it('фильтр по источнику сужает итоги', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2)], [], from, to, 'day', ['111'],
    );
    expect(res.totals.leads).toBe(1);
    expect(res.bySource).toHaveLength(1);
  });

  it('availableSources считается ДО фильтра — иначе фильтр съедает сам себя', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2)], [], from, to, 'day', ['111'],
    );
    expect(res.availableSources.map((s) => s.key).sort()).toEqual(['111', '222']);
  });

  it('availableSources отсортирован по числу лидов', () => {
    const withEnum = (enumId: number, amoId: number) =>
      lead({
        amo_id: amoId,
        raw: {
          custom_fields_values: [
            { field_name: 'Источник', values: [{ value: `И-${enumId}`, enum_id: enumId }] },
          ],
        },
      });

    const res = computeFirstSalesSeries(
      [withEnum(111, 1), withEnum(222, 2), withEnum(222, 3)], [], from, to, 'day', null,
    );
    expect(res.availableSources[0]!.key).toBe('222');
    expect(res.availableSources[0]!.leads).toBe(2);
  });
});

describe('договоры считаются только с даты, когда этап начал означать договор', () => {
  // До 30.07.2026 этап «Согласование договора» ставили и когда договор реально
  // правили, и когда его просто отправили по просьбе клиента. За июнь 2026 туда
  // попали 169 сделок, из которых 162 умерли с нулевой суммой, — при том что
  // реальных договоров у продаж около двадцати в месяц. Разделить задним числом
  // нечем, поэтому старое не считаем вовсе.
  const cutoff = CONTRACT_RULE_SINCE.getTime();
  const before = new Date(cutoff - 5 * 24 * 60 * 60 * 1000).toISOString();
  const after = new Date(cutoff + 60 * 60 * 1000).toISOString();

  const wide = { from: new Date(cutoff - 60 * 24 * 60 * 60 * 1000), to: new Date(cutoff + 60 * 24 * 60 * 60 * 1000) };

  it('договор до даты правила не засчитывается', () => {
    const res = computeFirstSalesSeries(
      [lead({ created_at: before, first_contract_at: before })],
      [], wide.from, wide.to, 'month', null,
    );
    expect(res.totals.contracts).toBe(0);
  });

  it('договор после даты правила засчитывается', () => {
    const res = computeFirstSalesSeries(
      [lead({ created_at: before, first_contract_at: after })],
      [], wide.from, wide.to, 'month', null,
    );
    expect(res.totals.contracts).toBe(1);
  });

  it('окно целиком до правила помечено как недостоверное', () => {
    const res = computeFirstSalesSeries(
      [], [],
      new Date(cutoff - 60 * 24 * 60 * 60 * 1000),
      new Date(cutoff - 1),
      'month', null,
    );
    // UI обязан показать прочерк: ноль тут означал бы «договоров не было»,
    // хотя на самом деле мы отказались считать грязные данные.
    expect(res.totals.contractsReliable).toBe(false);
  });

  it('окно, захватывающее дату правила, помечено как достоверное', () => {
    const res = computeFirstSalesSeries([], [], wide.from, wide.to, 'month', null);
    expect(res.totals.contractsReliable).toBe(true);
  });
});

describe('встречи считаются по привязкам записей разговоров, а не по этапу AMO', () => {
  // Этап AMO «Встреча проведена + КП отправлено» давал 200+ встреч в месяц
  // против 64 у руководителя продаж — этап засорён. Руководитель считает
  // встречу так: есть запись разговора в чате встреч. Таблица
  // meeting_deal_links привязывает такие записи к сделкам; здесь проверяется
  // расчёт метрики поверх этих привязок.

  it('две записи одной сделки в один день — одна встреча', () => {
    // Одна встреча часто разрезана на несколько файлов: в боевых данных
    // denvic.tech дважды за один день, файлы 1.mp4 и 2.mp4.
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })],
      [
        meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-10T09:00:00.000Z' }),
        meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-10T15:00:00.000Z' }),
      ],
      from, to, 'day', null,
    );
    expect(res.totals.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-10')?.meetings).toBe(1);
  });

  it('две записи одной сделки в разные дни — две встречи', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })],
      [
        meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-10T09:00:00.000Z' }),
        meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-11T09:00:00.000Z' }),
      ],
      from, to, 'day', null,
    );
    expect(res.totals.meetings).toBe(2);
    expect(res.series.find((b) => b.key === '2026-07-10')?.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-11')?.meetings).toBe(1);
  });

  it('запись до MEETINGS_RELIABLE_SINCE не считается', () => {
    const cutoff = MEETINGS_RELIABLE_SINCE.getTime();
    const wide = {
      from: new Date(cutoff - 60 * 24 * 60 * 60 * 1000),
      to: new Date(cutoff + 60 * 24 * 60 * 60 * 1000),
    };
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })],
      [meetingLink({ amo_deal_id: 1, meeting_at: new Date(cutoff - 5 * 24 * 60 * 60 * 1000).toISOString() })],
      wide.from, wide.to, 'month', null,
    );
    expect(res.totals.meetings).toBe(0);
  });

  it('окно целиком раньше MEETINGS_RELIABLE_SINCE помечено как недостоверное', () => {
    const cutoff = MEETINGS_RELIABLE_SINCE.getTime();
    const res = computeFirstSalesSeries(
      [], [],
      new Date(cutoff - 60 * 24 * 60 * 60 * 1000),
      new Date(cutoff - 1),
      'month', null,
    );
    // UI обязан показать прочерк: ноль тут означал бы «встреч не было», хотя
    // на деле подписи к записям ещё не были регулярными и досчитать нечем.
    expect(res.totals.meetingsReliable).toBe(false);
  });

  it('окно, захватывающее дату правила, помечено как достоверное', () => {
    const cutoff = MEETINGS_RELIABLE_SINCE.getTime();
    const wide = {
      from: new Date(cutoff - 60 * 24 * 60 * 60 * 1000),
      to: new Date(cutoff + 60 * 24 * 60 * 60 * 1000),
    };
    const res = computeFirstSalesSeries([], [], wide.from, wide.to, 'month', null);
    expect(res.totals.meetingsReliable).toBe(true);
  });

  it('фильтр по каналам применяется к встречам через канал сделки', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1 }), // text:email outreach
        lead({
          amo_id: 2,
          raw: { custom_fields_values: [{ field_name: 'Источник', values: [{ value: 'Сайт' }] }] },
        }), // text:сайт
      ],
      [
        meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-10T09:00:00.000Z' }),
        meetingLink({ amo_deal_id: 2, meeting_at: '2026-07-11T09:00:00.000Z' }),
      ],
      from, to, 'day', ['text:email outreach'],
    );
    // Запись сама по себе не несёт канала — берём канал сделки. Без этого
    // фильтр по каналу для встреч не работал бы вовсе.
    expect(res.totals.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-10')?.meetings).toBe(1);
    expect(res.series.find((b) => b.key === '2026-07-11')?.meetings).toBe(0);
  });

  it('запись, привязанная к сделке вне выборки лидов, не роняет расчёт', () => {
    // Сделка могла прийти раньше окна (встреча в июле у сделки, созданной в
    // марте) и не попасть в `leads`, если вызывающий код не подтянул её через
    // extraDealIds в fetchFirstSalesLeads. computeFirstSalesSeries обязан не
    // упасть и всё равно посчитать встречу — просто без резолва канала.
    expect(() => computeFirstSalesSeries(
      [], // сделки #999 нет в выборке лидов вовсе
      [meetingLink({ amo_deal_id: 999, meeting_at: '2026-07-10T09:00:00.000Z' })],
      from, to, 'day', null,
    )).not.toThrow();

    const res = computeFirstSalesSeries(
      [],
      [meetingLink({ amo_deal_id: 999, meeting_at: '2026-07-10T09:00:00.000Z' })],
      from, to, 'day', null,
    );
    expect(res.totals.meetings).toBe(1);
  });
});


/**
 * Разбивка по менеджерам. Считается теми же правилами, что и разбивка по
 * источникам, — иначе два среза одного дашборда давали бы разные суммы, и
 * объяснить это было бы нечем.
 */
describe('разбивка по ответственным менеджерам', () => {
  it('складывает лидов, квалы и договоры по ответственному', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1, responsible_name: 'Иванов' }),
        lead({ amo_id: 2, responsible_name: 'Иванов', first_qualified_at: '2026-07-16T09:00:00.000Z' }),
        lead({ amo_id: 3, responsible_name: 'Петров' }),
      ],
      [], from, to, 'day', null,
    );

    const ivanov = res.byManager.find((m) => m.manager === 'Иванов');
    expect(ivanov).toMatchObject({ leads: 2, qualified: 1 });
    expect(res.byManager.find((m) => m.manager === 'Петров')?.leads).toBe(1);
  });

  it('сумма по менеджерам совпадает с общим числом лидов', () => {
    const res = computeFirstSalesSeries(
      [
        lead({ amo_id: 1, responsible_name: 'Иванов' }),
        lead({ amo_id: 2, responsible_name: 'Петров' }),
        lead({ amo_id: 3, responsible_name: null }),
      ],
      [], from, to, 'day', null,
    );
    expect(res.byManager.reduce((sum, m) => sum + m.leads, 0)).toBe(res.totals.leads);
  });

  /** Сделку без ответственного нельзя терять — это дыра в распределении. */
  it('сделки без ответственного идут отдельной строкой, а не пропадают', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, responsible_name: null }), lead({ amo_id: 2, responsible_name: '   ' })],
      [], from, to, 'day', null,
    );
    expect(res.byManager.find((m) => m.manager === 'Без ответственного')?.leads).toBe(2);
  });

  it('встречи попадают тому, за кем закреплена сделка', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, responsible_name: 'Иванов' })],
      [meetingLink({ amo_deal_id: 1, meeting_at: '2026-07-10T09:00:00.000Z' })],
      from, to, 'day', null,
    );
    expect(res.byManager.find((m) => m.manager === 'Иванов')?.meetings).toBe(1);
    expect(res.totals.meetings).toBe(1);
  });

  it('пустые строки не показываем: менеджер без событий в окне не нужен', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, responsible_name: 'Тихий', created_at: '2026-01-01T09:00:00.000Z' })],
      [], from, to, 'day', null,
    );
    expect(res.byManager).toHaveLength(0);
  });
});

/**
 * Деньги. Цифра, которую руководитель прочитает как «столько мы заработали»,
 * поэтому всё, что мы НЕ смогли отнести, обязано быть видно отдельно, а не
 * молча раствориться в занижении.
 */
describe('реальные деньги по ИНН', () => {
  const payment = (over: Partial<FirstSalesPaymentRow> = {}): FirstSalesPaymentRow => ({
    transaction_id: 1,
    occurred_at: '2026-07-20T09:00:00.000Z',
    amount: 100_000,
    payer_inn: '7709492845',
    payer_name: 'ООО «Ромашка»',
    amo_deal_id: 1,
    deal_matches: 1,
    renewal_state: 'first',
    ...over,
  });

  it('платёж ложится в общую сумму, к менеджеру и к источнику сделки', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, responsible_name: 'Иванов' })],
      [], from, to, 'day', null,
      [payment({ amount: 84_000 })],
    );
    expect(res.totals.money.received).toBe(84_000);
    expect(res.totals.money.payments).toBe(1);
    expect(res.byManager.find((m) => m.manager === 'Иванов')?.money).toBe(84_000);
    expect(res.bySource.find((s) => s.source === 'Email Outreach')?.money).toBe(84_000);
  });

  it('продление в первичку не идёт', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })], [], from, to, 'day', null,
      [payment({ renewal_state: 'renewal' })],
    );
    expect(res.totals.money.received).toBe(0);
    expect(res.totals.money.pending).toBe(0);
  });

  /** Занижение обязано быть видно: неразобранный кандидат — не ноль. */
  it('неразобранный кандидат не в деньгах, но и не потерян', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })], [], from, to, 'day', null,
      [payment({ renewal_state: 'pending', amount: 50_000 })],
    );
    expect(res.totals.money.received).toBe(0);
    expect(res.totals.money.pending).toBe(50_000);
    expect(res.totals.money.pendingPayments).toBe(1);
  });

  it('один ИНН на несколько сделок — в спорные, а не наугад к первой', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1, responsible_name: 'Иванов' })],
      [], from, to, 'day', null,
      [payment({ deal_matches: 2, amount: 30_000 })],
    );
    expect(res.totals.money.received).toBe(0);
    expect(res.totals.money.ambiguous).toBe(30_000);
    expect(res.byManager.find((m) => m.manager === 'Иванов')?.money).toBe(0);
  });

  it('возвраты и нули в «пришло денег» не попадают', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })], [], from, to, 'day', null,
      [payment({ amount: -10_000 }), payment({ transaction_id: 2, amount: 0 })],
    );
    expect(res.totals.money.received).toBe(0);
    expect(res.totals.money.payments).toBe(0);
  });

  it('платёж вне окна не считается', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })], [], from, to, 'day', null,
      [payment({ occurred_at: '2026-06-20T09:00:00.000Z' })],
    );
    expect(res.totals.money.received).toBe(0);
  });

  it('фильтр по каналу режет и деньги — они берут канал у сделки', () => {
    const res = computeFirstSalesSeries(
      [lead({ amo_id: 1 })], [], from, to, 'day', ['inbound'],
      [payment()],
    );
    expect(res.totals.money.received).toBe(0);
  });

  /** Покрытие ИНН — знаменатель честности карточки. */
  it('считает, у скольких договоров окна вообще заполнен ИНН', () => {
    const contractAt = new Date(CONTRACT_RULE_SINCE.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const withInn = lead({
      amo_id: 1,
      first_contract_at: contractAt,
      raw: {
        custom_fields_values: [
          { field_name: 'Источник', values: [{ value: 'Email Outreach' }] },
          { field_name: 'ИНН', values: [{ value: '7709492845' }] },
        ],
      },
    });
    const res = computeFirstSalesSeries(
      [withInn, lead({ amo_id: 2, first_contract_at: contractAt })],
      [], from, to, 'day', null, [],
    );
    expect(res.totals.contracts).toBe(2);
    expect(res.totals.money.contractsWithInn).toBe(1);
  });

  it('без платежей деньги — ноль, а не undefined', () => {
    const res = computeFirstSalesSeries([lead()], [], from, to, 'day', null);
    expect(res.totals.money.received).toBe(0);
    expect(res.byManager[0]?.money).toBe(0);
  });
});
