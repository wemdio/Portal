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
      legalRelevance: v('legalRelevance'),
      crmCalltracking: v('crmCalltracking'),
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
      'score', 'grade',
      'Проверка — примечание',
    ]);
    // 8 базовых + 8 пар сигналов + score/grade + примечание.
    expect(GRID_HEADER).toHaveLength(8 + 16 + 2 + 1);
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
    const cells = row.slice(8, 24);
    expect(cells[0]).toBe('Да'); // generalPhone
    expect(cells[1]).toBe('8 800 555-06-65 в шапке сайта');
    expect(cells[2]).toBe('Да'); // contactForm
    expect(cells[3]).toBe('Кнопка: «Заказать звонок»');
    // Остальные сигналы не сработали → Нет + Not found on checked pages.
    for (let i = 4; i < 16; i += 2) {
      expect(cells[i]).toBe('Нет');
      expect(cells[i + 1]).toBe(CLARIFICATION_NOT_FOUND);
    }
    // Без скоринга: score/grade пустые.
    expect(row[24]).toBe('');
    expect(row[25]).toBe('');
    expect(row[26]).toBe('Homepage + 2 subpages checked');
  });

  it('компания без единого сигнала: все ячейки Нет + Not found', () => {
    const grid = companiesToGrid([qualified({ hits: {} })]);
    const cells = grid[1].slice(8, 24);
    for (let i = 0; i < 16; i += 2) {
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
    score?: string; grade?: string;
  } = {}): string[] {
    const signalCells = (overrides.signals ?? ['Да', 'Нет', 'Да', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет'])
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
      overrides.score ?? '',
      overrides.grade ?? '',
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
    const noStatusGrid = [GRID_HEADER, finalRow().slice(0, 27)];
    const leads = gridToLeadPayloads(noStatusGrid, 'clinics');
    expect(leads[0].custom_variables?.email_status).toBe('');

    expect(gridToLeadPayloads([], 'clinics')).toEqual([]);
    expect(gridToLeadPayloads([header], 'clinics')).toEqual([]);
  });

  it('все сигналы Нет → signals пустая строка', () => {
    const leads = gridToLeadPayloads(
      [header, finalRow({ signals: ['Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет'] })],
      'clinics',
    );
    expect(leads[0].custom_variables?.signals).toBe('');
  });
});

describe('score/grade (скоринговые сегменты, legal)', () => {
  it('companiesToGrid пишет score/grade в отдельные колонки перед примечанием', () => {
    const grid = companiesToGrid([
      { ...qualified({ hits: { legalRelevance: 'Юридические услуги' } }), score: 60, grade: 'B' },
    ]);
    const row = grid[1];
    expect(row[24]).toBe('60');
    expect(row[25]).toBe('B');
    expect(row[26]).toBe('Homepage + 2 subpages checked');
    // Новый скоринговый сигнал попадает в свою пару колонок (7-я пара).
    expect(row[20]).toBe('Да'); // legalRelevance
    expect(row[21]).toBe('Юридические услуги');
  });

  it('gridToLeadPayloads прокидывает score/grade в custom_variables, когда они есть', () => {
    const header = [...GRID_HEADER, 'Email Статус'];
    const signalCells = ['Да', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Да', 'Нет']
      .flatMap((v) => [v, v === 'Да' ? 'какое-то evidence' : CLARIFICATION_NOT_FOUND]);
    const row = [
      '70000001000000002', 'Юристы и Ко', 'Москва', '+7 495 111-22-33',
      'info@uristy.ru', 'https://uristy.ru', 'Юр. услуги', 'Юридические услуги',
      ...signalCells, '80', 'A', 'Homepage checked', 'ok',
    ];
    const leads = gridToLeadPayloads([header, row], 'legal');
    expect(leads).toHaveLength(1);
    expect(leads[0].custom_variables).toMatchObject({
      segment: 'legal',
      score: '80',
      grade: 'A',
      // 1-й и 7-й заголовки SIGNAL_COLUMNS (generalPhone + legalRelevance).
      signals: `${SIGNAL_COLUMNS[0].title}, ${SIGNAL_COLUMNS[6].title}`,
    });
  });

  it('пустые score/grade (сегмент без профиля) → переменных нет вовсе', () => {
    const header = [...GRID_HEADER, 'Email Статус'];
    const signalCells = ['Да', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет', 'Нет']
      .flatMap((v) => [v, v === 'Да' ? 'какое-то evidence' : CLARIFICATION_NOT_FOUND]);
    const row = [
      '70000001000000003', 'Школа', 'Москва', '', 'info@school.ru', 'https://school.ru',
      'Образование', 'Курсы', ...signalCells, '', '', 'Homepage checked', 'ok',
    ];
    const leads = gridToLeadPayloads([header, row], 'edu');
    expect(leads[0].custom_variables).not.toHaveProperty('score');
    expect(leads[0].custom_variables).not.toHaveProperty('grade');
  });
});
