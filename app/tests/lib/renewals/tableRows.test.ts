import { buildRenewalTableRows, buildUndatedRenewalTableRows } from '@/lib/renewals/tableRows';
import type { RenewalProjectRow } from '@/lib/renewals/metrics';

function renewal(over: Partial<RenewalProjectRow> = {}): RenewalProjectRow {
  return {
    id: 'p1',
    name: 'Проект',
    client: 'Клиент',
    project_type: 'Продление',
    budget: '100000',
    payment_date: '2026-07-15',
    contract_date: null,
    kpi_fact: null,
    status: 'В работе',
    manager: null,
    specialist: null,
    ...over,
  };
}

const TODAY_KEY = '2026-07-20';

describe('buildRenewalTableRows — тип и фильтр KPI', () => {
  it('строки других типов не попадают в таблицу', () => {
    const rows = buildRenewalTableRows(
      [renewal({ project_type: 'Продажа' }), renewal({ id: 'p2', project_type: null })],
      null,
      TODAY_KEY,
    );
    expect(rows).toHaveLength(0);
  });

  it('тип с пробелами и другим регистром распознаётся', () => {
    const rows = buildRenewalTableRows([renewal({ project_type: '  ПРОДЛЕНИЕ  ' })], null, TODAY_KEY);
    expect(rows).toHaveLength(1);
  });

  it('фильтр KPI отсекает так же, как в metrics.ts', () => {
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'p1', kpi_fact: '50' }),
        renewal({ id: 'p2', kpi_fact: '90' }),
        renewal({ id: 'p3', kpi_fact: 'н/д' }),
      ],
      { min: 60, max: 100 },
      TODAY_KEY,
    );
    expect(rows.map((r) => r.id)).toEqual(['p2']);
  });

  it('без фильтра непарсящийся kpi_fact не выкидывает строку', () => {
    const rows = buildRenewalTableRows([renewal({ kpi_fact: 'н/д' })], null, TODAY_KEY);
    expect(rows).toHaveLength(1);
  });
});

describe('buildRenewalTableRows — даты и сортировка', () => {
  it('дата в будущем помечена isPlanned, дата в прошлом — нет', () => {
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'p1', payment_date: '2026-11-24' }),
        renewal({ id: 'p2', payment_date: '2026-07-01' }),
      ],
      null,
      TODAY_KEY,
    );
    expect(rows.find((r) => r.id === 'p1')?.isPlanned).toBe(true);
    expect(rows.find((r) => r.id === 'p2')?.isPlanned).toBe(false);
  });

  it('дата ровно "сегодня" не считается планом', () => {
    const rows = buildRenewalTableRows([renewal({ payment_date: TODAY_KEY })], null, TODAY_KEY);
    expect(rows[0]?.isPlanned).toBe(false);
  });

  it('нераспарсенная и пустая дата дают paymentDate === null', () => {
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'p1', payment_date: '15.07.2026' }),
        renewal({ id: 'p2', payment_date: null }),
      ],
      null,
      TODAY_KEY,
    );
    expect(rows.every((r) => r.paymentDate === null)).toBe(true);
    expect(rows.every((r) => r.isPlanned === false)).toBe(true);
  });

  it('сортировка по дате оплаты убывает, без даты — в конце', () => {
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'old', payment_date: '2025-08-01' }),
        renewal({ id: 'nodate', payment_date: null }),
        renewal({ id: 'future', payment_date: '2026-11-24' }),
        renewal({ id: 'recent', payment_date: '2026-07-15' }),
      ],
      null,
      TODAY_KEY,
    );
    expect(rows.map((r) => r.id)).toEqual(['future', 'recent', 'old', 'nodate']);
  });
});

describe('buildRenewalTableRows — суммы', () => {
  it('парсит бюджет и kpi_fact числом, хранит исходную строку рядом', () => {
    const rows = buildRenewalTableRows(
      [renewal({ budget: '120 000', kpi_fact: '85' })],
      null,
      TODAY_KEY,
    );
    expect(rows[0]).toMatchObject({ budget: 120000, budgetRaw: '120 000', kpiFact: 85, kpiFactRaw: '85' });
  });

  it('мусорный бюджет даёт budget === null, но строка остаётся в таблице', () => {
    const rows = buildRenewalTableRows([renewal({ budget: '120к' })], null, TODAY_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.budget).toBeNull();
    expect(rows[0]?.budgetRaw).toBe('120к');
  });
});

