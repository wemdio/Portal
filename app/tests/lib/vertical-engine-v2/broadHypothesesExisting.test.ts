/** @jest-environment node */

/**
 * Широкие гипотезы в уже исследованном проекте (запрос владельца 23.09).
 * Широкие появлялись только при новом исследовании, а повторное исследование
 * у проекта с базами удаляет вертикали, а с ними базы, шаблоны и цепочки.
 * Отдельная задача broad_hypotheses только дописывает новые широкие и их
 * вертикали. Данные — проект «Велл Медиа» (wellmedmarketing.ru) с прода:
 * 12 вертикалей, базы у «Платных клиник», «Репродукции», «Диагностики» и
 * «Медицинских франшиз», широких нет.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const mockCallLLMWithSchema = jest.fn();
jest.mock('@/lib/verticalEngineV2/llm', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/llm'),
  callLLMWithSchema: (...args: unknown[]) => mockCallLLMWithSchema(...args),
}));

import { runVeStage } from '@/lib/verticalEngineV2/stages';
import { buildBroadHypothesesMessages } from '@/lib/verticalEngineV2/prompts/broadHypotheses';
import { buildBroadHypothesesMessagesEn } from '@/lib/verticalEngineV2/prompts/broadHypotheses.en';
import {
  BROAD_HYPOTHESES_RULES,
  HYPOTHESIS_FIELD_RULES,
  buildHypothesesInstantMessages,
  type HypothesesPromptInput,
} from '@/lib/verticalEngineV2/prompts/hypotheses';
import { BROAD_HYPOTHESES_RULES_EN, buildHypothesesInstantMessagesEn } from '@/lib/verticalEngineV2/prompts/hypotheses.en';
import { VeBroadHypothesesOnlySchema, VeHypothesesBatchSchema } from '@/lib/verticalEngineV2/schemas';
import { VE_BROAD_RESEARCH_BUSY_TEXT, selectNewBroadCandidates, veBroadTitleKey } from '@/lib/verticalEngineV2/broadHypotheses';
import {
  VE_BROAD_ADD_LABEL,
  VE_BROAD_FAILED_TEXT,
  VE_BROAD_RUNNING_LABEL,
  groupVeHypotheses,
  veBroadHypothesesAction,
} from '@/components/vertical-engine-v2/engine/hypothesisGroups';

const PROJECT = '8fe92ae8-d271-484e-af6c-288d20d6edaa';

const VERTICALS: Array<[string, number, string[]]> = [
  ['Платные клиники', 95, ['Сети частных клиник', 'Стоматологические клиники', 'Косметологии и эстетика', 'Офтальмохирургия']],
  ['Реабилитация и уход', 92, ['Санатории и реабилитация', 'Реабилитация зависимостей', 'Гериатрический медуход']],
  ['Репродукция и крио', 90, ['Центры ЭКО', 'Биобанки и крио']],
  ['Диагностика и лаборатории', 74, ['Диагностические центры', 'Медицинские лаборатории']],
  ['Аптечные сети', 67, ['Аптечные сети']],
  ['Медтуризм для клиник', 67, ['Медтуризм внутри РФ']],
  ['Телемедицина', 66, ['Телемедицинские сервисы']],
  ['Медтовары и фарма', 64, ['D2C медизделия', 'OTC-фарма бренды']],
  ['Медицинские франшизы', 60, ['Франшизы медклиник']],
  ['Домашняя медицина', 54, ['Домашняя медицина']],
  ['Корпоративные медпрограммы', 35, ['Корпоративные check-up']],
  ['Клинические исследования', 20, ['Набор в клинисследования']],
];

function seedTables(extraHypotheses: Row[] = []): Record<string, Row[]> {
  const verticals = VERTICALS.map(([name, pct, titles], i) => ({
    id: `vertical-${i + 1}`, project_id: PROJECT, name, summary: `${name}: сегменты частной медицины.`,
    synonyms: titles, potential_pct: pct, rank: i + 1,
  }));
  const hypotheses = VERTICALS.flatMap(([, pct, titles], i) => titles.map((title, n) => ({
    id: `hypothesis-${i + 1}-${n + 1}`, project_id: PROJECT, vertical_id: `vertical-${i + 1}`, tier: 2, title,
    description: `${title}. Боль — дорогой первичный пациент.`, fit_rationale: 'Собственник → поток пациентов → реклама дорожает → маркетинг под ключ → чек окупает канал.',
    evidence: [{ claim: 'Рынок растёт', source_url: 'https://example.test', quote: 'рост' }], seasonality: null,
    potential_pct: pct, status: i === 0 && n < 3 ? 'accepted' : 'proposed', broad: false,
  })));
  return {
    ve_projects: [{
      id: PROJECT, name: 'Велл Медиа', website_url: 'https://wellmedmarketing.ru/', status: 'researched', market: 'ru',
      brief: { site_profile: { company: 'Велл Медиа', offer: 'Маркетинг под ключ для частных клиник: сайт, реклама, SEO, колл-трекинг' } },
    }],
    ve_verticals: verticals,
    ve_hypotheses: [...hypotheses, ...extraHypotheses],
    ve_bases: [
      { id: 'base-1', project_id: PROJECT, vertical_id: 'vertical-1', hypothesis_id: 'hypothesis-1-1', status: 'analyzed', row_count: 512 },
      { id: 'base-2', project_id: PROJECT, vertical_id: 'vertical-4', hypothesis_id: 'hypothesis-4-2', status: 'collecting', row_count: 88 },
    ],
    ve_templates: [{ id: 'template-1', base_id: 'base-1', vertical_id: 'vertical-1', status: 'ready' }],
    ve_outreach_setups: [{ project_id: PROJECT, revision: 7, selected_hypothesis_ids: ['hypothesis-1-1', 'hypothesis-4-2'] }],
    ve_jobs: [
      { id: 'job-competitors', project_id: PROJECT, stage: 'competitors', status: 'done', created_at: '2026-09-10T10:00:00Z',
        result: { competitors: [{ name: 'Медмаркетинг', url: 'https://medmarketing.test', why: 'маркетинг клиник', geo: 'РФ' }] } },
      { id: 'job-brand', project_id: PROJECT, stage: 'brand_cloud', status: 'done', created_at: '2026-09-10T10:05:00Z',
        result: { entities: [{ name: 'Клиника «Мать и дитя»', classification: 'potential', potential_pct: 70, rationale: 'сеть клиник' }] } },
      { id: 'job-broad', project_id: PROJECT, stage: 'broad_hypotheses', status: 'running', payload: {}, created_at: '2026-09-23T09:00:00Z' },
    ],
  };
}

const chain = 'Собственник клиники → поток пациентов → реклама дорожает → маркетинг под ключ → чек лечения окупает канал.';
const sector = (title: string, pct = 60) => ({
  title, description: `${title}: все виды деятельности сектора. Общая боль — дорогой клиент.`, fit_rationale: chain,
  rationale: 'Десятки тысяч организаций.', potential_pct: pct, search_queries: [`${title} число организаций`],
});
// Ответ модели: новые секторы вперемешку с повторами того, что уже есть в проекте.
const MODEL_ANSWER = {
  broad_hypotheses: [
    sector('Частная медицина', 65),
    sector('Аптечные сети'), // название вертикали и гипотезы проекта
    sector('телемедицина '), // та же вертикаль в другом регистре
    sector('«Частная  медицина»'), // повтор внутри ответа
    sector('Ветеринария', 45),
    sector('Фитнес и велнес', 40),
  ],
};

function job(id = 'job-broad'): VeJob {
  return { id, project_id: PROJECT, stage: 'broad_hypotheses', status: 'running', payload: {}, result: null,
    attempts: 0, error: null, started_at: null, tokens_used: 0, cost_usd: 0, created_at: '', updated_at: '' };
}

function snapshot(db: MockSupabaseClient) {
  return Object.fromEntries(['ve_hypotheses', 've_verticals', 've_bases', 've_templates', 've_outreach_setups', 've_projects']
    .map((table) => [table, JSON.parse(JSON.stringify(db.getRows(table)))]));
}

// Unit adapter models only the RPC response/storage boundary. Transaction,
// rollback and database guards are exercised against real SQL below.
function broadDb(tables = seedTables(), options: { error?: string; loseReply?: boolean; afterCommit?: () => void } = {}) {
  return createMockSupabase({ tables, rpcHandlers: {
    ve_commit_broad_hypotheses: async (params, db) => {
      if (options.error) return { data: null, error: { message: options.error } };
      const added = [];
      for (const c of params.p_candidates as Row[]) {
        const verticalId = randomUUID();
        const hypothesisId = randomUUID();
        await db.from('ve_verticals').insert({ id: verticalId, project_id: PROJECT, name: c.title,
          summary: c.description, synonyms: [c.title], potential_pct: Math.min(95, Number(c.potential_pct)),
          rank: Math.max(db.getRows('ve_verticals').length, ...db.getRows('ve_verticals').map((v) => Number(v.rank ?? 0))) + 1 });
        await db.from('ve_hypotheses').insert({ id: hypothesisId, project_id: PROJECT, vertical_id: verticalId,
          tier: 1, title: c.title, description: c.description, fit_rationale: c.fit_rationale,
          evidence: [], seasonality: null, potential_pct: c.potential_pct, status: 'proposed', broad: true });
        added.push({ title: c.title, hypothesis_id: hypothesisId, vertical_id: verticalId });
      }
      const result = { broad_hypotheses_committed: true, added, duplicates: params.p_duplicates,
        requested: params.p_requested, tokensUsed: params.p_tokens_used, costUsd: params.p_cost_usd };
      await db.from('ve_jobs').update({ result }).eq('id', params.p_job_id);
      options.afterCommit?.();
      return options.loseReply ? { data: null, error: { message: 'response lost after commit' } } : { data: result };
    },
  } });
}

async function nextJob(db: MockSupabaseClient): Promise<VeJob> {
  const next = job(randomUUID());
  await db.from('ve_jobs').insert(next as unknown as Row);
  return next;
}

function llmReturns(data: unknown) {
  mockCallLLMWithSchema.mockImplementation(async (_messages: unknown, schema: { parse: (v: unknown) => unknown }) => ({
    data: schema.parse(data), tokensUsed: 1200, costUsd: 0.02, promptTokens: 900, completionTokens: 300,
  }));
}

beforeEach(() => {
  mockCallLLMWithSchema.mockReset();
  process.env.VE_MODEL_RESEARCH = 'test/research-model';
});
afterAll(() => { delete process.env.VE_MODEL_RESEARCH; });

describe('VE2 stage broad_hypotheses on an existing project', () => {
  it('adds only new broad hypotheses with their own verticals and leaves everything else untouched', async () => {
    const db = broadDb();
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);

    const out = await runVeStage(job(), { supabase: db as never, market: 'ru' });

    // Модели research показан основной список проекта.
    expect(mockCallLLMWithSchema).toHaveBeenCalledTimes(1);
    const [messages, schema, opts] = mockCallLLMWithSchema.mock.calls[0];
    expect(schema).toBe(VeBroadHypothesesOnlySchema);
    expect(opts).toMatchObject({ model: 'test/research-model', requireCompleteJson: true });
    const user = (messages as Array<{ content: string }>)[1].content;
    expect(user).toContain('- Платные клиники: Сети частных клиник; Стоматологические клиники');
    expect(user).toContain('- Аптечные сети: Аптечные сети');
    expect(user).toContain('до 5 НОВЫХ широких гипотез');
    expect(user).toContain('Маркетинг под ключ для частных клиник');
    expect(user).toContain('- Медмаркетинг (https://medmarketing.test, РФ) — маркетинг клиник');

    // Старое не тронуто: ни удалений, ни правок, выбор гипотез тот же.
    const after = snapshot(db);
    const added = (table: string) => after[table].filter((row: Row) => !before[table].some((old: Row) => old.id === row.id));
    for (const table of ['ve_bases', 've_templates', 've_outreach_setups', 've_projects']) expect(after[table]).toEqual(before[table]);
    expect(after.ve_hypotheses.filter((row: Row) => before.ve_hypotheses.some((old: Row) => old.id === row.id))).toEqual(before.ve_hypotheses);
    expect(after.ve_verticals.filter((row: Row) => before.ve_verticals.some((old: Row) => old.id === row.id))).toEqual(before.ve_verticals);
    expect(db.mutations.filter((m) => m.kind === 'delete' || m.kind === 'upsert')).toEqual([]);
    expect([...new Set(db.updates.map((u) => u.table))]).toEqual(['ve_jobs']);

    // Новые — только три настоящих новых сектора; каждая — своя вертикаль после существующих.
    const newVerticals = added('ve_verticals');
    const newHypotheses = added('ve_hypotheses');
    expect(newHypotheses.map((h: Row) => [h.title, h.broad, h.tier, h.status, h.potential_pct])).toEqual([
      ['Частная медицина', true, 1, 'proposed', 65], ['Ветеринария', true, 1, 'proposed', 45], ['Фитнес и велнес', true, 1, 'proposed', 40],
    ]);
    expect(newHypotheses.every((h: Row) => Array.isArray(h.evidence) && (h.evidence as unknown[]).length === 0 && h.seasonality === null)).toBe(true);
    expect(newVerticals.map((v: Row) => [v.name, v.rank, v.synonyms, v.potential_pct])).toEqual([
      ['Частная медицина', 13, ['Частная медицина'], 65], ['Ветеринария', 14, ['Ветеринария'], 45], ['Фитнес и велнес', 15, ['Фитнес и велнес'], 40],
    ]);
    expect(newHypotheses.map((h: Row) => h.vertical_id)).toEqual(newVerticals.map((v: Row) => v.id));
    expect(out.result).toMatchObject({ duplicates: ['Аптечные сети', 'телемедицина', '«Частная  медицина»'], requested: 5 });
    expect(out).toMatchObject({ tokensUsed: 1200, costUsd: 0.02 });

    // Интерфейс: блок широких сверху, узкие по вертикалям — как были.
    const groups = groupVeHypotheses(after.ve_verticals as never[], after.ve_hypotheses as never[]);
    expect(groups.broad.map((h: Row) => h.title)).toEqual(['Частная медицина', 'Ветеринария', 'Фитнес и велнес']);
    expect(groups.verticals.map((g) => (g.vertical as Row).name)).toEqual(VERTICALS.map(([name]) => name));
    expect(db.getRows('ve_jobs').find((j) => j.id === 'job-broad')?.progress).toEqual({ done: 3, total: 3, label: 'Добавлено широких гипотез: 3' });
  });

  it('a repeat after completion does not duplicate the same sectors, and a full project does not call the model', async () => {
    const db = broadDb();
    llmReturns(MODEL_ANSWER);
    await runVeStage(job(), { supabase: db as never, market: 'ru' });
    const afterFirst = snapshot(db);

    // Повторное нажатие: модель снова предлагает те же секторы.
    const secondJob = await nextJob(db);
    const repeat = await runVeStage(secondJob, { supabase: db as never, market: 'ru' });
    expect(snapshot(db)).toEqual(afterFirst);
    expect(repeat.result).toMatchObject({ added: [], requested: 2 });
    const user = (mockCallLLMWithSchema.mock.calls[1][0] as Array<{ content: string }>)[1].content;
    expect(user).toContain('ШИРОКИЕ — УЖЕ ЕСТЬ В ПРОЕКТЕ:\n- Частная медицина\n- Ветеринария\n- Фитнес и велнес');
    expect(user).toContain('до 2 НОВЫХ широких гипотез');
    expect(db.getRows('ve_jobs').find((j) => j.id === secondJob.id)?.progress)
      .toMatchObject({ done: 0, label: 'Новых секторов не нашлось: предложенные уже есть в проекте' });

    // Добор до предела: ещё два новых сектора — и больше модель не зовём.
    llmReturns({ broad_hypotheses: [sector('Стоматология'), sector('Косметология'), sector('Лишний сектор')] });
    await runVeStage(await nextJob(db), { supabase: db as never, market: 'ru' });
    expect(db.getRows('ve_hypotheses').filter((h) => h.broad === true).map((h) => h.title))
      .toEqual(['Частная медицина', 'Ветеринария', 'Фитнес и велнес', 'Стоматология', 'Косметология']);
    const calls = mockCallLLMWithSchema.mock.calls.length;
    const full = await runVeStage(await nextJob(db), { supabase: db as never, market: 'ru' });
    expect(mockCallLLMWithSchema.mock.calls.length).toBe(calls);
    expect(full).toMatchObject({ result: { added: [], reason: 'limit' }, tokensUsed: 0, costUsd: 0 });
  });

  it('fails on an RPC error without falling back to separate writes', async () => {
    const db = broadDb(seedTables(), { error: 'transaction rolled back' });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    await expect(runVeStage(job(), { supabase: db as never })).rejects.toThrow('transaction rolled back');
    expect(snapshot(db)).toEqual(before);
    expect(db.inserts).toEqual([]);
  });

  it('recovers a lost commit response without another model call, rows or lost usage', async () => {
    const db = broadDb(seedTables(), { loseReply: true });
    llmReturns(MODEL_ANSWER);
    await expect(runVeStage(job(), { supabase: db as never })).rejects.toThrow('response lost after commit');
    const afterCommit = snapshot(db);
    const recovered = await runVeStage(job(), { supabase: db as never });
    expect(snapshot(db)).toEqual(afterCommit);
    expect(mockCallLLMWithSchema).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls).toHaveLength(1);
    expect(recovered).toMatchObject({ tokensUsed: 1200, costUsd: 0.02,
      result: { added: expect.any(Array), requested: 5 } });
    expect((recovered.result as { added: unknown[] }).added).toHaveLength(3);
    const accounted = await runVeStage({ ...job(), tokens_used: 1200, cost_usd: 0.02 }, { supabase: db as never });
    expect(accounted).toMatchObject({ tokensUsed: 0, costUsd: 0 });
  });

  it('does not begin a cancelled commit and keeps an in-flight commit whole', async () => {
    const controller = new AbortController();
    const db = broadDb(seedTables(), { afterCommit: () => controller.abort() });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    await runVeStage(job(), { supabase: db as never, signal: controller.signal });
    const newVerticals = db.getRows('ve_verticals').filter((v) => !before.ve_verticals.some((old: Row) => old.id === v.id));
    const newHypotheses = db.getRows('ve_hypotheses').filter((h) => !before.ve_hypotheses.some((old: Row) => old.id === h.id));
    expect(newHypotheses).toHaveLength(3);
    expect(newVerticals.map((v) => v.id).sort()).toEqual(newHypotheses.map((h) => h.vertical_id).sort());
    const cancelled = broadDb();
    await expect(runVeStage(job(), { supabase: cancelled as never, signal: controller.signal })).rejects.toThrow();
    expect(cancelled.rpcCalls).toHaveLength(0);
  });

  it('retries malformed model output, permits an explicit empty result, and keeps full research lenient', async () => {
    const malformed = { broad_hypotheses: [{ title: 'Фармацевтика', description: 'Аптеки' }] };
    for (const value of [{ unrelated: true }, { broad_hypotheses: null }, malformed,
      { broad_hypotheses: [sector('   ')] }, { broad_hypotheses: [sector('!!!')] }]) {
      expect(VeBroadHypothesesOnlySchema.safeParse(value).success).toBe(false);
    }
    expect(VeHypothesesBatchSchema.parse({ ...malformed, hypotheses: [{ ...sector('Медицина'), tier: 1 }] }).broad_hypotheses).toEqual([]);
    const actual = jest.requireActual('@/lib/verticalEngineV2/llm') as typeof import('@/lib/verticalEngineV2/llm');
    const oldFetch = global.fetch;
    const oldKey = process.env.OPENROUTER_BRIEF_API_KEY;
    process.env.OPENROUTER_BRIEF_API_KEY = 'local-test';
    const responses = [malformed, { broad_hypotheses: [] }];
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock as typeof fetch;
    try {
      const result = await actual.callLLMWithSchema([{ role: 'user', content: 'Sectors' }], VeBroadHypothesesOnlySchema, { model: 'test/broad-schema' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.data.broad_hypotheses).toEqual([]);
      expect(result.tokensUsed).toBe(40);
    } finally {
      global.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.OPENROUTER_BRIEF_API_KEY;
      else process.env.OPENROUTER_BRIEF_API_KEY = oldKey;
    }
    const db = broadDb(seedTables(), { loseReply: true });
    llmReturns({ broad_hypotheses: [] });
    await expect(runVeStage(job(), { supabase: db as never })).rejects.toThrow('response lost');
    const recovered = await runVeStage(job(), { supabase: db as never });
    expect(recovered.result).toMatchObject({ broad_hypotheses_committed: true, added: [] });
    expect(mockCallLLMWithSchema).toHaveBeenCalledTimes(1);
  });

  it('adds nothing while the project is being researched', async () => {
    const tables = seedTables();
    const db = createMockSupabase({ tables: { ...tables, ve_projects: [{ ...tables.ve_projects[0], status: 'researching' }] } });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    const out = await runVeStage(job(), { supabase: db as never, market: 'ru' });
    expect(mockCallLLMWithSchema).not.toHaveBeenCalled();
    expect(snapshot(db)).toEqual(before);
    expect(out).toMatchObject({ result: { added: [], reason: 'research' }, tokensUsed: 0, costUsd: 0 });
    const progress = db.getRows('ve_jobs').find((j) => j.id === 'job-broad')?.progress as { done: number; label: string };
    expect(progress).toEqual({ done: 0, total: 0, label: VE_BROAD_RESEARCH_BUSY_TEXT });
    expect(veBroadHypothesesAction({ jobs: [{ stage: 'broad_hypotheses', status: 'done', progress }], hypotheses: [] }).note)
      .toBe(VE_BROAD_RESEARCH_BUSY_TEXT);
  });

  it('fails plainly for a project that was never researched', async () => {
    const tables = seedTables();
    const db = createMockSupabase({ tables: { ...tables, ve_verticals: [], ve_hypotheses: [] } });
    await expect(runVeStage(job(), { supabase: db as never, market: 'ru' })).rejects.toThrow('В проекте нет вертикалей');
    expect(mockCallLLMWithSchema).not.toHaveBeenCalled();
  });
});

describe('VE2 broad-only prompt reuses the broad rules of the full pass', () => {
  const input = {
    profile: { company: 'Велл Медиа' }, websiteUrl: 'https://wellmedmarketing.ru/', brandCloud: [], competitors: [],
  } as unknown as HypothesesPromptInput;

  it('asks only for the sector block and shows what the project already has (RU/EN)', () => {
    const payload = { ...input, count: 4, verticals: [{ name: 'Аптечные сети', hypotheses: ['Аптечные сети'] }], existingBroad: ['Частная медицина'] };
    const [system, user] = buildBroadHypothesesMessages(payload).map((m) => m.content);
    expect(system).toContain(BROAD_HYPOTHESES_RULES);
    expect(system).toContain(HYPOTHESIS_FIELD_RULES);
    expect(buildHypothesesInstantMessages(input)[0].content).toContain(BROAD_HYPOTHESES_RULES);
    expect(user).toContain('- Аптечные сети: Аптечные сети');
    expect(user).toContain('ШИРОКИЕ — УЖЕ ЕСТЬ В ПРОЕКТЕ:\n- Частная медицина');
    expect(user).toContain('до 4 НОВЫХ широких гипотез');
    expect(user).toContain('"broad_hypotheses": [');
    expect(user).not.toContain('"hypotheses": [');
    const [systemEn, userEn] = buildBroadHypothesesMessagesEn(payload).map((m) => m.content);
    expect(systemEn).toContain(BROAD_HYPOTHESES_RULES_EN);
    expect(buildHypothesesInstantMessagesEn(input)[0].content).toContain(BROAD_HYPOTHESES_RULES_EN);
    expect(userEn).toContain('up to 4 NEW sector-level broad hypotheses');
  });

  it('matches titles regardless of case, «ё», quotes and spacing', () => {
    expect(veBroadTitleKey('  «Телемедицина» ')).toBe(veBroadTitleKey('телемедицина'));
    expect(veBroadTitleKey('Медтовары и фарма')).toBe(veBroadTitleKey('медтовары  и ФАРМА'));
    expect(veBroadTitleKey('Учёт')).toBe(veBroadTitleKey('учет'));
    const parsed = VeBroadHypothesesOnlySchema.parse(MODEL_ANSWER).broad_hypotheses;
    const picked = selectNewBroadCandidates(parsed, ['Аптечные сети', 'Телемедицина'], 2);
    expect(picked.added.map((c) => [c.title, c.tier, c.broad])).toEqual([['Частная медицина', 1, true], ['Ветеринария', 1, true]]);
  });
});

describe('VE2 «Добавить широкие гипотезы» button state', () => {
  const broad = (status = 'proposed') => ({ broad: true, status });

  it('shows the running state while the task is queued or the request is in flight', () => {
    const running = veBroadHypothesesAction({ jobs: [{ stage: 'broad_hypotheses', status: 'pending' }], hypotheses: [] });
    expect(running).toMatchObject({ label: VE_BROAD_RUNNING_LABEL, disabled: true, running: true, error: null });
    expect(veBroadHypothesesAction({ jobs: [], hypotheses: [], requesting: true })).toMatchObject({ label: VE_BROAD_RUNNING_LABEL, disabled: true });
    expect(veBroadHypothesesAction({ jobs: [], hypotheses: [] })).toMatchObject({ label: VE_BROAD_ADD_LABEL, disabled: false, note: null });
  });

  it('reports only the latest task: a plain error after a failure, a note when nothing new was found', () => {
    const jobs = [
      { stage: 'base_collect', status: 'running' },
      { stage: 'broad_hypotheses', status: 'failed' },
      { stage: 'broad_hypotheses', status: 'done', progress: { done: 0, total: 0, label: 'старый итог' } },
    ];
    expect(veBroadHypothesesAction({ jobs, hypotheses: [] })).toMatchObject({ error: VE_BROAD_FAILED_TEXT, note: null, disabled: false });
    const nothing = [{ stage: 'broad_hypotheses', status: 'done', progress: { done: 0, total: 0, label: 'Новых секторов не нашлось: предложенные уже есть в проекте' } }];
    expect(veBroadHypothesesAction({ jobs: nothing, hypotheses: [] })).toMatchObject({ error: null, note: 'Новых секторов не нашлось: предложенные уже есть в проекте' });
    const addedSome = [{ stage: 'broad_hypotheses', status: 'done', progress: { done: 3, total: 3, label: 'Добавлено широких гипотез: 3' } }];
    expect(veBroadHypothesesAction({ jobs: addedSome, hypotheses: [] })).toMatchObject({ error: null, note: null });
  });

  it('is disabled at the limit of five active broad hypotheses and during research', () => {
    const full = veBroadHypothesesAction({ jobs: [], hypotheses: [broad(), broad('accepted'), broad(), broad(), broad(), { broad: false, status: 'proposed' }] });
    expect(full).toMatchObject({ disabled: true, note: 'В проекте уже 5 широких гипотез — это предел' });
    expect(veBroadHypothesesAction({ jobs: [], hypotheses: [broad(), broad(), broad(), broad(), broad('rejected')] }).disabled).toBe(false);
    expect(veBroadHypothesesAction({ jobs: [], hypotheses: [], researchRunning: true }).disabled).toBe(true);
  });
});

// Same opt-in runtime as the existing SQL smoke. Executes PostgreSQL itself.
const pgliteModule = process.env.PGLITE_MODULE ?? (() => {
  try { return require.resolve('@electric-sql/pglite'); } catch { return null; }
})();
(pgliteModule ? it : it.skip)('atomically appends sectors, rolls back failures and replays the original SQL receipt', () => {
  const script = String.raw`
    import { readFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    const { PGlite } = await import(process.env.PGLITE_MODULE);
    const db = new PGlite();
    const read = name => readFileSync(process.env.MIGRATIONS + '/' + name, 'utf8');
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec('create table public.ve_projects(id uuid primary key, status text not null);');
    const runtime = read('20260821_0001_vertical_engine_v2_runtime.sql');
    await db.exec(runtime.slice(runtime.indexOf('create table if not exists public.ve_jobs'), runtime.indexOf('-- ─── ve_chains')));
    await db.exec(read('20260828_0002_vertical_engine_v2_ru_seasonality.sql'));
    await db.exec(read('20260923_0001_ve_hypotheses_broad.sql'));
    await db.exec(read('20260923_0003_ve_jobs_broad_hypotheses_stage.sql'));
    const migration = read('20260924_0012_ve_broad_hypotheses_atomic.sql');
    await db.exec(migration);
    await db.exec(migration);
    const project = randomUUID(), existing = randomUUID(), job = randomUUID();
    await db.query("insert into ve_projects values ($1, 'researched')", [project]);
    await db.query("insert into ve_verticals(id,project_id,name,synonyms,rank) values ($1,$2,'Узкая','[\"Учёт\"]',7)", [existing,project]);
    await db.query("insert into ve_jobs(id,project_id,stage,status) values ($1,$2,'broad_hypotheses','running')", [job,project]);
    const candidate = (title, pct = 60) => ({title, description:'Описание', fit_rationale:'Причина', potential_pct:pct});
    const invoke = async (items, id = job, pid = project, requested = 5) => (await db.query(
      'select public.ve_commit_broad_hypotheses($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7) as receipt',
      [id,pid,JSON.stringify(items),'[]',requested,1200,0.02])).rows[0].receipt;
    const snapshot = async () => Promise.all(['ve_verticals','ve_hypotheses','ve_jobs'].map(async table =>
      (await db.query('select * from ' + table + ' order by id')).rows));
    const before = await snapshot();
    await db.exec("alter table ve_hypotheses add constraint injected_failure check (title <> 'Сбой');");
    await assert.rejects(invoke([candidate('Медицина'),candidate('Сбой')]), /injected_failure/);
    assert.deepEqual(await snapshot(), before);
    await db.exec('alter table ve_hypotheses drop constraint injected_failure;');
    await assert.rejects(invoke([candidate('Медицина'),candidate('Сбой',101)]), /Invalid broad/);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(invoke([candidate('Медицина')],job,randomUUID()), /does not belong/);
    await db.query("update ve_jobs set status='cancelled' where id=$1",[job]);
    await assert.rejects(invoke([candidate('Медицина')]), /not running/);
    await db.query("update ve_jobs set status='running' where id=$1",[job]);
    await db.query("update ve_projects set status='researching' where id=$1",[project]);
    await assert.rejects(invoke([candidate('Медицина')]), /research is running/);
    await db.query("update ve_projects set status='researched' where id=$1",[project]);
    await db.exec('set role authenticated;');
    await assert.rejects(invoke([candidate('Медицина')]), /permission denied/);
    await db.exec('reset role; set role service_role;');
    const receipt = await invoke([candidate(' «УЧЕТ» '),candidate('Медицина',100),candidate('медицина'),candidate('Ветеринария')]);
    assert.equal(receipt.added.length,2);
    assert.deepEqual(receipt.duplicates,['«УЧЕТ»','медицина']);
    assert.equal(receipt.tokensUsed,1200);
    assert.equal(receipt.costUsd,0.02);
    await db.exec('reset role;');
    const committed = await snapshot();
    assert.deepEqual(await invoke([candidate('Другой сектор')]),receipt);
    assert.deepEqual(await snapshot(),committed);
    const verticals = (await db.query('select * from ve_verticals where id <> $1 order by rank',[existing])).rows;
    assert.deepEqual(verticals.map(v => [v.rank,v.potential_pct]),[[8,95],[9,60]]);
    assert.deepEqual((await db.query('select vertical_id from ve_hypotheses')).rows.map(h => h.vertical_id).sort(),receipt.added.map(h=>h.vertical_id).sort());
    await db.query("update ve_jobs set status='done' where id=$1",[job]);
    const next = randomUUID();
    await db.query("insert into ve_jobs(id,project_id,stage,status) values ($1,$2,'broad_hypotheses','running')",[next,project]);
    const capped = await invoke(['A','B','C','D','E'].map(t=>candidate(t)),next);
    assert.equal(capped.added.length,3);
    assert.equal((await db.query('select count(*)::int as n from ve_hypotheses where broad')).rows[0].n,5);
    await db.query("update ve_jobs set status='done' where id=$1",[next]);
    const empty = randomUUID();
    await db.query("insert into ve_jobs(id,project_id,stage,status) values ($1,$2,'broad_hypotheses','running')",[empty,project]);
    const emptyReceipt = await invoke([],empty);
    assert.deepEqual(emptyReceipt.added,[]);
    assert.deepEqual(await invoke([candidate('F')],empty),emptyReceipt);
    await db.close();
    console.log('PASS atomic broad hypotheses');
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PGLITE_MODULE: pgliteModule ?? '', MIGRATIONS: path.resolve(__dirname, '../../../../supabase/migrations') },
    encoding: 'utf8', timeout: 15_000,
  });
  expect(output).toContain('PASS atomic broad hypotheses');
});
