/** @jest-environment node */

/**
 * Бриф в письмах: УТП, гарантии, акция и цифры клиента — авторские
 * формулировки, их нужно брать дословно, а не пересказывать.
 *
 * До этого бриф уходил в промпт цепочки внутри общего JSON-снапшота brief:
 * модель его видела, но вперемешку с пустыми полями, escape-переносами и
 * служебным списком missing. Шаблон 85/15 брифа в промпте не видел вовсе.
 *
 * Внутренние строки брифа (контакты клиента, почта получателя тёплых лидов) в
 * промпт письма не идут: письму они не нужны, а утечь в текст могут.
 */

import { EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief';
import {
  compileClientBriefForLetters,
  splitBriefForLetterPrompt,
  type VeClientBrief,
} from '@/lib/verticalEngineV2/clientBriefIntake';
import { buildChainMessages, type ChainPromptInput } from '@/lib/verticalEngineV2/prompts/chain';
import {
  buildTemplatePlanMessages,
  type TemplatePlanPromptInput,
} from '@/lib/verticalEngineV2/prompts/template';

const BRIEF: VeClientBrief = {
  fields: {
    ...EMPTY_BRIEF_FIELDS,
    company_description: 'Консалтинг по ВЭД для владельцев товарного бизнеса',
    usp: 'Белый ВЭД под крупный бизнес',
    guarantees: 'Отсрочка до 90 дней и возврат брака 30 дней',
    impressive_numbers: '17 лет практики, 1000+ кейсов',
    special_offer: 'Скидка до 35% и маркетинговый бюджет 3% от счёта',
    company_contacts: 'Телефон: +7 (988) 389-85-49',
    lead_recipient_email: 'lead@client.ru',
    target_audience: 'Собственники и генеральные директора импортёров',
  },
  missing: [],
  icp: null,
  client_types: [],
  file_name: 'amb.docx',
  uploaded_at: '2026-08-22T10:00:00.000Z',
};

const baseChainInput: Omit<ChainPromptInput, 'language'> = {
  verticalName: 'Импортёры оборудования',
  verticalSummary: 'сводка',
  synonyms: [],
  hypotheses: [],
  briefText: '{"site_profile":{"company_name":"Фомичева"}}',
};

const basePlanInput: Omit<TemplatePlanPromptInput, 'clientBrief'> = {
  verticalName: 'Импортёры оборудования',
  verticalSummary: 'сводка',
  chainLetters: [{ subject: 'Тема', body: 'Тело', wait_days: 0 }],
  baseAnalysis: {
    geo_distribution: [],
    industry_distribution: [],
    company_type_distribution: [],
    title_distribution: [],
    notable_segments: [],
    recommended_angles: [],
  } as unknown as TemplatePlanPromptInput['baseAnalysis'],
  columns: ['company', 'email'],
};

function chainPrompt(clientBrief?: string): string {
  return buildChainMessages({ ...baseChainInput, language: 'ru', clientBrief })
    .map((m) => m.content)
    .join('\n');
}

describe('compileClientBriefForLetters', () => {
  it('keeps offer-critical wording and drops internal rows', () => {
    const text = compileClientBriefForLetters(BRIEF);

    expect(text).toContain('Белый ВЭД под крупный бизнес');
    expect(text).toContain('Отсрочка до 90 дней');
    expect(text).toContain('Скидка до 35%');
    expect(text).toContain('17 лет практики');

    expect(text).not.toContain('lead@client.ru');
    expect(text).not.toContain('+7 (988)');
  });

  it('gives the model client types instead of client names', () => {
    const withClients: VeClientBrief = {
      ...BRIEF,
      fields: { ...BRIEF.fields, existing_clients: 'Детский Мир, Familia, Вотоня' },
      client_types: ['федеральные сети детских товаров', 'региональные дистрибьюторы'],
    };

    const text = compileClientBriefForLetters(withClients);

    expect(text).toContain('федеральные сети детских товаров');
    // Имена из брифа могут быть под NDA — в письмо они не идут.
    expect(text).not.toContain('Детский Мир');
    expect(text).not.toContain('Familia');
  });

  it('says nothing about clients when the brief gave no types', () => {
    const withNames: VeClientBrief = {
      ...BRIEF,
      fields: { ...BRIEF.fields, existing_clients: 'Детский Мир, Familia' },
      client_types: [],
    };

    expect(compileClientBriefForLetters(withNames)).not.toContain('Детский Мир');
  });

  it('caps one huge field so it cannot eat the whole block', () => {
    const huge: VeClientBrief = {
      ...BRIEF,
      fields: { ...BRIEF.fields, advantages: 'преимущество '.repeat(4000) },
    };

    const text = compileClientBriefForLetters(huge);
    expect(text.length).toBeLessThan(4000);
    // Обрезка одного поля не выбивает остальные ответы клиента.
    expect(text).toContain('Белый ВЭД под крупный бизнес');
    expect(text).toContain('Отсрочка до 90 дней');
  });

  it('shares the budget so short offer fields survive long ones', () => {
    const long = 'ответ клиента '.repeat(120);
    const stuffed: VeClientBrief = {
      ...BRIEF,
      fields: {
        ...BRIEF.fields,
        product_description: long,
        advantages: long,
        competitors_problems: long,
        client_problems: long,
        common_questions: long,
        impressive_results: long,
      },
    };

    const text = compileClientBriefForLetters(stuffed, 2000);

    expect(text.length).toBeLessThanOrEqual(2000 + '\n…(обрезано)'.length);
    // Раздутые поля не вытесняют короткие ответы, ради которых блок и нужен.
    expect(text).toContain('Белый ВЭД под крупный бизнес');
    expect(text).toContain('Отсрочка до 90 дней');
    // Длинное поле в блоке есть, но урезано.
    expect(text).toContain('ответ клиента');
    expect(text).not.toContain(long);
  });

  it('returns an empty string for an empty brief', () => {
    expect(compileClientBriefForLetters({ ...BRIEF, fields: EMPTY_BRIEF_FIELDS })).toBe('');
    expect(compileClientBriefForLetters(null)).toBe('');
  });
});

describe('splitBriefForLetterPrompt', () => {
  it('takes client_brief and the override texts out of the JSON snapshot', () => {
    const { briefJson, clientBrief } = splitBriefForLetterPrompt({
      site_profile: { company_name: 'Фомичева' },
      site_thin: true,
      client_brief: BRIEF,
      style_override: 'пример письма',
      offer_override: 'оффер',
      signature_override: 'подпись',
    });

    expect(briefJson).toEqual({ site_profile: { company_name: 'Фомичева' }, site_thin: true });
    expect(clientBrief?.fields.usp).toBe('Белый ВЭД под крупный бизнес');
  });

  it('survives a project without a brief', () => {
    expect(splitBriefForLetterPrompt(null)).toEqual({ briefJson: {}, clientBrief: null });
  });
});

describe('buildChainMessages', () => {
  it('renders the client answers as their own block, not raw JSON', () => {
    const prompt = chainPrompt(compileClientBriefForLetters(BRIEF));

    expect(prompt).toContain('БРИФ КЛИЕНТА');
    expect(prompt).toContain('Белый ВЭД под крупный бизнес');
    expect(prompt).toContain('дословно');
    expect(prompt).not.toContain('"client_brief"');
    expect(prompt).not.toContain('"missing"');
  });

  it('keeps the site snapshot separate from the client answers', () => {
    const prompt = chainPrompt(compileClientBriefForLetters(BRIEF));
    expect(prompt).toContain('site_profile');
  });

  it('adds no block when the brief is absent', () => {
    expect(chainPrompt(undefined)).not.toContain('Белый ВЭД');
  });
});

describe('buildTemplatePlanMessages', () => {
  it('feeds the client answers into the 85/15 plan', () => {
    const prompt = buildTemplatePlanMessages({
      ...basePlanInput,
      clientBrief: compileClientBriefForLetters(BRIEF),
    })
      .map((m) => m.content)
      .join('\n');

    expect(prompt).toContain('БРИФ КЛИЕНТА');
    expect(prompt).toContain('Отсрочка до 90 дней');
  });

  it('adds no block without a brief', () => {
    const prompt = buildTemplatePlanMessages(basePlanInput as TemplatePlanPromptInput)
      .map((m) => m.content)
      .join('\n');
    expect(prompt).not.toContain('Отсрочка до 90 дней');
  });
});
