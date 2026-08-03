/** @jest-environment node */

import { _private } from '@/lib/instantly/leadQualifier';

describe('buildSystemPrompt — дефолтные критерии лида', () => {
  it('запрос цен/материалов = ЛИД даже без увиденного предложения (кейс Alial/Эталон 22.07)', () => {
    const prompt = _private.buildSystemPrompt(null, null);
    // Исключение: материалы/цены — лид и при proposal_seen=false, иначе ИИ
    // дисквалифицировал горячих лидов после опенера «Ищу ответственного».
    expect(prompt).toContain('даже если развёрнутое предложение ещё НЕ отправлено');
    expect(prompt).toContain('is_lead=true');
    expect(prompt).toContain('proposal_seen=false здесь НЕ отменяет лид');
    expect(prompt).toContain('ИСКЛЮЧЕНИЕ: запрос цен/стоимости/КП/материалов — ЛИД и без увиденного предложения');
  });

  it('запрос разъяснения «что вы предлагаете?» — НЕ лид, а needs_review (кейс Alt Point 03.08)', () => {
    const prompt = _private.buildSystemPrompt(null, null);
    // Ложный лид v.patz@mail.ru (Alt Point): клиент НЕ понял оффер и спросил
    // «Напишите, что Вы предлагаете?» — ИИ отнёс это к «запросу предложения»
    // по правилу Alial. Это разные интенты: запрос материалов (понял оффер,
    // просит конкретику) = лид; запрос разъяснения (не понял, что предлагают)
    // = не лид, уходит спецу на ручной ответ без пинга лида.
    expect(prompt).toContain('запрос РАЗЪЯСНЕНИЯ');
    expect(prompt).toContain('это НЕ запрос материалов');
    expect(prompt).toContain('is_lead=false, needs_review=true');
  });

  it('соседние правила не сломаны: контакт-ответ без интереса и автоответы — не лид', () => {
    const prompt = _private.buildSystemPrompt(null, null);
    expect(prompt).toContain('ответ на запрос контакта без интереса к решению');
    expect(prompt).toContain('Автоответ/отпуск');
    expect(prompt).toContain('Запрос контакта ответственного — это НЕ предложение');
  });

  it('кастомный критерий проекта вставляется с приоритетом', () => {
    const prompt = _private.buildSystemPrompt(null, 'Все ответы с вопросами — лиды');
    expect(prompt).toContain('Все ответы с вопросами — лиды');
    expect(prompt).toContain('ПРИОРИТЕТ у этого определения');
  });
});
