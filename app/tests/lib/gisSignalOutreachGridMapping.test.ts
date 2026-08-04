/** @jest-environment node */

jest.mock('server-only', () => ({}));

import {
  CLARIFICATION_NOT_FOUND,
  GRID_HEADER,
  companiesToGrid,
  gridToLeadPayloads,
  type QualifiedCompany,
} from '@/lib/gisSignalOutreach/gridMapping';
import { SIGNAL_COLUMNS, type OutreachSignalsResult } from '@/lib/gisSignalOutreach/signals';
import type { SegmentCandidate } from '@/lib/gisSignalOutreach/segments';

function candidate(overrides: Partial<SegmentCandidate> = {}): SegmentCandidate {
  return {
    twogisId: '70000001000000001',
    segmentKey: 'clinics',
    name: 'Стоматология Улыбка',
    site: 'https://ulybka.ru',
    phone: '8 800 555-06-65',
    email: '',
    cityName: 'Москва',
    category: 'Медицина',
    subcategory: 'Стоматологии',
    ...overrides,
  };
}

function signalsResult(hits: Partial<Record<keyof OutreachSignalsResult['signals'], string>> = {}): OutreachSignalsResult {
  const v = (key: keyof OutreachSignalsResult['signals']) => ({
    hit: key in hits,
    evidence: hits[key] ?? '',
  });
  return {
    signals: {
      generalPhone: v('generalPhone'),
      contactForm: v('contactForm'),
      salesDept: v('salesDept'),
      targetVacancy: v('targetVacancy'),
      highVolume: v('highVolume'),
      multiOffice: v('multiOffice'),
    },
    signalsCount: Object.keys(hits).length,
    note: 'Homepage + 2 subpages checked',
    ok: true,
  };
}

function qualified(overrides: { cand?: Partial<SegmentCandidate>; hits?: Parameters<typeof signalsResult>[0] } = {}): QualifiedCompany {
  return {
    candidate: candidate(overrides.cand),
    signals: signalsResult(overrides.hits),
  };
}

describe('GRID_HEADER', () => {
  it('точный заголовок референсного CSV', () => {
    expect(GRID_HEADER).toEqual([
      'id', 'компания', 'city_name', 'phone', 'email', 'сайт', 'category', 'subcategory',
      ...SIGNAL_COLUMNS.flatMap((c) => [c.title, c.clarification]),
      'Проверка — примечание',
    ]);
    // 8 базовых + 6 пар сигналов + примечание.
    expect(GRID_HEADER).toHaveLength(8 + 12 + 1);
  });
});

describe('companiesToGrid', () => {
  it('сигнальные ячейки: Да/Нет + уточнение (evidence или Not found…)', () => {
    const grid = companiesToGrid([
      qualified({
        hits: {
          generalPhone: '8 800 555-06-65 в шапке сайта',
          contactForm: 'Кнопка: «Заказать звонок»',
        },
      }),
    ]);

    expect(grid[0]).toEqual(GRID_HEADER);
    expect(grid).toHaveLength(2);
    const row = grid[1];
    expect(row.slice(0, 8)).toEqual([
      '70000001000000001', 'Стоматология Улыбка', 'Москва', '8 800 555-06-65',
      '', 'https://ulybka.ru', 'Медицина', 'Стоматологии',
    ]);

    // Пары «сигнал/уточнение» идут в порядке SIGNAL_COLUMNS.
    const cells = row.slice(8, 20);
    expect(cells[0]).toBe('Да'); // generalPhone
    expect(cells[1]).toBe('8 800 555-06-65 в шапке сайта');
    expect(cells[2]).toBe('Да'); // contactForm
    expect(cells[3]).toBe('Кнопка: «Заказать звонок»');
    // Остальные сигналы не сработали → Нет + Not found on checked pages.
    for (let i = 4; i < 12; i += 2) {
      expect(cells[i]).toBe('Нет');
      expect(cells[i + 1]).toBe(CLARIFICATION_NOT_FOUND);
    }
    expect(row[20]).toBe('Homepage + 2 subpages checked');
  });

  it('компания без единого сигнала: все ячейки Нет + Not found', () => {
    const grid = companiesToGrid([qualified({ hits: {} })]);
    const cells = grid[1].slice(8, 20);
    for (let i = 0; i < 12; i += 2) {
      expect(cells[i]).toBe('Нет');
      expect(cells[i + 1]).toBe(CLARIFICATION_NOT_FOUND);
    }
  });
});

describe('gridToLeadPayloads', () => {
  const header = [...GRID_HEADER, 'Email Статус'];

  function finalRow(overrides: {
    id?: string; company?: string; email?: string; signals?: ('Да' | 'Нет')[];
    status?: string; city?: string; site?: string; phone?: string;
  } = {}): string[] {
    const signalCells = (overrides.signals ?? ['Да', 'Нет', 'Да', 'Нет', 'Нет', 'Нет'])
      .flatMap((v) => [v, v === 'Да' ? 'какое-то evidence' : CLARIFICATION_NOT_FOUND]);
    return [
      overrides.id ?? '70000001000000001',
      overrides.company ?? 'Стоматология Улыбка',
      overrides.city ?? 'Москва',
      overrides.phone ?? '8 800 555-06-65',
      overrides.email ?? 'info@ulybka.ru',
      overrides.site ?? 'https://ulybka.ru',
      'Медицина', 'Стоматологии',
      ...signalCells,
      'Homepage checked',
      overrides.status ?? 'ok',
    ];
  }

  it('собирает лида с custom_variables (company/city/site/phone/segment/signals/email_status)', () => {
    const leads = gridToLeadPayloads([header, finalRow()], 'clinics');
    expect(leads).toHaveLength(1);
    const lead = leads[0];
    expect(lead.email).toBe('info@ulybka.ru');
    expect(lead.company_name).toBe('Стоматология Улыбка');
    expect(lead.website).toBe('https://ulybka.ru');
    expect(lead.custom_variables).toEqual({
      company: 'Стоматология Улыбка',
      city: 'Москва',
      site: 'https://ulybka.ru',
      phone: '8 800 555-06-65',
      segment: 'clinics',
      // Русские заголовки сработавших сигналов через запятую (1-й и 3-й).
      signals: `${SIGNAL_COLUMNS[0].title}, ${SIGNAL_COLUMNS[2].title}`,
      email_status: 'ok',
    });
  });

  it('строки без валидной почты пропускаются; дедуп по email', () => {
    const leads = gridToLeadPayloads(
      [
        header,
        finalRow({ email: '' }),
        finalRow({ email: 'не-почта' }),
        finalRow({ email: 'dup@ulybka.ru', id: '1' }),
        finalRow({ email: 'dup@ulybka.ru', id: '2' }),
      ],
      'clinics',
    );
    expect(leads.map((l) => l.email)).toEqual(['dup@ulybka.ru']);
  });

  it('без колонки статуса email_status пустой; пустая сетка → пусто', () => {
    const noStatusGrid = [GRID_HEADER, finalRow().slice(0, 21)];
    const leads = gridToLeadPayloads(noStatusGrid, 'clinics');
    expect(leads[0].custom_variables?.email_status).toBe('');

    expect(gridToLeadPayloads([], 'clinics')).toEqual([]);
    expect(gridToLeadPayloads([header], 'clinics')).toEqual([]);
  });

  it('все сигналы Нет → signals пустая строка', () => {
    const leads = gridToLeadPayloads(
      [header, finalRow({ signals: ['Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет'] })],
      'clinics',
    );
    expect(leads[0].custom_variables?.signals).toBe('');
  });
});
