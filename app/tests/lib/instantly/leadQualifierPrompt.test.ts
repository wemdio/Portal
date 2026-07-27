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
