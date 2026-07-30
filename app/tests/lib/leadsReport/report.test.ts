import type { SupabaseClient } from '@supabase/supabase-js';
import { appendRows, readColumn } from '@/lib/googleSheets/writer';
import { marketingConfig } from '@/lib/leadsReport/config';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';
import { runReport } from '@/lib/leadsReport/report';
import type { AmoLead } from '@/lib/leadsReport/rowBuilder';

jest.mock('@/lib/googleSheets/writer', () => ({
  appendRows: jest.fn(),
  readColumn: jest.fn(),
}));

const mockedAppendRows = jest.mocked(appendRows);
const mockedReadColumn = jest.mocked(readColumn);

function lead(amoId: number, fields: Record<string, string>): AmoLead {
  return {
    amo_id: amoId,
    name: `Lead ${amoId}`,
    status_name: 'Первый контакт',
    contact_phone: null,
    contact_email: null,
    company_name: null,
    company_website: null,
    responsible_name: null,
    created_at: '2026-07-20T10:00:00Z',
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

function dbReturning(
  data: AmoLead[] | null,
  error: unknown = null,
): { db: SupabaseClient; gte: jest.Mock } {
  const order = jest.fn().mockResolvedValue({ data, error });
  const gte = jest.fn().mockReturnValue({ order });
  const select = jest.fn().mockReturnValue({ gte });
  const from = jest.fn().mockReturnValue({ select });
  return { db: { from } as unknown as SupabaseClient, gte };
}

describe('extractCustomField', () => {
  it('возвращает первое значение поля и безопасно обрабатывает мусор', () => {
    expect(
      extractCustomField(
        {
          custom_fields_values: [
            null,
            { field_name: 'Источник', values: [{ value: 42 }] },
          ],
        },
        'Источник',
      ),
    ).toBe('42');
    expect(extractCustomField(null, 'Источник')).toBeNull();
  });
});

describe('runReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('фильтрует по маркеру «Контур»=«Маркетинг», дедуплицирует и дописывает только свежие строки', async () => {
    const config = {
      ...marketingConfig,
      spreadsheetId: 'sheet-id',
    };
    // Первый вызов — читаем колонку с датами (D) для инкрементального окна.
    // Второй — колонку amo_id (N) для дедупа.
    mockedReadColumn
      .mockResolvedValueOnce(['Дата', '20.07.2026', '19.07.2026'])
      .mockResolvedValueOnce(['AMO id', '2']);

    const { db, gte } = dbReturning([
      lead(1, { Контур: 'Маркетинг' }),
      lead(2, { Контур: 'Маркетинг' }),
      lead(3, { Источник: 'Email Outreach' }),
      lead(4, { Источник: 'Сайт' }),
    ]);

    const result = await runReport(db, config, {
      sinceDays: 30,
      amoHost: 'polzaagency.amocrm.ru',
    });

    expect(mockedReadColumn).toHaveBeenNthCalledWith(1, 'sheet-id', 'Лиды маркетинг', 'D');
    expect(mockedReadColumn).toHaveBeenNthCalledWith(2, 'sheet-id', 'Лиды маркетинг', 'N');
    // Окно должно начинаться от max-даты в шите (20.07.2026), а не sinceDays назад.
    expect(gte).toHaveBeenCalledWith('created_at', '2026-07-20T00:00:00.000Z');
    expect(mockedAppendRows).toHaveBeenCalledTimes(1);
    expect(mockedAppendRows.mock.calls[0][2]).toHaveLength(1);
    expect(mockedAppendRows.mock.calls[0][2][0].at(-1)).toBe('1');
    expect(result).toEqual({
      fetchedFromDb: 4,
      matchedFilter: 2,
      skippedDedup: 1,
      appended: 1,
    });
  });

  it('если в шите нет ни одной DD.MM.YYYY-даты, окно откатывается на sinceDays от «сейчас»', async () => {
    const config = { ...marketingConfig, spreadsheetId: 'sheet-id' };
    // В колонке дат только заголовок + мусор — max-даты нет, fallback.
    mockedReadColumn
      .mockResolvedValueOnce(['Дата', '', 'не дата', '2026/07/20'])
      .mockResolvedValueOnce(['AMO id']);

    const { db, gte } = dbReturning([]);
    const now = Date.now();
    await runReport(db, config, {
      sinceDays: 30,
      amoHost: 'polzaagency.amocrm.ru',
    });
    // Проверяем не точное значение (Date.now зависит от прогона),
    // а что since не совпадает с эпохой и находится в окне 30±1 день.
    const sinceIso = gte.mock.calls[0]?.[1] as string;
    expect(sinceIso).toBeTruthy();
    const since = new Date(sinceIso).getTime();
    expect(now - since).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(now - since).toBeLessThan(31 * 24 * 3600 * 1000);
  });

  it('не маскирует ошибку чтения AMO', async () => {
    mockedReadColumn.mockResolvedValue(['Дата', '20.07.2026']);
    await expect(
      runReport(
        dbReturning(null, new Error('db unavailable')).db,
        { ...marketingConfig, spreadsheetId: 'sheet-id' },
        { sinceDays: 30, amoHost: 'polzaagency.amocrm.ru' },
      ),
    ).rejects.toThrow('db unavailable');
  });
});
