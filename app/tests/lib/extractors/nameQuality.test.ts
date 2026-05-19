/** @jest-environment node */

import {
  isHashLike,
  isDesignArtifact,
  isNavOrCtaText,
  isServiceText,
  isPlausibleName,
  nameListLooksReal,
} from '@/lib/enrich/extractors/nameQuality';

// Real-world garbage observed in the "Сигналы" output spreadsheet — these are
// the exact noise classes the heuristic extractors used to leak into the
// "Клиенты" and "Интеграции" columns.
const CMS_HASHES = [
  'ayvervdk9wrpaqde6begp6jfmg',
  'rhj4ne9qcsw3fxjhixceuvnucsxwjv',
  'odv2ua3vitkm3jm1edk2yuvkykyjaz',
  '3abc4d6a3ca0dabbed3',
  'ee3ccb6fe4beb0bb6fee',
];

const DESIGN_ARTIFACTS = ['partner1', 'partner2', '1 Слой 5', 'Frame 2 6 1 1', 'dummy', '6 место'];
const NAV_CTA = ['Работа у нас', 'Отзывы', 'О компании', 'FAQ', 'Скачать нашу презентацию', 'Подробнее о нас', 'Цена в месяц от'];
const SERVICES = ['Аудит и анализ', 'Контекстная реклама', 'Медийная реклама', 'Контент-маркетинг'];

const REAL_NAMES = ['Газпром нефть', 'Росбанк', 'Сколково', 'Samsung', 'Metro', 'amoCRM', 'mindbox', 'Тинькофф'];

describe('nameQuality predicates', () => {
  it('flags CMS image-hash slugs', () => {
    for (const h of CMS_HASHES) expect(isHashLike(h)).toBe(true);
  });

  it('does not flag real company names as hashes', () => {
    for (const n of REAL_NAMES) expect(isHashLike(n)).toBe(false);
  });

  it('flags design-tool export artifacts', () => {
    for (const a of DESIGN_ARTIFACTS) expect(isDesignArtifact(a)).toBe(true);
  });

  it('flags nav/CTA labels', () => {
    for (const t of NAV_CTA) expect(isNavOrCtaText(t)).toBe(true);
  });

  it('flags marketing service names', () => {
    for (const s of SERVICES) expect(isServiceText(s)).toBe(true);
  });

  it('keeps real company names plausible', () => {
    for (const n of REAL_NAMES) expect(isPlausibleName(n)).toBe(true);
  });

  it('rejects every noise class as not plausible', () => {
    for (const junk of [...CMS_HASHES, ...DESIGN_ARTIFACTS, ...NAV_CTA, ...SERVICES]) {
      expect(isPlausibleName(junk)).toBe(false);
    }
  });
});

describe('nameListLooksReal trust gate', () => {
  it('distrusts a junk-heavy list so the LLM fallback can run', () => {
    expect(nameListLooksReal([...SERVICES, ...CMS_HASHES])).toBe(false);
  });

  it('trusts a clean list of real names', () => {
    expect(nameListLooksReal(REAL_NAMES)).toBe(true);
  });

  it('keeps a single plausible name', () => {
    expect(nameListLooksReal(['Газпром'])).toBe(true);
  });

  it('drops a single junk entry', () => {
    expect(nameListLooksReal(['ayvervdk9wrpaqde6begp6jfmg'])).toBe(false);
  });

  it('treats an empty list as untrusted', () => {
    expect(nameListLooksReal([])).toBe(false);
  });
});
