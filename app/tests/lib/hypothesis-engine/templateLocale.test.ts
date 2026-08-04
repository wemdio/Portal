/** @jest-environment node */

/**
 * Locale-keyed template: системные блоки плана 85/15 и финальных писем,
 * критик/рерайт (фасады над chain-билдерами) выбираются по языку цепочки
 * (наследуется от he_chains.language). RU — исходные русские тексты
 * (поведение не меняется), EN — перевод по смыслу, PL — перевода системных
 * блоков пока нет, используется RU-вариант.
 */

import {
  buildTemplateCriticMessages,
  buildTemplateLettersMessages,
  buildTemplatePlanMessages,
  buildTemplateRewriteMessages,
} from '@/lib/hypothesisEngine/prompts/template';
import type { HeBaseAnalysisOutput, HeTemplatePlanOutput } from '@/lib/hypothesisEngine/schemas';

const baseAnalysis: HeBaseAnalysisOutput = {
  geo_distribution: [],
  industry_distribution: [],
  company_type_distribution: [],
  title_distribution: [],
  notable_segments: [],
  data_quality_notes: '',
  recommended_angles: [],
};

const chainLetters = [{ subject: 'Тема', body: 'Тело', wait_days: 0 }];

const plan: HeTemplatePlanOutput = {
  fixed_block: 'костяк',
  personalization_plan: [],
  segment_additions: [],
  letters: [],
};

const planInput = {
  verticalName: 'HR-агентства',
  verticalSummary: 'сводка',
  chainLetters,
  baseAnalysis,
  columns: ['Имя'],
};

const lettersInput = {
  plan,
  verticalName: 'HR-агентства',
  chainLetters,
  baseAnalysis,
};

describe('buildTemplatePlanMessages — язык системного блока (наследуется от цепочки)', () => {
  it('без language — русский системный блок (back-compat, поведение не изменилось)', () => {
    const [system] = buildTemplatePlanMessages(planInput);
    expect(system.content).toContain('creative director агентства Polza');
    expect(system.content).toContain('# Регламент аутрич-писем');
    expect(system.content).toContain('Отвечай строго на русском');
  });

  it('language=ru — тот же русский системный блок, что и без language', () => {
    const [withRu] = buildTemplatePlanMessages({ ...planInput, language: 'ru' });
    const [legacy] = buildTemplatePlanMessages(planInput);
    expect(withRu.content).toBe(legacy.content);
  });

  it('language=en — системный блок и регламент на английском', () => {
    const [system] = buildTemplatePlanMessages({ ...planInput, language: 'en' });
    expect(system.content).toContain('creative director of the Polza agency');
    expect(system.content).toContain('# Outreach email regulations');
    expect(system.content).not.toContain('# Регламент аутрич-писем');
    expect(system.content).toContain('Answer strictly in English');
    expect(system.content).not.toContain('Отвечай строго на русском');
  });

  it('language=pl — перевода системного блока нет, RU-вариант', () => {
    const [pl] = buildTemplatePlanMessages({ ...planInput, language: 'pl' });
    const [ru] = buildTemplatePlanMessages({ ...planInput, language: 'ru' });
    expect(pl.content).toBe(ru.content);
  });
});

describe('buildTemplateLettersMessages — системный блок по языку цепочки', () => {
  it('ru: русский системный блок и ack (поведение не изменилось)', () => {
    const [system, , ack, task] = buildTemplateLettersMessages({ ...lettersInput, language: 'ru' });
    expect(system.content).toContain('senior email outreach специалист агентства Polza');
    expect(system.content).toContain('# Регламент аутрич-писем');
    expect(ack.content).toBe('План и регламент в контексте. Пишу финальные письма строго по плану.');
    expect(task.content).toContain('Напиши финальные письма цепочки строго по плану');
  });

  it('en: системный блок и регламент на английском, ack по-английски', () => {
    const [system, , ack, task] = buildTemplateLettersMessages({ ...lettersInput, language: 'en' });
    expect(system.content).toContain('senior email outreach specialist at the Polza agency');
    expect(system.content).toContain('# Outreach email regulations');
    expect(system.content).not.toContain('# Регламент аутрич-писем');
    expect(ack.content).toBe(
      'The plan and the regulations are in context. Writing the final emails strictly per the plan.',
    );
    expect(task.content).toContain('Write the final sequence emails');
  });

  it('pl: системный блок — RU-вариант (перевода нет), ack по-польски', () => {
    const [plSystem, , plAck, plTask] = buildTemplateLettersMessages({ ...lettersInput, language: 'pl' });
    const [ruSystem] = buildTemplateLettersMessages({ ...lettersInput, language: 'ru' });
    expect(plSystem.content).toBe(ruSystem.content);
    expect(plAck.content).toContain('kontekście');
    // Пин: локализованная задача (LETTERS_TASK.pl) не сломана.
    expect(plTask.content).toContain('Napisz finalne maile sekwencji');
  });
});

describe('template критик/рерайт — фасады над chain-билдерами, язык наследуется', () => {
  const letters = [{ subject: 'S', body: 'B' }];
  const critique = { verdict: 'v', issues: [] };

  it('критик: en — английский системный блок; ru — русский (не изменился)', () => {
    const [enSystem] = buildTemplateCriticMessages({ verticalName: 'HR', letters, language: 'en' });
    expect(enSystem.content).toContain('skeptical busy decision-maker');
    expect(enSystem.content).not.toContain('скептичный занятой ЛПР');

    const [ruSystem] = buildTemplateCriticMessages({ verticalName: 'HR', letters, language: 'ru' });
    expect(ruSystem.content).toContain('скептичный занятой ЛПР');
  });

  it('рерайт: en — английский системный блок; ru — русский (не изменился)', () => {
    const [enSystem] = buildTemplateRewriteMessages({ verticalName: 'HR', letters, critique, language: 'en' });
    expect(enSystem.content).toContain('senior email outreach editor at the Polza agency');
    expect(enSystem.content).not.toContain('редактор агентства Polza');

    const [ruSystem] = buildTemplateRewriteMessages({ verticalName: 'HR', letters, critique, language: 'ru' });
    expect(ruSystem.content).toContain('senior email outreach редактор агентства Polza');
  });
});
