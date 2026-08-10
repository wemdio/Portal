import { SUMMARY_CHANNELS } from '@/lib/leadsReport/channels';
import {
  computeAllChannelMetrics,
  computeMetricsFromRows,
  type AmoLeadMetricRow,
  type AmoStatusEventRow,
  type AmoStatusMetricRow,
} from '@/lib/leadsReport/metrics';

const statuses: AmoStatusMetricRow[] = [
  { pipeline_id: 1, status_id: 10, status_name: 'Новый лид', sort: 10 },
  {
    pipeline_id: 1,
    status_id: 20,
    status_name: 'Квалифицированный лид',
    sort: 30,
  },
  {
    pipeline_id: 1,
    status_id: 30,
    status_name: 'Назначена встреча',
    sort: 40,
  },
  { pipeline_id: 1, status_id: 35, status_name: 'Не вышел на звонок', sort: 50 },
  {
    pipeline_id: 1,
    status_id: 40,
    status_name: 'Встреча проведена + КП отправлено',
    sort: 60,
  },
  { pipeline_id: 1, status_id: 50, status_name: 'Перенос', sort: 70 },
  { pipeline_id: 1, status_id: 142, status_name: 'Успешно', sort: 10000 },
  { pipeline_id: 1, status_id: 143, status_name: 'Закрыто', sort: 11000 },
];

let nextAmoId = 1;

function lead(
  fields: Record<string, string>,
  statusId: number,
  statusName: string,
  opts: { name?: string | null; amoId?: number; createdAt?: string } = {},
): AmoLeadMetricRow {
  return {
    amo_id: opts.amoId ?? nextAmoId++,
    pipeline_id: 1,
    status_id: statusId,
    status_name: statusName,
    name: opts.name ?? 'Сделка',
    created_at: opts.createdAt ?? '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    raw: {
      custom_fields_values: Object.entries(fields).map(
        ([field_name, value]) => ({
          field_name,
          values: [{ value }],
        }),
      ),
    },
  };
}

/** Переход этапа: `to` — куда перешли, `from` — откуда. */
function move(
  amoId: number,
  from: number,
  to: number,
  changedAt: string,
): AmoStatusEventRow {
  return {
    amo_deal_id: amoId,
    changed_at: changedAt,
    from_value: String(from),
    to_value: String(to),
  };
}

const WINDOW_START = new Date('2026-07-19T21:00:00.000Z');
const WINDOW_END = new Date('2026-07-24T15:00:00.000Z');

