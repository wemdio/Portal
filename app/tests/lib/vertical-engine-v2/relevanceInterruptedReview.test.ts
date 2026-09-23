/** @jest-environment node */

/**
 * Прерванная контрольная проверка (аудит 22.09.2026, база f1bb9ccf
 * «Мясопереработка»). У 7 компаний DeepSeek ответил direct_match, а контрольную
 * проверку gpt-5-mini оборвала остановка воркера. Резерв этой попытки был
 * записан до запроса, и после возобновления attempts=2 выглядело как две
 * полученные попытки: компания уходила в карантин без повтора. Попыткой
 * считается только ответ или ошибка модели; обрыв возвращается один раз.
 */
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { resetVeTriageState } from '@/lib/verticalEngineV2/relevanceTriage';

// Гипотеза и цитата — настоящие, из разобранных баз прода.
const MEAT = { verticalName: 'Пищевые заводы', language: 'ru' as const,
  verticalSummary: 'Производители пищевой и кормовой продукции с рецептурами, партиями, сроками годности, ветсертификацией и поставками в сети.',
  hypothesisTitle: 'Мясопереработка',
  hypothesisDescription: 'Производители колбас, мясных полуфабрикатов, охлажденного мяса и деликатесов с Меркурием и сложной прослеживаемостью партий.' };
const QUOTE = 'Выпускаем колбасы, деликатесы и полуфабрикаты под брендом "Элита Юга". Используем только натуральное сырьё, без ГМО и соевых заменителей.';
const QUARANTINE = 'Смысловую проверку не удалось завершить после повторной попытки; контакт сохранён в резерве.';

const reply = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(),
  text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