describe('buildRenewalTableRows — срез по периоду', () => {
  // Период фильтрует страницу целиком: таблица показывает те же продления, что
  // и плитки. Две выборки под одним фильтром разошлись бы, и объяснять
  // расхождение пришлось бы в переписке.
  const window = { fromKey: '2026-07-01', toKey: '2026-07-31' };

  it('без окна отдаёт всё — обратная совместимость вызова без периода', () => {
    const rows = buildRenewalTableRows(
      [renewal({ payment_date: '2025-01-01' }), renewal({ id: 'p2', payment_date: null })],
      null,
      TODAY_KEY,
    );
    expect(rows).toHaveLength(2);
  });

  it('оставляет только продления внутри периода', () => {
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'in', payment_date: '2026-07-15' }),
        renewal({ id: 'before', payment_date: '2026-06-30' }),
        renewal({ id: 'after', payment_date: '2026-08-01' }),
      ],
      null,
      TODAY_KEY,
      window,
    );
    expect(rows.map((r) => r.id)).toEqual(['in']);
  });

  it('обе границы периода включительно', () => {
    // Иначе первый и последний день месяца молча выпадали бы, а заметили бы
    // это в лучшем случае по несходящейся сумме.
    const rows = buildRenewalTableRows(
      [
        renewal({ id: 'first', payment_date: '2026-07-01' }),
        renewal({ id: 'last', payment_date: '2026-07-31' }),
      ],
      null,
      TODAY_KEY,
      window,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['first', 'last']);
  });

  it('продление без даты оплаты в период не попадает ни при каком выборе', () => {
    // Привязать его ко времени не к чему. Именно поэтому под таблицей стоит
    // сноска с их числом — иначе строки исчезли бы с экрана бесследно.
    const rows = buildRenewalTableRows(
      [renewal({ payment_date: null })],
      null,
      TODAY_KEY,
      window,
    );
    expect(rows).toHaveLength(0);
  });

  it('запланированное продление внутри периода остаётся и помечено планом', () => {
    const rows = buildRenewalTableRows(
      [renewal({ payment_date: '2026-07-28' })],
      null,
      TODAY_KEY,
      window,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isPlanned).toBe(true);
  });
});

describe('buildUndatedRenewalTableRows', () => {
  it('берёт только строки без распознанной даты оплаты', () => {
    const rows = buildUndatedRenewalTableRows(
      [
        renewal({ id: 'has-date', payment_date: '2026-07-15' }),
        renewal({ id: 'empty', payment_date: null }),
        renewal({ id: 'garbage', payment_date: '15.07.2026' }),
      ],
      null,
      TODAY_KEY,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['empty', 'garbage']);
  });

  it('период на эту выборку не влияет — у функции вообще нет параметра окна', () => {
    // buildRenewalTableRows с window выкидывает продления без даты из таблицы
    // (окно не к чему привязать) — эта функция как раз восполняет то, что там
    // выпало, и никаким периодом не режется.
    const rows = buildUndatedRenewalTableRows([renewal({ payment_date: null })], null, TODAY_KEY);
    expect(rows).toHaveLength(1);
  });

  it('фильтр KPI распространяется так же, как в основной выборке', () => {
    const rows = buildUndatedRenewalTableRows(
      [
        renewal({ id: 'p1', payment_date: null, kpi_fact: '50' }),
        renewal({ id: 'p2', payment_date: null, kpi_fact: '90' }),
      ],
      { min: 60, max: 100 },
      TODAY_KEY,
    );
    expect(rows.map((r) => r.id)).toEqual(['p2']);
  });

  it('строки других типов проекта не попадают', () => {
    const rows = buildUndatedRenewalTableRows(
      [renewal({ payment_date: null, project_type: 'Продажа' })],
      null,
      TODAY_KEY,
    );
    expect(rows).toHaveLength(0);
  });

  it('isPlanned всегда false — без даты план не определить', () => {
    const rows = buildUndatedRenewalTableRows([renewal({ payment_date: null })], null, TODAY_KEY);
    expect(rows[0]?.isPlanned).toBe(false);
    expect(rows[0]?.paymentDate).toBeNull();
  });

  it('форма строки совпадает с buildRenewalTableRows (тот же budget/kpiFact разбор)', () => {
    const rows = buildUndatedRenewalTableRows(
      [renewal({ payment_date: null, budget: '120 000', kpi_fact: null })],
      null,
      TODAY_KEY,
    );
    expect(rows[0]).toMatchObject({ budget: 120000, budgetRaw: '120 000' });
  });
});