describe('computeMetricsFromRows', () => {
  it('считает пять каналов; «Успешно» в «Лидов», «Закрыто и не реализовано» — нет', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Маркетинг — только по явному маркеру «Контур»=«Маркетинг».
        lead({ Контур: 'Маркетинг' }, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Сайт', utm_medium: 'smm' }, 30, 'Назначена встреча'),
        lead({ Источник: 'Аутрич' }, 40, 'Встреча проведена + КП отправлено'),
        lead({ Источник: 'Партнер' }, 142, 'Успешно'),
        lead({ Источник: 'Telegram Outreach' }, 143, 'Закрыто'),
      ],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.map((item) => ({
      channel: item.channel.name,
      arrived: item.arrived,
      leads: item.qualifiedLeads,
      held: item.meetingsHeld,
      scheduled: item.meetingsScheduled,
    }))).toEqual([
      { channel: 'marketing', arrived: 1, leads: 1, held: 0, scheduled: 0 },
      { channel: 'smm', arrived: 1, leads: 1, held: 0, scheduled: 1 },
      { channel: 'outreach', arrived: 1, leads: 1, held: 1, scheduled: 0 },
      { channel: 'partners', arrived: 1, leads: 1, held: 0, scheduled: 0 },
      { channel: 'tg_outreach', arrived: 1, leads: 0, held: 0, scheduled: 0 },
    ]);
  });

  it('«Закрыто и не реализовано» не считается лидом и не пускает лид-магнит в «Пришло»', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Обычная сделка: в «Пришло» попадает, лидом не считается.
        lead({ Контур: 'Маркетинг' }, 143, 'Закрыто', { name: 'Иванов Иван' }),
        // Лид-магнит: раньше отказ выглядел как «прошёл квалификацию» и
        // пропускал заявку в «Пришло». Теперь не попадает никуда.
        lead({ Контур: 'Маркетинг' }, 143, 'Закрыто', { name: 'Бот: Amir' }),
      ],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'marketing')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 0,
      meetingsHeld: 0,
      meetingsScheduled: 0,
    });
  });

  it('пропускает сделки без явного канала (нет Контур=Маркетинг и нет известного Источник)', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Ни Контур, ни известный источник — раньше падало в «Маркетинг», теперь пропускаем.
        lead({}, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Сайт' }, 20, 'Квалифицированный лид'),
        lead({ Источник: 'Лидскан' }, 20, 'Квалифицированный лид'),
      ],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    expect(
      result.every(
        (item) =>
          item.arrived === 0 &&
          item.qualifiedLeads === 0 &&
          item.meetingsHeld === 0 &&
          item.meetingsScheduled === 0,
      ),
    ).toBe(true);
  });

  it('лид-магниты (имя начинается с «Бот:») попадают в «Пришло» только когда прошли квалификацию', () => {
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [
        // Обычные маркетинговые (не лид-магниты): обе в «Пришло», одна в «Лидов».
        lead({ Контур: 'Маркетинг' }, 10, 'Новый лид', { name: 'Иванов Иван' }),
        lead({ Контур: 'Маркетинг' }, 20, 'Квалифицированный лид', { name: 'Петров Пётр' }),
        // Лид-магниты (name «Бот:...»): один НЕ квал → не в «Пришло»; один квал → в «Пришло» и в «Лидов».
        lead({ Контур: 'Маркетинг' }, 10, 'Новый лид', { name: 'Бот: Amir' }),
        lead({ Контур: 'Маркетинг' }, 20, 'Квалифицированный лид', { name: 'Бот: Светлана' }),
      ],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    const marketing = result.find((r) => r.channel.name === 'marketing');
    // Ожидаем: 2 обычные + 1 лид-магнит-квал = 3 в arrived; лид-магнит без квала (Amir) не считаем.
    // Квалифицированных всего 2 (Петров + Бот: Светлана).
    expect(marketing).toMatchObject({
      arrived: 3,
      qualifiedLeads: 2,
    });
  });

  it('«Перенос» после встречи встречу сохраняет', () => {
    const deal = lead({ Источник: 'Аутрич' }, 50, 'Перенос', { amoId: 900 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(900, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(900, 30, 40, '2026-07-22T09:00:00.000Z'),
        move(900, 40, 50, '2026-07-23T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 1,
      meetingsHeld: 1,
      meetingsScheduled: 0,
    });
  });

  it('«Перенос» без встречи встречу не придумывает', () => {
    // Реальный кейс недели 31.07–07.08: «Бот: Aleksei Brazhnikov», путь
    // «Новый лид → Первый контакт → Перенос». Старое правило считало
    // проведённой встречей, потому что «Перенос» лежит ниже по воронке.
    const deal = lead({ Источник: 'Аутрич' }, 50, 'Перенос', { amoId: 901 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [move(901, 10, 50, '2026-07-22T09:00:00.000Z')],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 0,
      meetingsHeld: 0,
      meetingsScheduled: 0,
    });
  });

  it('назначенная и потом закрытая встреча не пропадает', () => {
    // Кейс «@chapurina_volna»: назначили встречу, откатили, закрыли.
    const deal = lead({ Источник: 'Telegram Outreach' }, 143, 'Закрыто', { amoId: 902 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(902, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(902, 30, 10, '2026-07-21T14:00:00.000Z'),
        move(902, 10, 143, '2026-07-22T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'tg_outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 1,
      meetingsHeld: 0,
      meetingsScheduled: 1,
    });
  });

  it('«Не вышел на звонок» считается запланированной встречей', () => {
    const deal = lead({ Источник: 'Партнер' }, 35, 'Не вышел на звонок', { amoId: 903 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(903, 10, 30, '2026-07-21T09:00:00.000Z'),
        move(903, 30, 35, '2026-07-22T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'partners')).toMatchObject({
      qualifiedLeads: 1,
      meetingsHeld: 0,
      meetingsScheduled: 1,
    });
  });

  it('карточка, созданная сразу на «Встреча проведена», встречу сохраняет', () => {
    // Менеджер завёл карточку уже после встречи, переходов нет вовсе.
    const deal = lead({ Источник: 'Аутрич' }, 40, 'Встреча проведена + КП отправлено', {
      amoId: 904,
    });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      qualifiedLeads: 1,
      meetingsHeld: 1,
    });
  });

  it('переход после конца окна в расчёт не входит', () => {
    // Кейс «@igorhappy»: «Назначена встреча» через три дня после отчёта.
    const deal = lead({ Источник: 'Telegram Outreach' }, 30, 'Назначена встреча', {
      amoId: 905,
    });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [
        move(905, 10, 20, '2026-07-21T09:00:00.000Z'),
        move(905, 20, 30, '2026-07-27T09:00:00.000Z'),
      ],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'tg_outreach')).toMatchObject({
      qualifiedLeads: 1,
      meetingsScheduled: 0,
      meetingsHeld: 0,
    });
  });

  it('сделка, вся история которой после конца окна, считается по этапу создания', () => {
    // Заявка вечера пятницы, разобранная в понедельник: события есть, но все
    // они позже отчёта. Этап создания берётся из from_value первого перехода.
    const deal = lead({ Источник: 'Аутрич' }, 30, 'Назначена встреча', { amoId: 906 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [move(906, 10, 30, '2026-07-28T09:00:00.000Z')],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      qualifiedLeads: 0,
      meetingsScheduled: 0,
      meetingsHeld: 0,
    });
  });

  it('успешно закрытая ПОСЛЕ окна не считается лидом этой недели', () => {
    const deal = lead({ Источник: 'Партнер' }, 142, 'Успешно', { amoId: 907 });
    const result = computeMetricsFromRows(
      SUMMARY_CHANNELS,
      statuses,
      [deal],
      [move(907, 10, 142, '2026-07-28T09:00:00.000Z')],
      WINDOW_START,
      WINDOW_END,
    );

    expect(result.find((r) => r.channel.name === 'partners')).toMatchObject({
      qualifiedLeads: 0,
    });
  });
});

