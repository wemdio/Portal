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
import { structureCaseTexts, validateCaseDrafts } from '@/lib/verticalEngineV2/caseBank';
import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import { refreshSiteCases } from '@/lib/verticalEngineV2/stages/siteProfile';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';
import { POST as postCases } from '@/app/api/tools/vertical-engine-v2/projects/[id]/cases/route';

let mockCaseDb = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockCaseDb; } }));
jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({ auth: { userId: 'specialist' } })),
}));
jest.mock('@/lib/toolTrace', () => ({ withToolTrace: (_context: unknown, work: () => unknown) => work() }));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(), logError: jest.fn() }));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/llm'),
  callLLMWithSchema: jest.fn(),
}));

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

describe('client case imports and refresh', () => {
  const sourceA = 'Кейс сети кофеен Додо.\nИзготовили 3000 стикеров за 2 недели. Клиент успел запустить рекламную кампанию.';
  const sourceB = 'Кейс спортивного клуба. Оформили 48 подарочных наборов. Болельщики получили готовый мерч к матчу.';
  const raw = `${sourceA}\n\n---\n\n${sourceB}`;
  const drafts = [
    { industry: 'HoReCa', client_type: 'сеть кофеен Додо', task: 'Изготовить стикеры для кампании',
      metrics: { тираж: 3000, срок: '2 недели' }, result: 'Клиент успел запустить рекламную кампанию.', text: sourceA },
    { industry: 'спорт', client_type: 'спортивный клуб', task: 'Оформить подарочные наборы',
      metrics: { наборов: 48 }, result: 'Болельщики получили готовый мерч к матчу.', text: sourceB },
  ];
  const response = (cases: unknown[], hasMore = false, finishReason = 'stop') => ({
    data: { cases, has_more: hasMore }, tokensUsed: 40, costUsd: 0.001,
    promptTokens: 20, completionTokens: 20, rawResponse: { choices: [{ finish_reason: finishReason }] },
  });
  const request = (body: Record<string, unknown>) => postCases(new Request('https://portal.test/api/cases', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as NextRequest, { params: Promise.resolve({ id: 'project' }) });
  afterEach(() => jest.clearAllMocks());

  it('keeps separate engagements, their own numbers and the exact source fragment through the import', async () => {
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce(response([
      { ...drafts[0], text: sourceA.replace(/\s+/g, ' ') }, drafts[1],
    ]));
    const cases = await structureCaseTexts(raw);
    expect(cases).toEqual(drafts);
    expect(validateCaseDrafts(raw, cases)).toEqual(drafts);
    expect(jest.mocked(callLLMWithSchema).mock.calls[0][0].map((message) => message.content).join('\n')).toContain(raw);
    expect(cases[0].metrics).not.toHaveProperty('наборов');
    expect(cases[1].text).not.toContain('3000');
    mockCaseDb = createMockSupabase({ tables: { ve_projects: [{ id: 'project' }] } });
    jest.mocked(callLLMWithSchema).mockClear().mockResolvedValueOnce(response(drafts));
    const preview = await request({ mode: 'preview', text: raw });
    expect(preview.status).toBe(200);
    expect(mockCaseDb.inserts).toEqual([]);
    const selected = await preview.json();
    const saved = await request({ mode: 'save', text: raw, cases: selected.cases });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ count: 2, cases: drafts });
    expect(mockCaseDb.inserts).toHaveLength(1);
    expect(mockCaseDb.getRows('ve_cases')).toMatchObject(drafts);
    expect(callLLMWithSchema).toHaveBeenCalledTimes(1);
  });

  it('accepts no cases for generic text and rejects incomplete, invented or cross-case proof before saving', async () => {
    expect(validateCaseDrafts('Помогаем многим компаниям и всегда делаем качественно.', [])).toEqual([]);
    for (const invalid of [
      { ...drafts[0], task: '' },
      { ...drafts[0], text: 'Придуманный клиент получил рост продаж на 3000 процентов.' },
      { ...drafts[0], metrics: { тираж: 48 } },
      { ...drafts[0], metrics: { тираж: { вложенное: 3000 } } },
    ]) expect(() => validateCaseDrafts(raw, [invalid])).toThrow();
    expect(() => validateCaseDrafts(raw, [drafts[0], drafts[0]])).toThrow();
    mockCaseDb = createMockSupabase({ tables: { ve_projects: [{ id: 'project' }] } });
    for (const cases of [[], [{ ...drafts[0], metrics: { тираж: 48 } }]]) {
      expect((await request({ mode: 'save', text: raw, cases })).status).toBe(422);
    }
    expect(mockCaseDb.inserts).toEqual([]);
    expect(callLLMWithSchema).not.toHaveBeenCalled();
    // A syntactically repaired response must not look like a complete import.
    for (const incomplete of [
      response([drafts[0]], false, 'length'),
      response([drafts[0]], true),
      { ...response([drafts[0]]), rawResponse: { choices: [{ finish_reason: 'stop',
        message: { content: '{"has_more":false,"cases":[{"text":"unfinished' } }] } },
    ]) {
      jest.mocked(callLLMWithSchema).mockResolvedValueOnce(incomplete);
      expect((await request({ mode: 'preview', text: raw })).status).toBe(502);
    }
    expect(mockCaseDb.inserts).toEqual([]);
  });

  it('refreshes site cases without duplicates, preserving uploads and old rows on empty extraction or insert failure', async () => {
    const seed = [
      { ...drafts[0], id: 'kept', project_id: 'project', source: 'site', created_at: '2026-01-01' },
      { ...drafts[0], id: 'duplicate', project_id: 'project', source: 'site', created_at: '2026-01-02' },
      { ...drafts[0], id: 'stale', text: 'old text', project_id: 'project', source: 'site' },
      { ...drafts[0], id: 'upload', project_id: 'project', source: 'upload' },
      { ...drafts[0], id: 'other', project_id: 'other-project', source: 'site' },
    ];
    const db = createMockSupabase({ tables: { ve_cases: seed } });
    const refresh = (database = db, signal?: AbortSignal) => refreshSiteCases(
      { supabase: database, signal } as unknown as VeStageContext, 'project', 'https://client.test', raw,
      jest.fn(), 'ru', [],
    );
    jest.mocked(callLLMWithSchema).mockResolvedValue(response(drafts));
    await refresh();
    await refresh();
    expect(db.getRows('ve_cases').filter((row) => row.project_id === 'project' && row.source === 'site')
      .map((row) => row.text)).toEqual([sourceA, sourceB]);
    expect(db.inserts).toHaveLength(1);
    expect(db.getRows('ve_cases').map((row) => row.id)).toEqual(expect.arrayContaining(['kept', 'upload', 'other']));
    jest.mocked(callLLMWithSchema).mockResolvedValueOnce(response([]));
    const saved = db.getRows('ve_cases');
    await refresh();
    expect(db.getRows('ve_cases')).toEqual(saved);
    const failed = createMockSupabase({ tables: { ve_cases: seed },
      errorInserts: { ve_cases: { code: 'unavailable', message: 'storage unavailable' } } });
    await expect(refresh(failed)).rejects.toThrow('storage unavailable');
    expect(failed.getRows('ve_cases')).toEqual(seed);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(refresh(db, controller.signal)).rejects.toThrow('cancelled');
    expect(db.getRows('ve_cases')).toEqual(saved);
  });
});
