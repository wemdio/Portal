/** @jest-environment node */

/**
 * Calibrated triage in front of the LLM relevance check (opt-in). Both paths go
 * to Requesty, so the fetch double routes on the request itself: a body with
 * `response_format.type === 'questions'` is the classifier and answers
 * probabilities, everything else is an ordinary LLM prompt.
 */
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { buildVeRelevanceReviewBatch } from '@/lib/verticalEngineV2/relevanceReserve';
import { decideVeTriage, resetVeTriageState, selectVeTriageEvidence, triageVeCompanies, type VeTriageRubric } from '@/lib/verticalEngineV2/relevanceTriage';
import { isVeRelevanceTriageEnabled } from '@/lib/verticalEngineV2/relevanceTriageConfig';
import { withProviderUsage, type ProviderUsageEvent } from '@/lib/providerUsage';

const rubric: VeTriageRubric = {
  activity: 'The company itself manufactures industrial pumping equipment.',
  requirements: ['The company has its own production site.'],
  conflicts: ['The company only resells equipment made by others.'],
  adjacent: ['pump repair'], activity_label: 'производство насосного оборудования', conflict_labels: ['перепродажа чужого оборудования'],
};
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(),
  text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
const llm = (data: unknown) => reply(200, { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });
/**
 * Jev answers through the chat contract: the probabilities are the message
 * content. The real router tags every answer with its question type and bills
 * ~18 output tokens per answer, so the double does too.
 */
