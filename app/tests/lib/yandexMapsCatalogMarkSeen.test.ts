/** @jest-environment node */

/**
 * Пометка «видели / кажется, закрылась» ходит в Postgres напрямую.
 *
 * Через PostgREST она упиралась в Kong: шлюз рвёт соединение на 60 секундах, и
 * вызов возвращал либо `The upstream server is timing out`, либо HTML-страницу
 * ошибки вместо ответа. На бою 11.08.2026 так падали 343 пары из 20 000 — уборка
 * перебирает десятки тысяч строк каталога (одна «Москва × Бизнес» — 65 тыс.),
 * и в минуту это не укладывается.
 *
 * Сбор выдачи ушёл в прямое подключение по той же причине ещё 09.08 — здесь
 * ровно тот же случай: ни одна строка не покидает Postgres, гонять операцию
 * через REST незачем.
 */

const mockQuery = jest.fn();
const mockRpc = jest.fn(async () => ({ data: 0, error: null }));

jest.mock('pg', () => ({
  Pool: class {
    query = mockQuery;
    on() { return this; }
  },
}));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { rpc: mockRpc } }));

const TASK = { id: 7, country: 'Россия', place: 'Москва', rubric: 'Бизнес' };

/** Модуль читает адрес базы при загрузке — поэтому импорт после подстановки. */
function loadCatalog(dbUrl: string | undefined) {
  let loaded!: typeof import('@/lib/parsers/yandexMapsCatalog');
  jest.isolateModules(() => {
    const previous = process.env.SUPABASE_DB_URL;
    const previousFallback = process.env.DATABASE_URL;
    process.env.SUPABASE_DB_URL = dbUrl ?? '';
    process.env.DATABASE_URL = dbUrl ?? '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('@/lib/parsers/yandexMapsCatalog');
    process.env.SUPABASE_DB_URL = previous;
    process.env.DATABASE_URL = previousFallback;
  });
  return loaded;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [{ suspected: 0 }] });
});

describe('пометка организаций после обхода', () => {
  it('идёт мимо шлюза, когда есть прямое подключение к базе', async () => {
    const { markYandexMapsCatalogSeen } = loadCatalog('postgres://user:pass@db:5432/postgres');

    await markYandexMapsCatalogSeen(['1001', '1002'], TASK, true);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('yandex_maps_catalog_mark_seen');
    expect(params.slice(0, 5)).toEqual([['1001', '1002'], TASK.country, TASK.place, TASK.rubric, true]);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('без прямого подключения работает по-старому, через RPC', async () => {
    const { markYandexMapsCatalogSeen } = loadCatalog(undefined);

    await markYandexMapsCatalogSeen(['1001'], TASK, false);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith(
      'yandex_maps_catalog_mark_seen',
      expect.objectContaining({ p_place: TASK.place, p_rubric: TASK.rubric }),
    );
  });

  it('уборке отводится потолок по числу строк, а не «сколько найдётся»', async () => {
    const { markYandexMapsCatalogSeen, missingMarkBudget } = loadCatalog('postgres://db/postgres');

    // Яндекс показал 4 организации, а в каталоге по этой паре 148: выдача была
    // неполной, и записывать 144 живые компании в пропавшие нельзя. Потолок
    // держится на размере выдачи, поэтому база сама откажется их трогать.
    expect(missingMarkBudget(4)).toBe(28);
    expect(missingMarkBudget(0)).toBe(20);
    expect(missingMarkBudget(250)).toBe(520);

    await markYandexMapsCatalogSeen(['1001', '1002'], TASK, true);

    expect(mockQuery.mock.calls[0][1]).toEqual([
      ['1001', '1002'], TASK.country, TASK.place, TASK.rubric, true, missingMarkBudget(2),
    ]);
  });

  it('сообщает, что упало именно на пометке', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const { markYandexMapsCatalogSeen } = loadCatalog('postgres://user:pass@db:5432/postgres');

    await expect(markYandexMapsCatalogSeen(['1001'], TASK, true))
      .rejects.toThrow(/Не удалось отметить организации/);
  });
});
