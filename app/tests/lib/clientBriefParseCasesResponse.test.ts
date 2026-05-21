import {
  casesPatchToBriefPatch,
  parseCasesResponse,
} from '@/lib/clientBrief/autofill/enrichers/cases';

describe('parseCasesResponse', () => {
  it('парсит валидный JSON-ответ', () => {
    const raw = JSON.stringify({
      cases_comment:
        'Сеть гипермаркетов «Петрович» — настройка email-outreach — 142 лида за квартал\nIT-интегратор — холодные письма — выручка +28 млн ₽',
      impressive_results: 'Средний ROI x3.5\nКонверсия выросла на 18%',
      existing_clients: 'Петрович, Selectel, СберМаркет',
    });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toContain('Петрович');
    expect(patch.impressive_results).toContain('ROI');
    expect(patch.existing_clients).toContain('Selectel');
  });

  it('парсит JSON в ```json fence```', () => {
    const raw = '```json\n{"cases_comment": "Клиент A — задача — 30% рост"}\n```';
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toContain('30% рост');
  });

  it('парсит JSON, обёрнутый текстом', () => {
    const raw = 'Вот JSON: {"cases_comment": "Клиент Б — описание — результат 1000+"}';
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toContain('1000+');
  });

  it('возвращает пустой объект на невалидном JSON', () => {
    expect(parseCasesResponse('not json at all')).toEqual({});
    expect(parseCasesResponse('')).toEqual({});
    expect(parseCasesResponse(null)).toEqual({});
    expect(parseCasesResponse(undefined)).toEqual({});
  });

  it('фильтрует "отписку" в cases_comment: "Есть раздел кейсов на сайте"', () => {
    const raw = JSON.stringify({ cases_comment: 'Есть раздел кейсов на сайте' });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toBeUndefined();
  });

  it('фильтрует "85+ проектов" как отписку', () => {
    const raw = JSON.stringify({ cases_comment: '85+ проектов с разными клиентами' });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toBeUndefined();
  });

  it('фильтрует "Кейсы есть на сайте" в impressive_results', () => {
    const raw = JSON.stringify({ impressive_results: 'Кейсы есть на сайте' });
    const patch = parseCasesResponse(raw);
    expect(patch.impressive_results).toBeUndefined();
  });

  it('пропускает кейсы с тире как реальный контент', () => {
    const raw = JSON.stringify({
      cases_comment: 'Клиент А — задача — результат',
    });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toBe('Клиент А — задача — результат');
  });

  it('пропускает длинные кейсы без тире (>80 симв) как реальный контент', () => {
    const longText =
      'Подробное описание нашего сотрудничества с клиентом включало несколько этапов работы и завершилось успешно';
    const raw = JSON.stringify({ cases_comment: longText });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toBe(longText);
  });

  it('existing_clients пропускает короткие списки имён без stub-фильтра', () => {
    const raw = JSON.stringify({ existing_clients: 'Газпром, Сбер, Яндекс' });
    const patch = parseCasesResponse(raw);
    expect(patch.existing_clients).toBe('Газпром, Сбер, Яндекс');
  });

  it('обрабатывает не-строки в полях', () => {
    const raw = JSON.stringify({
      cases_comment: 123,
      impressive_results: ['array'],
      existing_clients: null,
    });
    const patch = parseCasesResponse(raw);
    expect(patch.cases_comment).toBeUndefined();
    expect(patch.impressive_results).toBeUndefined();
    expect(patch.existing_clients).toBeUndefined();
  });
});

describe('casesPatchToBriefPatch', () => {
  it('переносит impressive_results и existing_clients один-в-один', () => {
    const briefPatch = casesPatchToBriefPatch({
      impressive_results: 'X',
      existing_clients: 'Y',
    });
    expect(briefPatch.impressive_results).toBe('X');
    expect(briefPatch.existing_clients).toBe('Y');
  });

  it('заворачивает cases_comment в social_proof.cases', () => {
    const briefPatch = casesPatchToBriefPatch({ cases_comment: 'Кейс 1\nКейс 2' });
    expect(briefPatch.social_proof).toBeDefined();
    const sp = briefPatch.social_proof as { cases?: { has: boolean; comment: string } };
    expect(sp.cases?.has).toBe(true);
    expect(sp.cases?.comment).toBe('Кейс 1\nКейс 2');
  });

  it('возвращает пустой patch если ничего не заполнено', () => {
    expect(casesPatchToBriefPatch({})).toEqual({});
  });

  it('не добавляет social_proof если cases_comment пустой', () => {
    const briefPatch = casesPatchToBriefPatch({ impressive_results: 'X' });
    expect(briefPatch.social_proof).toBeUndefined();
  });
});