const llm = (data: unknown) => reply({ choices: [{ message: { content: JSON.stringify(data) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });

/** Классификатор предлагает допуск по описанию, DeepSeek и gpt-5-mini подтверждают.
 * `stopConfirmation` обрывает запрос gpt-5-mini так, как его обрывает остановка воркера. */
function provider(stopConfirmation?: AbortController) {
  const calls = { classify: 0, deepseek: 0, confirm: 0 };
  global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content as string, user = (body.messages[1]?.content ?? '') as string;
    if (system.startsWith('Independently check')) {
      const companies = JSON.parse(user.split('index:\n')[1]) as Array<{ i: number }>;
      if (body.model === 'openai/gpt-5-mini') {
        calls.confirm += 1;
        if (stopConfirmation) {
          stopConfirmation.abort(new DOMException('worker stopped', 'AbortError'));
          throw stopConfirmation.signal.reason;
        }
      } else calls.deepseek += 1;
      return llm({ reviews: companies.map((item) => ({ i: item.i, result: 'direct_match', reason: 'Колбасы и деликатесы собственного выпуска' })) });
    }
    if (system.startsWith('Repair citations')) return llm({ evidence_ids: [] });
    calls.classify += 1;
    const batch = JSON.parse(user.split(/Rows, local indices [^\n]*:\n/)[1]) as Array<{ i: number; description: string }>;
    return llm({ decisions: batch.map((item) => ({ i: item.i, status: 'relevant', reason: 'Собственное производство колбас',
      evidence: [{ field: 'description', quote: item.description }] })) });
  }) as unknown as typeof fetch;
  return calls;
}
const offline = () => jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' });
const input = { ...MEAT, fetchEvidence: offline(), rows: [{ company: 'Элита Юга', inn: '2308000001', description: QUOTE }] };

/** Проход, оборванный на контрольной проверке: сохранённая точка — как в базе после остановки воркера. */
async function interruptedAt(checkpoint?: VeRelevanceCheckpoint): Promise<VeRelevanceCheckpoint> {
  const stop = new AbortController();
  provider(stop);
  let saved: VeRelevanceCheckpoint | undefined;
  await expect(findIrrelevantRows({ ...input, checkpoint, signal: stop.signal,
    onCheckpoint: async (value) => { saved = structuredClone(value); } })).rejects.toThrow();
  return saved!;
}
const review = (checkpoint: VeRelevanceCheckpoint) => Object.values(checkpoint.semantic_reviews)[0];

describe('VE2 прерванная контрольная проверка', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetVeTriageState();
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    delete process.env.VE_MODEL_GATE; delete process.env.VE_MODEL_RELEVANCE_REVIEW;
    delete process.env.VE_RELEVANCE_TRIAGE; delete process.env.VE_RELEVANCE_TRIAGE_PROJECTS;
  });
  afterEach(() => { process.env = { ...env }; });

  it('после остановки воркера повторяет контрольную проверку, а не отправляет компанию в карантин', async () => {
    const stopped = await interruptedAt();
    // Так лежит запись у f1bb9ccf: DeepSeek ответил direct_match, резерв второй попытки без ответа.
    expect(review(stopped)).toMatchObject({ status: 'started', attempts: 2, result: { result: 'direct_match' } });

    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: stopped });
    // Ни классификатора, ни DeepSeek заново: только оборванная контрольная проверка.
    expect(calls).toEqual({ classify: 0, deepseek: 0, confirm: 1 });
    expect(resumed.decisions.get(0)).toMatchObject({ status: 'relevant' });
    expect(review(resumed.checkpoint)).toMatchObject({ status: 'finished', attempts: 2, interrupted: true });
  });

  it('возвращает обрыв один раз: второй обрыв той же проверки ведёт в карантин без новых покупок', async () => {
    const twice = await interruptedAt(await interruptedAt());
    expect(review(twice)).toMatchObject({ status: 'started', attempts: 2, interrupted: true });
    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: twice });
    expect(calls).toEqual({ classify: 0, deepseek: 0, confirm: 0 });
    expect(resumed.decisions.get(0)).toMatchObject({ status: 'needs_review', reason: QUARANTINE });
  });

  it('снимает с карантина компанию, которую прежний resume закрыл после обрыва', async () => {
    // Прежний код переводил оборванный резерв в failed без кода ошибки и ставил карантин.
    const quarantined = await interruptedAt();
    Object.assign(review(quarantined), { status: 'failed' });
    const key = review(quarantined).company_key;
    quarantined.verdicts[key] = { ...quarantined.verdicts[key], status: 'needs_review', reason: QUARANTINE, website_review_version: 4 };

    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: quarantined });
    expect(calls).toEqual({ classify: 0, deepseek: 0, confirm: 1 });
    expect(resumed.decisions.get(0)).toMatchObject({ status: 'relevant' });
  });

  it('карантин по прежним правилам отбора разбирает разовая перепроверка правил, без второго возврата', async () => {
    // Так лежат 7 записей f1bb9ccf: без отметки правил. Их берёт перепроверка правил
    // (заново DeepSeek, затем контрольная модель); возврат обрыва сверху не добавляется.
    const legacy = await interruptedAt();
    Object.assign(review(legacy), { status: 'failed' });
    delete review(legacy).rules;
    const key = review(legacy).company_key;
    legacy.verdicts[key] = { ...legacy.verdicts[key], status: 'needs_review', reason: QUARANTINE, website_review_version: 4 };
    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: legacy });
    expect(calls).toEqual({ classify: 0, deepseek: 1, confirm: 1 });
    expect(resumed.decisions.get(0)).toMatchObject({ status: 'relevant' });
    expect(Object.values(resumed.checkpoint.semantic_reviews)).toEqual([expect.not.objectContaining({ interrupted: true })]);
  });

  it('ошибку модели по-прежнему считает попыткой', async () => {
    const stopped = await interruptedAt();
    // Полученная ошибка (битый ответ) записывается с кодом и не возвращается.
    Object.assign(review(stopped), { status: 'failed', failure_code: 'invalid_response' });
    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: stopped });
    expect(calls).toEqual({ classify: 0, deepseek: 0, confirm: 0 });
    expect(resumed.decisions.get(0)).toMatchObject({ status: 'needs_review', reason: QUARANTINE });
  });
});
