/** @jest-environment node */

/**
 * Calibrated triage in front of the LLM relevance check (opt-in). The provider
 * is replaced by a URL-routing fetch double: api.typesafe.ai answers typed
 * questions with probabilities, router.requesty.ai answers the LLM prompts.
 */
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { buildVeRelevanceReviewBatch } from '@/lib/verticalEngineV2/relevanceReserve';
import { decideVeTriage, resetVeTriageState, selectVeTriageEvidence, type VeTriageRubric } from '@/lib/verticalEngineV2/relevanceTriage';
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

const maker = 'Завод выпускает промышленные насосы на собственной производственной площадке в Туле.';
const rows = [
  { company: 'Насосный завод', inn: '7700000001', description: maker },
  { company: 'Торговый дом', inn: '7700000002', description: 'Оптовая перепродажа импортного оборудования разных марок.' },
  { company: 'Сервис-центр', inn: '7700000003', description: 'Обслуживание и ремонт инженерных систем зданий.' },
];
const input = { rows, verticalName: 'Промышленное оборудование', hypothesisTitle: 'Производители насосов', language: 'ru' as const, triage: true,
  fetchEvidence: jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' }) };

/** Probabilities by company name; `down` makes the triage provider refuse the key. */
function provider(options: { down?: boolean } = {}) {
  const calls = { rubric: 0, classify: 0, review: 0, company: 0, evidence: 0 };
  const fetchMock = jest.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('typesafe')) {
      if (options.down) return reply(401, { error: 'invalid key' });
      if (body.questions.activity) {
        calls.company += 1;
        const name = body.state.company_facts_untrusted_data.company as string;
        const p = name === 'Насосный завод' ? { activity: 0.9, req_0: 0.8, conflict_0: 0.02, irrelevant: 0.01 }
          : name === 'Торговый дом' ? { activity: 0.01, req_0: 0.02, conflict_0: 0.9, irrelevant: 0.9 }
            : { activity: 0.2, req_0: 0.1, conflict_0: 0.1, irrelevant: 0.2 };
        return reply(200, { model: 'jev-1.13.0', usage: { input_tokens: 1000 }, answers: {
          activity: { noul: p.activity }, req_0: { noul: p.req_0 }, conflict_0: { noul: p.conflict_0 }, serves_target_not_member: { noul: 0.05 },
          fit: { choice: 'x', probabilities: { relevant: 1 - p.irrelevant, irrelevant: p.irrelevant, insufficient: 0 } } } });
      }
      calls.evidence += 1;
      return reply(200, { model: 'jev-1.13.0', usage: { input_tokens: 500 }, answers: Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { noul: key.endsWith('0') ? 0.8 : 0.1 }])) });
    }
    const system = body.messages[0].content as string;
    if (system.startsWith('You convert ONE B2B targeting hypothesis')) { calls.rubric += 1; return llm(rubric); }
    if (system.startsWith('Independently check')) {
      calls.review += 1;
      return llm({ reviews: JSON.parse(body.messages[1].content.split('index:\n')[1]).map((item: { i: number }) => ({ i: item.i, result: 'direct_match', reason: 'Производит насосы' })) });
    }
    calls.classify += 1;
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
    process.env.VE_RELEVANCE_TRIAGE = 'jev'; process.env.TYPESAFE_API_KEY = 'test-key';
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    delete process.env.VE_RELEVANCE_TRIAGE_PROJECTS; delete process.env.VE_MODEL_GATE; delete process.env.VE_MODEL_RELEVANCE_REVIEW;
  });
  afterEach(() => { process.env = { ...env }; });

  it('is off unless the mode, the key and (when listed) the project are configured', () => {
    expect(isVeRelevanceTriageEnabled('p1')).toBe(true);
    process.env.VE_RELEVANCE_TRIAGE_PROJECTS = 'p2, p3';
    expect(isVeRelevanceTriageEnabled('p1')).toBe(false);
    expect(isVeRelevanceTriageEnabled('p3')).toBe(true);
    delete process.env.TYPESAFE_API_KEY;
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
    // One checklist, one LLM classification for the single uncertain company, two review steps for the single proposal.
    expect(calls).toEqual({ rubric: 1, classify: 1, review: 2, company: 3, evidence: 1 });
    // One journal attempt per packet, with summed tokens and an estimated charge.
    const triageEvents = journal.filter((event) => event.provider === 'typesafe');
    expect(triageEvents.map((event) => event.phase)).toEqual(['started', 'finished']);
    expect(triageEvents[1]).toEqual(expect.objectContaining({ status: 'success', promptTokens: 3500, estimatedCostUsd: 3500 * 0.042 / 1e6, actualModel: 'jev-1.13.0' }));
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
});
