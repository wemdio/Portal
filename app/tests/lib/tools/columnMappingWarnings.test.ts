import {
  isEmailValue,
  isHhUrlValue,
  isSiteValue,
  getMappingContentWarnings,
} from '@/lib/tools/columnMappingWarnings';

describe('cell classifiers', () => {
  it('isEmailValue', () => {
    expect(isEmailValue('ivan@x.ru')).toBe(true);
    expect(isEmailValue('a.b+c@sub.domain.com')).toBe(true);
    expect(isEmailValue('not-an-email')).toBe(false);
    expect(isEmailValue('x@y')).toBe(false);
    expect(isEmailValue('company.ru')).toBe(false);
    expect(isEmailValue('')).toBe(false);
  });

  it('isHhUrlValue', () => {
    expect(isHhUrlValue('https://hh.ru/vacancy/123')).toBe(true);
    expect(isHhUrlValue('https://spb.hh.ru/employer/9')).toBe(true);
    expect(isHhUrlValue('hh.ru/employer/1')).toBe(true);
    expect(isHhUrlValue('company.ru')).toBe(false);
    expect(isHhUrlValue('ivan@hh.ru')).toBe(false); // it's an email, not an hh.ru URL (hh.ru preceded by '@')
  });

  it('isSiteValue (real domains true; emails/names false)', () => {
    for (const s of ['company.com', 'https://x.ru/path', 'www.a.рф', 'b.io']) {
      expect(isSiteValue(s)).toBe(true);
    }
    for (const s of ['ivan@x.ru', 'ООО Ромашка', 'Видеостудия', '', '123']) {
      expect(isSiteValue(s)).toBe(false);
    }
  });
});

// helper to build a 2-col file [company, site] (+ optional email) and map them
function file(cols: Record<string, string[]>): {
  header: string[];
  rows: string[][];
  mapping: Record<string, string>;
} {
  const names = Object.keys(cols);
  const len = Math.max(...names.map((n) => cols[n].length));
  const header = names;
  const rows = Array.from({ length: len }, (_, i) => names.map((n) => cols[n][i] ?? ''));
  // map role→columnName: column named like the role canonical
  const mapping: Record<string, string> = {};
  if (header.includes('компания')) mapping.company = 'компания';
  if (header.includes('сайт')) mapping.site = 'сайт';
  if (header.includes('email')) mapping.email = 'email';
  return { header, rows, mapping };
}

const sites = ['a.ru', 'b.com', 'c.io', 'd.рф', 'e.org', 'f.net'];
const emails = ['a@x.ru', 'b@x.ru', 'c@x.ru', 'd@x.ru', 'e@x.ru', 'f@x.ru'];
const hh = ['hh.ru/vacancy/1', 'hh.ru/vacancy/2', 'hh.ru/vacancy/3', 'hh.ru/vacancy/4', 'hh.ru/vacancy/5', 'hh.ru/vacancy/6'];
const names = ['ООО Ромашка', 'Студия Один', 'Бета Онлайн', 'Комплето', 'Гамма', 'Дельта'];

describe('getMappingContentWarnings — no false alarms on valid columns', () => {
  it('site=real sites, company=names, email=emails → ZERO warnings', () => {
    const { header, rows, mapping } = file({ компания: names, сайт: sites, email: emails });
    expect(getMappingContentWarnings(header, rows, mapping)).toEqual([]);
  });

  it('mixed site column that is still ≥50% sites → no warning', () => {
    const mixed = ['a.ru', 'b.com', 'c.io', 'мусор', 'тоже не сайт', 'd.org']; // 4/6 sites
    const { header, rows, mapping } = file({ сайт: mixed });
    expect(getMappingContentWarnings(header, rows, mapping)).toEqual([]);
  });

  it('too few non-empty values (<5) → no warning even if wrong', () => {
    const { header, rows, mapping } = file({ сайт: ['a@x.ru', 'b@x.ru', '', '', ''] }); // only 2 non-empty
    expect(getMappingContentWarnings(header, rows, mapping)).toEqual([]);
  });
});

describe('getMappingContentWarnings — catches the real mistakes', () => {
  it('site column holds hh.ru links → warns about hh.ru', () => {
    const { header, rows, mapping } = file({ сайт: hh });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w).toHaveLength(1);
    expect(w[0].role).toBe('site');
    expect(w[0].message).toMatch(/hh\.ru/);
  });

  it('site column holds emails → warns (reelscut case)', () => {
    const { header, rows, mapping } = file({ сайт: emails });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w).toHaveLength(1);
    expect(w[0].role).toBe('site');
    expect(w[0].message).toMatch(/email/i);
  });

  it('site column holds plain names → warns (not sites)', () => {
    const { header, rows, mapping } = file({ сайт: names });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w).toHaveLength(1);
    expect(w[0].role).toBe('site');
  });

  it('company column holds sites → warns (sands case: company=company_site_url)', () => {
    const { header, rows, mapping } = file({ компания: sites });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w.some((x) => x.role === 'company')).toBe(true);
  });

  it('company column holds emails → warns', () => {
    const { header, rows, mapping } = file({ компания: emails });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w.some((x) => x.role === 'company')).toBe(true);
  });

  it('email column holds non-emails → warns', () => {
    const { header, rows, mapping } = file({ email: names });
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w.some((x) => x.role === 'email')).toBe(true);
  });

  it('the full broken sands mapping (site=hh, company=sites) → two warnings', () => {
    const { header, rows } = file({ компания: sites, сайт: hh });
    const mapping = { company: 'компания', site: 'сайт' };
    const w = getMappingContentWarnings(header, rows, mapping);
    expect(w.map((x) => x.role).sort()).toEqual(['company', 'site']);
  });
});

describe('getMappingContentWarnings — edge cases', () => {
  it('unmapped roles → no warning', () => {
    expect(getMappingContentWarnings(['x'], [['1']], {})).toEqual([]);
  });
  it('mapped column not in header → no crash, no warning', () => {
    expect(getMappingContentWarnings(['a'], [['1']], { site: 'nonexistent' })).toEqual([]);
  });
});
