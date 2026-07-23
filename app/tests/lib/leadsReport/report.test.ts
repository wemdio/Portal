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

function lead(amoId: number, source: string): AmoLead {
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
      custom_fields_values: [
        { field_name: 'Источник', values: [{ value: source }] },
      ],
    },
  };
}

function dbReturning(
  data: AmoLead[] | null,
  error: unknown = null,
): SupabaseClient {
  const order = jest.fn().mockResolvedValue({ data, error });
  const gte = jest.fn().mockReturnValue({ order });
  const select = jest.fn().mockReturnValue({ gte });
  const from = jest.fn().mockReturnValue({ select });
  return { from } as unknown as SupabaseClient;
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

  it('фильтрует по источнику, дедуплицирует и дописывает только свежие строки', async () => {
    const config = {
      ...marketingConfig,
      spreadsheetId: 'sheet-id',
    };
    mockedReadColumn.mockResolvedValue(['AMO id', '2']);

    const result = await runReport(
      dbReturning([
        lead(1, 'Website'),
        lead(2, 'Website'),
        lead(3, 'Email Outreach'),
      ]),
      config,
      { sinceDays: 30, amoHost: 'polzaagency.amocrm.ru' },
    );

    expect(mockedReadColumn).toHaveBeenCalledWith('sheet-id', 'Лиды', 'J');
    expect(mockedAppendRows).toHaveBeenCalledTimes(1);
    expect(mockedAppendRows.mock.calls[0][2]).toHaveLength(1);
    expect(mockedAppendRows.mock.calls[0][2][0].at(-1)).toBe('1');
    expect(result).toEqual({
      fetchedFromDb: 3,
      matchedFilter: 2,
      skippedDedup: 1,
      appended: 1,
    });
  });

  it('не маскирует ошибку чтения AMO', async () => {
    await expect(
      runReport(
        dbReturning(null, new Error('db unavailable')),
        { ...marketingConfig, spreadsheetId: 'sheet-id' },
        { sinceDays: 30, amoHost: 'polzaagency.amocrm.ru' },
      ),
    ).rejects.toThrow('db unavailable');
    expect(mockedReadColumn).not.toHaveBeenCalled();
  });
});
