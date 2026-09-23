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
import { VeBroadHypothesesOnlySchema } from '@/lib/verticalEngineV2/schemas';
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
    { title: 'Фармацевтика', description: 'Аптеки и дистрибьюторы.' }, // неполная — отбрасывается разбором
    sector('Ветеринария', 45),
    sector('Фитнес и велнес', 40),
  ],
};

function job(): VeJob {
  return { id: 'job-broad', project_id: PROJECT, stage: 'broad_hypotheses', status: 'running', payload: {}, result: null,
    attempts: 0, error: null, started_at: null, tokens_used: 0, cost_usd: 0, created_at: '', updated_at: '' };
}

function snapshot(db: MockSupabaseClient) {
  return Object.fromEntries(['ve_hypotheses', 've_verticals', 've_bases', 've_templates', 've_outreach_setups', 've_projects']
    .map((table) => [table, JSON.parse(JSON.stringify(db.getRows(table)))]));
}

/**
 * Перехват вставок в таблицу: hook видит строки вставки и может вернуть
 * ошибку базы (тогда ничего не пишется). Остальные запросы — как есть.
 */
function withInsertHook(
  db: MockSupabaseClient,
  table: string,
  hook: (rows: Row[]) => { code: string; message: string } | null,
): MockSupabaseClient {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const builder = target.from(name);
        if (name !== table) return builder;
        const insert = builder.insert.bind(builder);
        builder.insert = (rows: Row | Row[]) => {
          const error = hook(Array.isArray(rows) ? rows : [rows]);
          if (!error) return insert(rows);
          const failed = { data: null, error };
          const chain = {
            select: () => chain,
            single: async () => failed,
            then: (resolve: (v: typeof failed) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(failed).then(resolve, reject),
          };
          return chain as never;
        };
        return builder;
      };
    },
  });
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
    const db = createMockSupabase({ tables: seedTables() });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);

    const out = await runVeStage(job(), { supabase: db as never, market: 'ru' });

    // Один вызов модели стадии hypotheses; модели показан основной список проекта.
    expect(mockCallLLMWithSchema).toHaveBeenCalledTimes(1);
    const [messages, schema, opts] = mockCallLLMWithSchema.mock.calls[0];
    expect(schema).toBe(VeBroadHypothesesOnlySchema);
    expect(opts).toMatchObject({ model: 'test/research-model' });
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
    const db = createMockSupabase({ tables: seedTables() });
    llmReturns(MODEL_ANSWER);
    await runVeStage(job(), { supabase: db as never, market: 'ru' });
    const afterFirst = snapshot(db);

    // Повторное нажатие: модель снова предлагает те же секторы.
    const repeat = await runVeStage(job(), { supabase: db as never, market: 'ru' });
    expect(snapshot(db)).toEqual(afterFirst);
    expect(repeat.result).toMatchObject({ added: [], requested: 2 });
    const user = (mockCallLLMWithSchema.mock.calls[1][0] as Array<{ content: string }>)[1].content;
    expect(user).toContain('ШИРОКИЕ — УЖЕ ЕСТЬ В ПРОЕКТЕ:\n- Частная медицина\n- Ветеринария\n- Фитнес и велнес');
    expect(user).toContain('до 2 НОВЫХ широких гипотез');
    expect(db.getRows('ve_jobs').find((j) => j.id === 'job-broad')?.progress)
      .toMatchObject({ done: 0, label: 'Новых секторов не нашлось: предложенные уже есть в проекте' });

    // Добор до предела: ещё два новых сектора — и больше модель не зовём.
    llmReturns({ broad_hypotheses: [sector('Стоматология'), sector('Косметология'), sector('Лишний сектор')] });
    await runVeStage(job(), { supabase: db as never, market: 'ru' });
    expect(db.getRows('ve_hypotheses').filter((h) => h.broad === true).map((h) => h.title))
      .toEqual(['Частная медицина', 'Ветеринария', 'Фитнес и велнес', 'Стоматология', 'Косметология']);
    const calls = mockCallLLMWithSchema.mock.calls.length;
    const full = await runVeStage(job(), { supabase: db as never, market: 'ru' });
    expect(mockCallLLMWithSchema.mock.calls.length).toBe(calls);
    expect(full).toMatchObject({ result: { added: [], reason: 'limit' }, tokensUsed: 0, costUsd: 0 });
  });

  it('removes its fresh verticals when the hypothesis insert fails and does not touch existing rows', async () => {
    const db = createMockSupabase({
      tables: seedTables(),
      errorInserts: { ve_hypotheses: { code: '23514', message: 'new row violates check constraint' } },
    });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    await expect(runVeStage(job(), { supabase: db as never, market: 'ru' })).rejects.toThrow('ve_hypotheses insert');
    expect(snapshot(db)).toEqual(before);
  });

  it('leaves no part of the sectors behind when writing fails after the first one', async () => {
    const db = createMockSupabase({ tables: seedTables() });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    // Сбой базы на записи второго сектора: первый уже мог лечь.
    let rows = 0;
    const flaky = withInsertHook(db, 've_hypotheses', (payload) => {
      rows += payload.length;
      return rows > 1 ? { code: '57014', message: 'canceling statement due to statement timeout' } : null;
    });
    await expect(runVeStage(job(), { supabase: flaky as never, market: 'ru' })).rejects.toThrow('ve_hypotheses insert');
    expect(snapshot(db)).toEqual(before);
  });

  it('a cancel arriving while writing does not leave a part of the sectors', async () => {
    const db = createMockSupabase({ tables: seedTables() });
    const before = snapshot(db);
    llmReturns(MODEL_ANSWER);
    const controller = new AbortController();
    const cancelled = withInsertHook(db, 've_verticals', () => { controller.abort(); return null; });
    await runVeStage(job(), { supabase: cancelled as never, market: 'ru', signal: controller.signal }).catch(() => undefined);
    const newVerticals = db.getRows('ve_verticals').filter((v) => !before.ve_verticals.some((old: Row) => old.id === v.id));
    const newHypotheses = db.getRows('ve_hypotheses').filter((h) => !before.ve_hypotheses.some((old: Row) => old.id === h.id));
    // Всё или ничего: каждая новая вертикаль — со своей широкой гипотезой.
    expect([0, 3]).toContain(newHypotheses.length);
    expect(newVerticals.map((v) => v.id).sort()).toEqual(newHypotheses.map((h) => h.vertical_id).sort());
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
