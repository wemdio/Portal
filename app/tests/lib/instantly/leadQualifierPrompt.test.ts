/** @jest-environment node */

import { _private } from '@/lib/instantly/leadQualifier';

describe('buildSystemPrompt — дефолтные критерии лида', () => {
  it('прямой CTA = ЛИД даже без найденного исходящего письма или увиденного предложения', () => {
    const prompt = _private.buildSystemPrompt(null, null);

    expect(prompt).toContain('Наличие нашего исходящего письма или развёрнутого предложения НЕ является обязательным');
    expect(prompt).toContain('«Давайте завтра проведём встречу»');
    expect(prompt).toContain('«Можете меня набрать в 14:00»');
    expect(prompt).toContain('is_lead=true');
    expect(prompt).toContain('Для однозначного лида ставь needs_review=false');
  });

  it('конкретный коммерческий запрос = ЛИД без найденного исходящего письма', () => {
    const prompt = _private.buildSystemPrompt(null, null);

    expect(prompt).toContain('КП или коммерческое предложение');
    expect(prompt).toContain('цену, стоимость, тарифы, расчёт или смету');
    expect(prompt).toContain('proposal_seen=false НЕ отменяет лид');
  });

  it('общая просьба прислать предложение или ознакомительные материалы без коммерческого намерения — НЕ лид', () => {
    const prompt = _private.buildSystemPrompt(null, null);

    expect(prompt).toContain('«пришлите предложение»');
    expect(prompt).toContain('«пришлите информацию/материалы/презентацию»');
    expect(prompt).toContain('сами по себе НЕ являются лидом');
    expect(prompt).toContain('ставь is_lead=false, needs_review=false');
  });

  it('неоднозначный интерес и запрос разъяснения — НЕ лид, а needs_review', () => {
    const prompt = _private.buildSystemPrompt(null, null);

    expect(prompt).toContain('«интересно» без конкретного следующего шага');
    expect(prompt).toContain('«расскажите подробнее» без конкретного следующего шага — ставь is_lead=false, needs_review=true');
    expect(prompt).toMatch(/запрос РАЗЪЯСНЕНИЯ/i);
    expect(prompt).toContain('is_lead=false, needs_review=true');
  });

  it('соседние правила не сломаны: контакт-ответ без интереса и автоответы — не лид', () => {
    const prompt = _private.buildSystemPrompt(null, null);
    expect(prompt).toMatch(/ответ на запрос контакта без интереса к решению/i);
    expect(prompt).toContain('Автоответ/отпуск');
    expect(prompt).toContain('Запрос контакта ответственного — это НЕ предложение');
  });

  it('кастомный критерий проекта вставляется с приоритетом', () => {
    const prompt = _private.buildSystemPrompt(null, 'Все ответы с вопросами — лиды');
    expect(prompt).toContain('Все ответы с вопросами — лиды');
    expect(prompt).toContain('ПРИОРИТЕТ у этого определения');
    expect(prompt).toContain('ФИНАЛЬНАЯ ПРОВЕРКА КАСТОМНОГО КРИТЕРИЯ');
    expect(prompt.lastIndexOf('ПРИОРИТЕТ у кастомного определения')).toBeGreaterThan(
      prompt.indexOf('ОБЩЕЕ ЛЮБОПЫТСТВО — НЕ ЛИД'),
    );
  });
});