describe('computeAllChannelMetrics', () => {
  function dataFor(table: string) {
    if (table === 'amo_statuses') return statuses;
    if (table === 'amo_leads') {
      return [
        lead({ Источник: 'Аутрич' }, 50, 'Перенос', {
          amoId: 700,
          createdAt: '2026-07-21T10:00:00.000Z',
        }),
      ];
    }
    return [move(700, 10, 50, '2026-07-22T09:00:00.000Z')];
  }

  function fakeDb(calls: Array<{ table: string; filters: Record<string, unknown> }>) {
    return {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        calls.push({ table, filters });
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters[`eq:${column}`] = value;
            return builder;
          },
          gte: (column: string, value: unknown) => {
            filters[`gte:${column}`] = value;
            return builder;
          },
          lt: (column: string, value: unknown) => {
            filters[`lt:${column}`] = value;
            return builder;
          },
          in: (column: string, value: unknown) => {
            filters[`in:${column}`] = value;
            return builder;
          },
          then: (resolve: (result: unknown) => unknown) =>
            resolve({ data: dataFor(table), error: null }),
        };
        return builder;
      },
    };
  }

  it('тянет историю переходов и считает по ней, а не по текущему этапу', async () => {
    const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const result = await computeAllChannelMetrics(
      fakeDb(calls) as never,
      SUMMARY_CHANNELS,
      WINDOW_START,
      WINDOW_END,
    );

    expect(calls.map((call) => call.table)).toEqual([
      'amo_statuses',
      'amo_leads',
      'amo_events',
    ]);

    const eventsCall = calls[2];
    expect(eventsCall.filters['eq:event_type']).toBe('lead_status_changed');
    expect(eventsCall.filters['in:amo_deal_id']).toEqual([700]);
    // Окно по времени режет `computePeak`, а не запрос. Фильтр `.lt` здесь был
    // бы багом: у сделки, созданной в пятницу вечером и сдвинутой в
    // понедельник, ВСЯ история лежит после конца окна. Запрос вернул бы ноль
    // строк, `computePeak` откатился бы на текущий этап карточки — и
    // понедельничная встреча попала бы в пятничный отчёт задним числом.
    expect(eventsCall.filters['lt:changed_at']).toBeUndefined();

    // Сделка в «Переносе», встречи не было — «Было» должно остаться нулём.
    expect(result.find((r) => r.channel.name === 'outreach')).toMatchObject({
      arrived: 1,
      meetingsHeld: 0,
    });
  });
});