const jev = (answers: Record<string, Record<string, unknown>>, promptTokens: number) => reply(200, { model: 'jev-1.13.0',
  choices: [{ message: { content: JSON.stringify(Object.fromEntries(Object.entries(answers)
    .map(([key, value]) => [key, { ...value, type: 'probabilities' in value ? 'choice' : 'noul' }]))) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: promptTokens, completion_tokens: 18 * Object.keys(answers).length,
    cost: promptTokens * 0.042 / 1e6 } });

const maker = 'Завод выпускает промышленные насосы на собственной производственной площадке в Туле.';
const rows = [
  { company: 'Насосный завод', inn: '7700000001', description: maker },
  { company: 'Торговый дом', inn: '7700000002', description: 'Оптовая перепродажа импортного оборудования разных марок.' },
  { company: 'Сервис-центр', inn: '7700000003', description: 'Обслуживание и ремонт инженерных систем зданий.' },
];
const input = { rows, verticalName: 'Промышленное оборудование', hypothesisTitle: 'Производители насосов', language: 'ru' as const, triage: true,
  fetchEvidence: jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' }) };

/** Probabilities by company name; `down` makes the triage provider refuse the key. */
function provider(options: { down?: boolean; classifyStatus?: number; brokenRubric?: boolean; rubricStatus?: number; triageStatus?: number } = {}) {
  const calls = { rubric: 0, classify: 0, review: 0, company: 0, evidence: 0 };
  const fetchMock = jest.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const questions = body.response_format?.type === 'questions' ? body.response_format.questions : null;
    if (questions) {
      if (options.down) return reply(401, { error: 'invalid key' });
      if (options.triageStatus) { calls.company += 1; return reply(options.triageStatus, { error: { message: 'insufficient balance' } }); }
      const state = JSON.parse(body.messages[0].content);
      if (questions.activity) {
        calls.company += 1;
        const name = state.company_facts_untrusted_data.company as string;
        const p = name === 'Насосный завод' ? { activity: 0.9, req_0: 0.8, conflict_0: 0.02, irrelevant: 0.01 }
          : name === 'Торговый дом' ? { activity: 0.01, req_0: 0.02, conflict_0: 0.9, irrelevant: 0.9 }
            : { activity: 0.2, req_0: 0.1, conflict_0: 0.1, irrelevant: 0.2 };
        return jev({
          activity: { noul: p.activity }, req_0: { noul: p.req_0 }, conflict_0: { noul: p.conflict_0 }, serves_target_not_member: { noul: 0.05 },
          fit: { choice: 'x', probabilities: { relevant: 1 - p.irrelevant, irrelevant: p.irrelevant, insufficient: 0 } } }, 1000);
      }
      calls.evidence += 1;
      return jev(Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key.endsWith('0') ? 0.8 : 0.1 }])), 500);
    }
    const system = body.messages[0].content as string;
    if (system.startsWith('You convert ONE B2B targeting hypothesis')) {
      calls.rubric += 1;
      return options.rubricStatus ? reply(options.rubricStatus, {}) : llm(options.brokenRubric ? { activity: 'x' } : rubric);
    }
    if (system.startsWith('Independently check')) {
      calls.review += 1;
      return llm({ reviews: JSON.parse(body.messages[1].content.split('index:\n')[1]).map((item: { i: number }) => ({ i: item.i, result: 'direct_match', reason: 'Производит насосы' })) });
    }
    calls.classify += 1;
    if (options.classifyStatus) return reply(options.classifyStatus, {});
    const batch = JSON.parse(body.messages[1].content.split(':\n').at(-1)!) as Array<{ i: number }>;
    return llm({ decisions: batch.map((item) => ({ i: item.i, status: 'needs_review', reason: 'Недостаточно сведений', evidence: [] })) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe('VE2 calibrated relevance triage', () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetVeTriageState();
    process.env.VE_RELEVANCE_TRIAGE = 'jev';
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    delete process.env.VE_RELEVANCE_TRIAGE_PROJECTS; delete process.env.VE_MODEL_GATE; delete process.env.VE_MODEL_RELEVANCE_REVIEW;
  });
  afterEach(() => { process.env = { ...env }; });

  it('is off unless the mode and (when listed) the project are configured', () => {
    expect(isVeRelevanceTriageEnabled('p1')).toBe(true);
    process.env.VE_RELEVANCE_TRIAGE_PROJECTS = 'p2, p3';
    expect(isVeRelevanceTriageEnabled('p1')).toBe(false);
    expect(isVeRelevanceTriageEnabled('p3')).toBe(true);
    delete process.env.VE_RELEVANCE_TRIAGE;
    expect(isVeRelevanceTriageEnabled('p3')).toBe(false);
  });

  it('never decides on missing answers and keeps explicit requirements in the evidence', () => {
    const answer = (values: Record<string, number>, irrelevant = 0) => ({ ...Object.fromEntries(Object.entries(values).map(([key, noul]) => [key, { noul }])),
      fit: { probabilities: { irrelevant } } });
    expect(decideVeTriage(answer({ req_0: 0.9 }), rubric)).toBeNull();
    expect(decideVeTriage(answer({ activity: 0.9 }), rubric)?.outcome).toBe('uncertain'); // requirement unanswered
    expect(decideVeTriage(answer({ activity: 0.9, req_0: 0.5, conflict_0: 0.7 }), rubric)?.outcome).toBe('uncertain');
    expect(decideVeTriage(answer({ activity: 0.9, req_0: 0.5, conflict_0: 0.1 }), rubric)?.outcome).toBe('admit');
    expect(decideVeTriage(answer({ activity: 0.04, conflict_0: 0.1 }), rubric)?.outcome).toBe('uncertain'); // omission is not a conflict
    expect(decideVeTriage(answer({ activity: 0.04, conflict_0: 0.5 }), rubric)).toEqual({ outcome: 'reject', activity: 0.04, conflict: 0 });
    expect(decideVeTriage(answer({ activity: 0.04, conflict_0: 0.1 }, 0.7), rubric)).toEqual({ outcome: 'reject', activity: 0.04, conflict: null });
    const excerpts = [0, 1, 2, 3].map((id) => ({ id, field: 'website_text', quote: 'q' + id }));
    const scores = answer({ e0: 0.4, e1: 0.9, e2: 0.2, e3: 0.5, r0_2: 0.7, r0_1: 0.95 });
    expect(selectVeTriageEvidence(excerpts, scores, rubric)).toEqual([1, 2, 3]);
    expect(selectVeTriageEvidence(excerpts, answer({ e0: 0.29, r0_0: 0.9 }), rubric)).toEqual([]);
  });

  it('rejects without LLM spend, proposes with verbatim excerpts and leaves the rest to the LLM path', async () => {
    const calls = provider();
    const journal: ProviderUsageEvent[] = [];
    let saved: VeRelevanceCheckpoint | undefined;
    const checked = await withProviderUsage({ projectId: 'p', jobId: 'j', stage: 'base_collect' }, async (_scope, event) => { journal.push(event); },
      () => findIrrelevantRows({ ...input, onCheckpoint: async (checkpoint) => { saved = JSON.parse(JSON.stringify(checkpoint)) as VeRelevanceCheckpoint; } }));
    expect(checked.error).toBeUndefined();
    expect([0, 1, 2].map((i) => checked.decisions.get(i)?.status)).toEqual(['relevant', 'irrelevant', 'needs_review']);
    // The admission was confirmed by the unchanged semantic review on verbatim text.
    expect(checked.decisions.get(0)).toEqual(expect.objectContaining({ evidence: [{ field: 'description', quote: maker }],
      triage: { outcome: 'admit', activity: 0.9 }, triage_version: 1 }));
    expect(checked.decisions.get(1)).toEqual(expect.objectContaining({ evidence: [], triage: { outcome: 'reject', activity: 0.01, final: true },
      reason: expect.stringContaining('перепродажа чужого оборудования') }));
    expect(checked.decisions.get(2)).toEqual(expect.objectContaining({ triage_version: 1 }));
    expect(checked.decisions.get(2)?.triage).toBeUndefined();
    // Счёт нерешённой компании сохранён: по нему потом решается, стоит ли
    // покупать ей платный поиск сайта. Решённые в этот список не попадают.
    expect(Object.values(saved?.triage_activity ?? {})).toEqual([0.2]);
    // One checklist, one LLM classification for the single uncertain company, two review steps for the single proposal.
    expect(calls).toEqual({ rubric: 1, classify: 1, review: 2, company: 3, evidence: 1 });
    // Every classifier request is journalled and priced by the shared layer.
    const triageEvents = journal.filter((event) => event.requestedModel === 'typesafe/jev-1.13.0' && event.phase === 'finished');
    expect(triageEvents).toHaveLength(4);
    expect(triageEvents.every((event) => event.provider === 'requesty' && event.status === 'success')).toBe(true);
    expect(triageEvents.reduce((sum, event) => sum + (event.promptTokens ?? 0), 0)).toBe(3500);
    expect(triageEvents.reduce((sum, event) => sum + (event.reportedCostUsd ?? 0), 0)).toBeCloseTo(3500 * 0.042 / 1e6, 12);
    expect(checked.tokensUsed).toBeGreaterThanOrEqual(3500);

    // Everything is durable: a replay buys nothing, including for the final reject.
    const before = { ...calls };
    const replay = await findIrrelevantRows({ ...input, checkpoint: saved });
    expect([0, 1, 2].map((i) => replay.decisions.get(i)?.status)).toEqual(['relevant', 'irrelevant', 'needs_review']);
    expect(calls).toEqual(before);
    // Toggling the triage off keeps the saved verdicts (the context hash is unchanged).
    const off = await findIrrelevantRows({ ...input, triage: false, checkpoint: saved });
    expect([0, 1, 2].map((i) => off.decisions.get(i)?.status)).toEqual(['relevant', 'irrelevant', 'needs_review']);
    expect(calls).toEqual(before);
  });

  it('falls back to the LLM path when the provider refuses, then reads that saved reserve once it is back', async () => {
    const down = provider({ down: true });
    const fallback = await findIrrelevantRows(input);
    expect(fallback.error).toBeUndefined();
    expect([0, 1, 2].map((i) => fallback.decisions.get(i)?.status)).toEqual(['needs_review', 'needs_review', 'needs_review']);
    expect(down.classify).toBe(1);
    // Not seen by the triage: no marker, so the saved-review selector returns these rows later.
    expect([0, 1, 2].map((i) => fallback.decisions.get(i)?.triage_version)).toEqual([undefined, undefined, undefined]);
    const reserve = rows.map((row, i) => ({ ...row, email: `a${i}@example.com`, _email_status: 'ok',
      _ve_relevance: { ...fallback.decisions.get(i)!, website_review_version: 4 } }));
    const select = (triage: boolean) => buildVeRelevanceReviewBatch({ reserve, ready: [], source: [], automatic: true, triage }).companies;
    expect(select(false)).toBe(0);
    expect(select(true)).toBe(3);

    resetVeTriageState();
    const calls = provider();
    // A saved deferred search assumes the company is still uncertain. Companies
    // the triage settles must not buy that search or be overwritten by its result.
    const checkpoint = JSON.parse(JSON.stringify(fallback.checkpoint)) as VeRelevanceCheckpoint;
    for (const key of Object.keys(checkpoint.verdicts)) checkpoint.website_evidence[key] = { reader_version: 1, reader_revision: 4,
      status: 'unavailable', text: '', url: '', reason: 'paid_search_deferred', search_deferred: true,
      review_attempt: 'a'.repeat(64), review_attempts: 0, refined: true };
    const fetchEvidence = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' });
    const resumed = await findIrrelevantRows({ ...input, fetchEvidence, checkpoint });
    expect([0, 1, 2].map((i) => resumed.decisions.get(i)?.status)).toEqual(['relevant', 'irrelevant', 'needs_review']);
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
    expect(fetchEvidence.mock.calls[0][1]).toEqual(expect.objectContaining({ companyName: 'Сервис-центр' }));
    // The saved reserve needed no new LLM classification and reused the paid checklist: only the proposal's review.
    expect(down.rubric).toBe(1);
    expect(calls).toEqual({ rubric: 0, classify: 0, review: 2, company: 3, evidence: 1 });
    const stamped = rows.map((row, i) => ({ ...row, email: `a${i}@example.com`, _email_status: 'ok',
      _ve_relevance: { ...resumed.decisions.get(i)!, website_review_version: 4 } }));
    expect(buildVeRelevanceReviewBatch({ reserve: stamped, ready: [], source: [], automatic: true, triage: true }).companies).toBe(0);
  });

  it('does not buy the same fast check again after a stopped pass, and gives up on a checklist that cannot be built', async () => {
    // The LLM path stops (no funds) after the fast check has read all three companies.
    const stopped = provider({ classifyStatus: 402 });
    const first = await findIrrelevantRows(input);
    expect(first.error).toContain('Requesty 402');
    expect(stopped.company).toBe(3);
    expect(Object.values(first.checkpoint.triage_seen?.keys ?? {})).toEqual([1]);
    const calls = provider();
    const resumed = await findIrrelevantRows({ ...input, checkpoint: first.checkpoint });
    expect([0, 1, 2].map((i) => resumed.decisions.get(i)?.status)).toEqual(['relevant', 'irrelevant', 'needs_review']);
    // Reject and proposal were saved; the undecided company goes straight to the LLM.
    expect(calls).toEqual({ rubric: 0, classify: 1, review: 2, company: 0, evidence: 0 });
    expect(resumed.decisions.get(2)?.triage_version).toBe(1);
    expect(resumed.checkpoint.triage_seen?.keys).toEqual({});

    // A checklist that keeps failing is a paid call to the strongest model: two tries, then the LLM path only.
    const broken = provider({ brokenRubric: true });
    let checkpoint: VeRelevanceCheckpoint | undefined;
    for (let pass = 0; pass < 3; pass++) {
      const result = await findIrrelevantRows({ ...input, rows: [{ ...rows[2], inn: '770000010' + pass }], checkpoint });
      expect(result.decisions.get(0)?.status).toBe('needs_review');
      checkpoint = result.checkpoint;
    }
    expect(broken.rubric).toBe(2);
    expect(broken.company).toBe(0);

    // A balance refusal describes the provider at that moment, not the checklist:
    // it is never counted, and the fast check returns with the provider.
    const refused = provider({ rubricStatus: 402 });
    let unpaid: VeRelevanceCheckpoint | undefined;
    for (let pass = 0; pass < 3; pass++) unpaid = (await findIrrelevantRows({ ...input, rows: [{ ...rows[2], inn: '770000020' + pass }], checkpoint: unpaid })).checkpoint;
    expect(refused.rubric).toBe(3);
    expect(unpaid?.triage_rubric_failures).toBeUndefined();
    const restored = provider();
    await findIrrelevantRows({ ...input, rows: [{ ...rows[2], inn: '7700000209' }], checkpoint: unpaid });
    expect(restored).toEqual(expect.objectContaining({ rubric: 1, company: 1 }));
  });

  it('never throws the balance refusal past the gate, so the paid pass keeps its checkpoint', async () => {
    // Both paths hit an empty balance. `runTriage` has no handler of its own:
    // an escaping error would skip the gate's save and lose the whole pass.
    const broke = provider({ triageStatus: 402, classifyStatus: 402 });
    // More companies than concurrency slots, so some wait for a slot: those must
    // never reach the provider once the first refusal has arrived.
    const many = Array.from({ length: 12 }, (_, i) => ({ company: 'Завод ' + i, inn: '77000001' + String(i).padStart(2, '0'), description: maker }));
    const stopped = await findIrrelevantRows({ ...input, rows: many });
    expect(stopped.error).toContain('Requesty 402');
    expect(stopped.checkpoint).toBeDefined();
    // Nobody is settled on a refusal: every company stays for the next pass.
    expect(many.map((_, i) => stopped.decisions.get(i)?.status).filter((status) => status === 'relevant' || status === 'irrelevant')).toEqual([]);
    // Only the first wave of slots reaches the provider; the queued companies are
    // released by the refusal itself and buy nothing.
    expect(broke.company).toBeLessThanOrEqual(6);
    expect(broke.company).toBeLessThan(many.length);

    // With funds only for the LLM path the pass still completes, without the fast check.
    resetVeTriageState();
    const partial = provider({ triageStatus: 402 });
    const done = await findIrrelevantRows(input);
    expect(done.error).toBeUndefined();
    expect(partial.classify).toBe(1);
  });

  it('treats an answered but unreadable response as a bad answer, not as a dead provider', async () => {
    const target = { vertical: 'v', verticalSummary: '', hypothesisTitle: 'h', hypothesisDescription: '' };
    const facts = { company: 'c', website: '', category: '', description: maker, vacancy_title: '', website_text: '' };
    const packet = (size: number) => ({ rubric, language: 'ru' as const, target, companies: Array.from({ length: size }, () => ({ facts, excerpts: [] })) });

    // HTTP 200 with a body that is not the answer object at all.
    const garbage = jest.fn(async () => reply(200, { model: 'jev-1.13.0',
      choices: [{ message: { content: '```json\n{...' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, cost: 0 } }));
    global.fetch = garbage as unknown as typeof fetch;
    const unreadable = await triageVeCompanies(packet(3));
    expect(unreadable.results.every((item) => item.outcome === 'failed')).toBe(true);
    // Three bad answers are below the five-strike breaker: the next packet still asks.
    expect(unreadable.unavailable).toBe(false);
    expect(garbage.mock.calls).toHaveLength(3);
    await triageVeCompanies(packet(1));
    expect(garbage.mock.calls).toHaveLength(4);

    // A single unreadable answer inside a readable packet costs only that answer:
    // the broken conflict counts as "not shown" and the rest still decide.
    resetVeTriageState();
    global.fetch = jest.fn(async () => jev({ activity: { noul: 0.01 }, req_0: { noul: 0.02 },
      conflict_0: { noul: 'не число' }, serves_target_not_member: { noul: 0.05 },
      fit: { probabilities: { relevant: 0.05, irrelevant: 0.9, insufficient: 0.05 } } }, 100)) as unknown as typeof fetch;
    const partial = await triageVeCompanies(packet(1));
    expect(partial.results[0]).toEqual({ outcome: 'reject', activity: 0.01, conflict: null });
  });

  it('opens the breaker on the first wave of hung requests instead of holding the slots for minutes', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }));
      global.fetch = fetchMock as unknown as typeof fetch;
      const facts = { company: 'c', website: '', category: '', description: maker, vacancy_title: '', website_text: '' };
      const pending = triageVeCompanies({ rubric, language: 'ru', target: { vertical: 'v', verticalSummary: '', hypothesisTitle: 'h', hypothesisDescription: '' },
        companies: Array.from({ length: 24 }, () => ({ facts, excerpts: [] })) });
      let outcome: Awaited<typeof pending> | undefined;
      void pending.then((value) => { outcome = value; });
      let waited = 0;
      while (!outcome && waited < 120_000) { await jest.advanceTimersByTimeAsync(5_000); waited += 5_000; }
      // Without the breaker (and the drain of its queue) this packet needs 24
      // companies x 20 s on six slots: 80 s, cut only by the packet deadline.
      expect(waited).toBeLessThanOrEqual(25_000);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
      if (!outcome) throw new Error('packet did not finish');
      expect(outcome.unavailable).toBe(true);
      expect(outcome.results.every((item) => item.outcome === 'failed')).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('rides out a sub-second error burst and bounds a slow but answering provider by the packet deadline', async () => {
    jest.useFakeTimers();
    try {
      const facts = { company: 'c', website: '', category: '', description: maker, vacancy_title: '', website_text: '' };
      const target = { vertical: 'v', verticalSummary: '', hypothesisTitle: 'h', hypothesisDescription: '' };
      const answer = jev({ activity: { noul: 0.2 } }, 100);
      const settle = async <T>(pending: Promise<T>, limitMs: number) => {
        let value: T | undefined, waited = 0;
        void pending.then((result) => { value = result; });
        while (value === undefined && waited < limitMs) { await jest.advanceTimersByTimeAsync(500); waited += 500; }
        if (value === undefined) throw new Error('not settled');
        return { value, waited };
      };
      // The first wave gets 502 (a gateway restart); retries succeed. Before the
      // HTTP-status rule this one wave switched the fast check off for five minutes.
      let served = 0;
      global.fetch = jest.fn(async () => (served++ < 6 ? reply(502, {}) : answer)) as unknown as typeof fetch;
      const blip = await settle(triageVeCompanies({ rubric, language: 'ru', target, companies: Array.from({ length: 24 }, () => ({ facts, excerpts: [] })) }), 30_000);
      expect(blip.value.unavailable).toBe(false);
      expect(blip.value.results.every((item) => item.outcome === 'uncertain')).toBe(true);

      // Every request succeeds after 9 s (below the request timeout): the breaker
      // never opens, so only the deadline keeps the packet from taking as long as it likes.
      const slow = jest.fn(() => new Promise<Response>((resolve) => { setTimeout(() => resolve(answer), 9_000); }));
      global.fetch = slow as unknown as typeof fetch;
      const late = await settle(triageVeCompanies({ rubric, language: 'ru', target, companies: Array.from({ length: 120 }, () => ({ facts, excerpts: [] })) }), 300_000);
      expect(late.waited).toBeLessThanOrEqual(130_000);
      expect(slow.mock.calls.length).toBeLessThan(120);
      expect(late.value.results.some((item) => item.outcome === 'failed')).toBe(true);
      expect(late.value.unavailable).toBe(false);
    } finally { jest.useRealTimers(); }
  });
});
