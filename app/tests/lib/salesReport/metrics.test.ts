import { computeSalesReportBlockFromRows } from '@/lib/salesReport/metrics';

const statuses = [
  { status_id: 1, status_name: 'Новый лид', sort: 20 },
  { status_id: 2, status_name: 'Первый контакт', sort: 30 },
  { status_id: 3, status_name: 'Квалифицированный лид', sort: 40 },
  { status_id: 4, status_name: 'Назначена встреча', sort: 50 },
  { status_id: 5, status_name: 'Встреча проведена + КП отправлено', sort: 70 },
  { status_id: 6, status_name: 'Отправлен счет', sort: 100 },
  { status_id: 7, status_name: 'Согласование договора', sort: 110 },
  { status_id: 142, status_name: 'Успешно реализовано', sort: 10000 },
  { status_id: 143, status_name: 'Закрыто и не реализовано', sort: 11000 },
];

function lead(
  fields: Record<string, string>,
  statusId: number,
  opts: {
    amount?: number;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string | null;
  } = {},
) {
  return {
    status_id: statusId,
    status_name: null,
    amount: opts.amount ?? null,
    created_at: opts.createdAt ?? '2026-07-15T12:00:00.000Z',
    updated_at: opts.updatedAt ?? '2026-07-16T12:00:00.000Z',
    closed_at: opts.closedAt === undefined ? '2026-07-16T12:00:00.000Z' : opts.closedAt,
    raw: {
      custom_fields_values: Object.entries(fields).map(([field_name, value]) => ({
        field_name,
        values: [{ value }],
      })),
    },
  };
}

describe('computeSalesReportBlockFromRows', () => {
  const start = new Date('2026-07-01T00:00:00.000Z');
  const end = new Date('2026-08-01T00:00:00.000Z');

  it('раскладывает по каналам и считает новых/квал', () => {
    const result = computeSalesReportBlockFromRows(
      [
        lead({ Контур: 'Маркетинг' }, 3),                    // marketing, квал (sort 40)
        lead({ Контур: 'Маркетинг' }, 1),                    // marketing, не квал (sort 20)
        lead({ Источник: 'Email Outreach' }, 3),             // outreach, квал
        lead({ Источник: 'Партнер' }, 3),                    // partners, квал
        lead({ Источник: 'Telegram Outreach' }, 1),          // tg_outreach, не квал
        lead({ Источник: 'Личный бренд (инст /ютуб)' }, 3),  // smm, квал
      ],
      statuses,
      start,
      end,
    );
    expect(result.newLeadsMarketing).toBe(2);
    expect(result.qualMarketing).toBe(1);
    expect(result.newLeadsOutreach).toBe(1);
    expect(result.qualOutreach).toBe(1);
    expect(result.newLeadsPartners).toBe(1);
    expect(result.qualPartners).toBe(1);
    expect(result.newLeadsTgOutreach).toBe(1);
    expect(result.qualTgOutreach).toBe(0);
    expect(result.newLeadsSmm).toBe(1);
    expect(result.qualSmm).toBe(1);
  });

  it('считает встречи (sort ≥ 70), договора (≥ 110), счета (≥ 100)', () => {
    const result = computeSalesReportBlockFromRows(
      [
        lead({ Контур: 'Маркетинг' }, 4),  // Назначена встреча (50) — только квал, не встреча
        lead({ Контур: 'Маркетинг' }, 5),  // Встреча проведена (70) — встреча
        lead({ Контур: 'Маркетинг' }, 6),  // Отправлен счет (100) — встреча + счёт
        lead({ Контур: 'Маркетинг' }, 7),  // Согласование договора (110) — встреча + счёт + договор
      ],
      statuses,
      start,
      end,
    );
    expect(result.meetings).toBe(3);       // 5, 6, 7 (sort ≥ 70)
    expect(result.invoicesSent).toBe(2);   // 6, 7 (sort ≥ 100)
    expect(result.contracts).toBe(1);      // 7 (sort ≥ 110)
  });

  it('оплаты и сумма — только status_id=142', () => {
    const result = computeSalesReportBlockFromRows(
      [
        lead({ Контур: 'Маркетинг' }, 142, { amount: 100000 }),
        lead({ Контур: 'Маркетинг' }, 142, { amount: 50000 }),
        lead({ Контур: 'Маркетинг' }, 143, { amount: 999999 }),  // закрыто/не реализовано — не считаем
        lead({ Контур: 'Маркетинг' }, 7, { amount: 999999 }),    // ещё не оплачено
      ],
      statuses,
      start,
      end,
    );
    expect(result.paymentsReceived).toBe(2);
    expect(result.revenue).toBe(150000);
  });

  it('игнорирует сделки без канала (нет Контур и нет известного Источник)', () => {
    const result = computeSalesReportBlockFromRows(
      [lead({ Источник: 'Холодная база' }, 3), lead({}, 3)],
      statuses,
      start,
      end,
    );
    expect(result.newLeadsMarketing).toBe(0);
    expect(result.qualMarketing).toBe(0);
    expect(result.newLeadsOutreach).toBe(0);
  });

  it('игнорирует сделки полностью вне окна (created_at и updated_at раньше start)', () => {
    const result = computeSalesReportBlockFromRows(
      [
        lead({ Контур: 'Маркетинг' }, 3, {
          createdAt: '2026-06-01T12:00:00.000Z',
          updatedAt: '2026-06-15T12:00:00.000Z',
        }),
      ],
      statuses,
      start,
      end,
    );
    expect(result.newLeadsMarketing).toBe(0);
    expect(result.qualMarketing).toBe(0);
  });
});
