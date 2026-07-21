import {
  buildHhTitleOnlyQuery,
  getHhReportedFound,
  hasHhSearchTerms,
  isPlainHhUserQuery,
  matchesHhVacancyTitle,
  parseHhTitleTerms,
  shouldUseStrictHhTitleMatch,
} from '@/lib/parsers/hhRelevance';

describe('HH vacancy title relevance', () => {
  it('treats a normal comma-separated user query as alternative job titles', () => {
    expect(parseHhTitleTerms(' ветеринарный врач, ветеринар ')).toEqual([
      'ветеринарный врач',
      'ветеринар',
    ]);
  });

  it('keeps veterinary vacancies and rejects unrelated Burger King vacancies', () => {
    const query = 'ветеринарный врач, ветеринар';

    expect(matchesHhVacancyTitle('Ветеринарный врач УЗИ / терапевт', query)).toBe(true);
    expect(matchesHhVacancyTitle('Ассистент ветеринарного врача', query)).toBe(true);
    expect(matchesHhVacancyTitle('Повар-кассир (Сотрудник ресторана)', query)).toBe(false);
    expect(matchesHhVacancyTitle('Уборщик', query)).toBe(false);
  });

  it('supports newline, semicolon and pipe separators and ignores duplicates', () => {
    expect(parseHhTitleTerms('ветеринар; ветеринар\nветеринарный врач | ветврач')).toEqual([
      'ветеринар',
      'ветеринарный врач',
      'ветврач',
    ]);
  });

  it('turns strict user input into separate HH queries', () => {
    expect(buildHhTitleOnlyQuery('veterinary doctor, veterinarian')).toBe(
      'veterinary doctor|veterinarian',
    );
  });

  it('matches Russian inflections and reversed title words', () => {
    const query = 'ветеринарный врач';

    expect(matchesHhVacancyTitle('Ассистент ветеринарного врача', query)).toBe(true);
    expect(matchesHhVacancyTitle('Врач ветеринарный', query)).toBe(true);
  });

  it('does not confuse short exact roles or related technology names', () => {
    expect(matchesHhVacancyTitle('JavaScript developer', 'Java')).toBe(false);
    expect(matchesHhVacancyTitle('Java developer', 'Java')).toBe(true);
    expect(matchesHhVacancyTitle('Architect', 'IT')).toBe(false);
    expect(matchesHhVacancyTitle('Директолог', 'директор')).toBe(false);
    expect(matchesHhVacancyTitle('Маркетплейс-менеджер', 'маркетолог')).toBe(false);
    expect(matchesHhVacancyTitle('Массажер оборудования', 'массажист')).toBe(false);
    expect(matchesHhVacancyTitle('Заместитель директора', 'директор')).toBe(true);
  });

  it('recognizes the common Russian vet-doctor abbreviation', () => {
    expect(matchesHhVacancyTitle('Ветврач', 'ветеринар')).toBe(true);
    expect(matchesHhVacancyTitle('Помощник ветврача', 'ветеринарный врач')).toBe(true);
  });

  it('keeps advanced HH syntax out of friendly strict mode', () => {
    expect(isPlainHhUserQuery('ветеринарный врач, ветеринар')).toBe(true);
    expect(isPlainHhUserQuery('NAME:(ветеринарный врач OR ветеринар)')).toBe(false);
    expect(isPlainHhUserQuery('ветеринар NOT ассистент')).toBe(false);
    expect(shouldUseStrictHhTitleMatch('ветеринар, ветеринарный врач')).toBe(true);
    expect(shouldUseStrictHhTitleMatch(',,,')).toBe(false);
    expect(shouldUseStrictHhTitleMatch('NAME:(ветеринар OR ветврач)')).toBe(false);
    expect(hasHhSearchTerms('NAME:(ветеринар OR ветврач)')).toBe(true);
    expect(hasHhSearchTerms(',,,')).toBe(false);
  });

  it('reports unique relevant rows instead of raw HH hits in strict mode', () => {
    expect(getHhReportedFound(true, 4004, 1865)).toBe(1865);
    expect(getHhReportedFound(false, 4004, 1865)).toBe(4004);
  });
});
