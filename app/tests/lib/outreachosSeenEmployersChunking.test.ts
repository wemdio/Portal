/** @jest-environment node */

jest.mock('server-only', () => ({}));

/**
 * Страж чанкинга GIS-ветки seen-журнала OutreachOS.
 *
 * DELETE с .in('domain', …) кладёт все домены в query-string, а nginx перед Kong
 * режет строку запроса >8 КБ. 13.08.2026 топ-ап добрал 483 домена, они ушли одним
 * чанком (CHUNK=500) → ~10 КБ URL → 414 «URI too long». Прогон упал ПОСЛЕ
 * upsert'а HH-строк и ДО append: 261 компания сожжена в окне 45 дней без единого
 * письма, 193 готовых лида не залиты. До этого топ-ап добирал десятки доменов,
 * и баг не проявлялся — поэтому тест держит именно боевой масштаб (сотни).
 */

interface DeleteCall {
  domains: string[];
}

let deleteCalls: DeleteCall[] = [];
let insertedRows: Record<string, unknown>[][] = [];
let upsertedRows: Record<string, unknown>[][] = [];

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return {
      from: () => ({
        upsert: (rows: Record<string, unknown>[]) => {
          upsertedRows.push(rows);
          return Promise.resolve({ error: null });
        },
        insert: (rows: Record<string, unknown>[]) => {
          insertedRows.push(rows);
          return Promise.resolve({ error: null });
        },
        delete: () => ({
          is: () => ({
            in: (_col: string, domains: string[]) => {
              deleteCalls.push({ domains });
              return Promise.resolve({ error: null });
            },
          }),
        }),
      }),
    };
  },
}));

import {
  chunkDomainsByUrlBudget,
  DELETE_URL_BUDGET,
  markSeen,
  type SeenEmployerUpsert,
} from '@/lib/outreachos/seenEmployers';

/** Длина того куска URL, который PostgREST собирает из списка доменов. */
function encodedLength(domains: string[]): number {
  return `domain=in.(${domains.map((d) => `"${encodeURIComponent(d)}"`).join(',')})`.length;
}

/** Домены боевого вида: смесь коротких, длинных и кириллических (punycode/UTF-8). */
function makeDomains(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 7 === 0) out.push(`компания-${i}.рф`);
    else if (i % 3 === 0) out.push(`very-long-company-name-holding-group-${i}.company.ru`);
    else out.push(`firma${i}.ru`);
  }
  return out;
}

function gisRow(domain: string): SeenEmployerUpsert {
  return {
    hh_employer_id: null,
    hh_employer_name: `ООО ${domain}`,
    domain,
    site_url: `https://${domain}`,
    status: 'appended',
  };
}

beforeEach(() => {
  deleteCalls = [];
  insertedRows = [];
  upsertedRows = [];
});

describe('chunkDomainsByUrlBudget', () => {
  it('ни один чанк не превышает бюджет URL', () => {
    for (const chunk of chunkDomainsByUrlBudget(makeDomains(483))) {
      expect(encodedLength(chunk)).toBeLessThanOrEqual(DELETE_URL_BUDGET + 64);
    }
  });

  it('не теряет и не переставляет домены', () => {
    const domains = makeDomains(483);
    expect(chunkDomainsByUrlBudget(domains).flat()).toEqual(domains);
  });

  it('не отдаёт пустых чанков', () => {
    for (const chunk of chunkDomainsByUrlBudget(makeDomains(483))) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('домен длиннее всего бюджета уезжает в свой чанк, а не теряется', () => {
    const monster = `${'x'.repeat(DELETE_URL_BUDGET + 500)}.ru`;
    const chunks = chunkDomainsByUrlBudget(['a.ru', monster, 'b.ru']);
    expect(chunks.flat()).toEqual(['a.ru', monster, 'b.ru']);
    expect(chunks.some((c) => c.length === 1 && c[0] === monster)).toBe(true);
  });

  it('пустой вход — ни одного чанка (delete не зовём вхолостую)', () => {
    expect(chunkDomainsByUrlBudget([])).toEqual([]);
  });
});

describe('markSeen: GIS-ветка на боевом масштабе 13.08.2026', () => {
  it('483 домена уходят несколькими delete-запросами, каждый в пределах лимита URL', async () => {
    const domains = makeDomains(483);
    await markSeen(domains.map(gisRow));

    expect(deleteCalls.length).toBeGreaterThan(1); // ← до фикса был ровно 1 на ~10 КБ
    for (const call of deleteCalls) {
      expect(encodedLength(call.domains)).toBeLessThan(8192);
    }
  });

  it('удалено ровно то, что вставлено — ни один домен не потерян', async () => {
    const domains = makeDomains(483);
    await markSeen(domains.map(gisRow));

    expect(deleteCalls.flatMap((c) => c.domains).sort()).toEqual([...domains].sort());
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toHaveLength(483);
  });

  it('HH-строки идут своим upsert-потоком и в delete не попадают', async () => {
    const rows: SeenEmployerUpsert[] = [
      ...makeDomains(120).map(gisRow),
      {
        hh_employer_id: '777',
        hh_employer_name: 'ООО HH',
        domain: 'hh-only.ru',
        site_url: 'https://hh-only.ru',
        status: 'appended',
      },
    ];
    await markSeen(rows);

    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]).toHaveLength(1);
    expect(deleteCalls.flatMap((c) => c.domains)).not.toContain('hh-only.ru');
  });
});
