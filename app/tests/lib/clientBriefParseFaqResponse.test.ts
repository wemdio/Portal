import {
  parseFaqResponse,
  faqPatchToBriefPatch,
} from '@/lib/clientBrief/autofill/enrichers/faq';

describe('parseFaqResponse', () => {
  it('парсит валидный JSON с QA-блоками', () => {
    const raw = JSON.stringify({
      common_questions:
        'В: Сколько стоит?\nО: От 80к/мес\n\nВ: Когда первые результаты?\nО: 2-3 недели',
      client_problems:
        'Не понимают сколько лидов получат\nБоятся бана домена\nНе хотят зависеть от канала',
    });
    const patch = parseFaqResponse(raw);
    expect(patch.common_questions).toContain('Сколько стоит');
    expect(patch.client_problems).toContain('бана');
  });

  it('принимает common_questions с просто вопросительными знаками', () => {
    const raw = JSON.stringify({
      common_questions:
        'Сколько стоит услуга?\nКогда первые результаты?\nЧто входит в тариф?',
    });
    const patch = parseFaqResponse(raw);
    expect(patch.common_questions).toContain('Сколько');
  });

  it('фильтрует common_questions без вопросов', () => {
    const raw = JSON.stringify({
      common_questions: 'На сайте есть FAQ с разными вопросами',
    });
    expect(parseFaqResponse(raw).common_questions).toBeUndefined();
  });

  it('фильтрует common_questions со stub-фразой', () => {
    const raw = JSON.stringify({
      common_questions: 'FAQ есть на сайте? Да, конечно?',
    });
    expect(parseFaqResponse(raw).common_questions).toBeUndefined();
  });

  it('принимает client_problems если >=2 строк', () => {
    const raw = JSON.stringify({
      client_problems: 'Боль 1\nБоль 2',
    });
    expect(parseFaqResponse(raw).client_problems).toBe('Боль 1\nБоль 2');
  });

  it('принимает client_problems если 1 длинная строка (>40 симв)', () => {
    const longProblem =
      'Клиенты обожглись на холодных рассылках и боятся повторного провала';
    const raw = JSON.stringify({ client_problems: longProblem });
    expect(parseFaqResponse(raw).client_problems).toBe(longProblem);
  });

  it('фильтрует client_problems с короткой stub-фразой', () => {
    const raw = JSON.stringify({ client_problems: 'Разные проблемы' });
    expect(parseFaqResponse(raw).client_problems).toBeUndefined();
  });

  it('возвращает пустой объект на невалидном JSON', () => {
    expect(parseFaqResponse(null)).toEqual({});
  });
});

describe('faqPatchToBriefPatch', () => {
  it('переносит common_questions и client_problems один-в-один', () => {
    const briefPatch = faqPatchToBriefPatch({
      common_questions: 'В: A?\nО: B',
      client_problems: 'X\nY',
    });
    expect(briefPatch.common_questions).toBe('В: A?\nО: B');
    expect(briefPatch.client_problems).toBe('X\nY');
  });

  it('пустой patch если ничего не заполнено', () => {
    expect(faqPatchToBriefPatch({})).toEqual({});
  });

  it('не трогает social_proof — FAQ это не social proof', () => {
    const briefPatch = faqPatchToBriefPatch({ common_questions: 'q' });
    expect(briefPatch.social_proof).toBeUndefined();
  });
});
