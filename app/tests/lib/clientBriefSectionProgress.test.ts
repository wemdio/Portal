import { EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief/constants';
import type { ClientBriefFields } from '@/lib/clientBrief/types';
import {
  BRIEF_SECTIONS,
  isBriefSectionFilled,
  briefSectionsFilled,
  briefFilledCount,
} from '@/lib/clientBrief/sectionProgress';

function empty(): ClientBriefFields {
  // Глубокая копия, чтобы мутации social_proof не текли между кейсами.
  return JSON.parse(JSON.stringify(EMPTY_BRIEF_FIELDS)) as ClientBriefFields;
}

describe('BRIEF_SECTIONS', () => {
  it('ровно 7 разделов с уникальными номерами 1..7 и якорями', () => {
    expect(BRIEF_SECTIONS).toHaveLength(7);
    expect(BRIEF_SECTIONS.map((s) => s.num)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(BRIEF_SECTIONS.map((s) => s.anchorId)).size).toBe(7);
    BRIEF_SECTIONS.forEach((s) => expect(s.anchorId).toBe(`brief-section-${s.num}`));
  });
});

describe('isBriefSectionFilled', () => {
  it('пустой бриф — все 7 разделов НЕ заполнены (0/7)', () => {
    const f = empty();
    for (let n = 1; n <= 7; n++) expect(isBriefSectionFilled(n, f)).toBe(false);
    expect(briefFilledCount(f)).toBe(0);
  });

  it('одно непустое поле делает раздел заполненным (по одному на каждый)', () => {
    const cases: Array<[number, (f: ClientBriefFields) => void]> = [
      [1, (f) => (f.company_description = 'ООО Ромашка')],
      [2, (f) => (f.usp = 'Уникальное УТП')],
      [3, (f) => (f.target_audience = 'B2B маркетологи')],
      [4, (f) => (f.persona_name = 'Иван')],
      [5, (f) => (f.existing_clients = 'РБК, Ozon')],
      [7, (f) => (f.additional_notes = 'что-то ещё')],
    ];
    for (const [num, mut] of cases) {
      const f = empty();
      mut(f);
      expect(isBriefSectionFilled(num, f)).toBe(true);
      // остальные разделы остаются пустыми
      expect(briefFilledCount(f)).toBe(1);
    }
  });

  it('раздел 2 считается заполненным и по price_tier (не строковое поле)', () => {
    const f = empty();
    f.price_tier = 'premium' as ClientBriefFields['price_tier'];
    expect(isBriefSectionFilled(2, f)).toBe(true);
  });

  it('пробелы не считаются заполнением', () => {
    const f = empty();
    f.company_description = '   \n  ';
    expect(isBriefSectionFilled(1, f)).toBe(false);
  });

  it('раздел 6 (social proof): has=true ИЛИ непустой comment', () => {
    const byHas = empty();
    byHas.social_proof.ratings.has = true;
    expect(isBriefSectionFilled(6, byHas)).toBe(true);

    const byComment = empty();
    byComment.social_proof.media.comment = 'ссылка на статью';
    expect(isBriefSectionFilled(6, byComment)).toBe(true);

    const none = empty();
    expect(isBriefSectionFilled(6, none)).toBe(false);
  });

  it('полностью заполненный бриф — 7/7', () => {
    const f = empty();
    f.company_description = 'x';
    f.usp = 'x';
    f.target_audience = 'x';
    f.persona_name = 'x';
    f.existing_clients = 'x';
    f.social_proof.cases.has = true;
    f.additional_notes = 'x';
    expect(briefFilledCount(f)).toBe(7);
    const map = briefSectionsFilled(f);
    for (let n = 1; n <= 7; n++) expect(map[n]).toBe(true);
  });

  it('неизвестный номер раздела → false (без исключения)', () => {
    expect(isBriefSectionFilled(0, empty())).toBe(false);
    expect(isBriefSectionFilled(8, empty())).toBe(false);
  });
});
