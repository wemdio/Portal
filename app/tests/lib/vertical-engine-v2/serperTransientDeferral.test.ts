/** @jest-environment node */

/**
 * 23.09.2026, прод. Serper при этом работал: у базы 6b5bf9e8 «Директ Лайн ·
 * Стоматологические клиники» за четыре дня не было ни одного вызова Serper,
 * у ba3dc535 «Эво Стикер · Детские центры и парки» все вызовы — 200.
 *
 * - 6b5bf9e8: 718 готовых из 500, status failed «Serper transient: search
 *   service unavailable.». Причина — одна клиника (doktor-a.com) с сохранённым
 *   сбоем поиска от 10.09, записанным ещё прежней версией. Цель набрана, поэтому
 *   проход сайтов не читает ни одной компании (предел 0), а её старый сбой
 *   каждый проход объявлял «временным сбоем» всей базы: повторы этапа,
 *   затем failed, автоподъём, и так по кругу пять раз за шесть часов.
 * - ba3dc535: один сбой «Serper transient: transport.» от 22.09 00:20 (запрос
 *   не получил ответа за 10 с). Компания стоит в хвосте очереди за тысячами
 *   отложенных поисков, до повтора не доходит, но так же валила проход.
 */
jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(async () => undefined) }));
jest.mock('@/lib/verticalEngineV2/llm', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/llm'),
  callLLMWithSchema: jest.fn(async () => { throw new Error('Requesty 503: offline test'); }),
}));

import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import { fetchVeRelevanceEvidence, type VeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { finishCollectionRound, type VeCollectionTargetProgress } from '@/lib/verticalEngineV2/collectionTarget';

const LEGACY_MESSAGE = 'Serper transient: search service unavailable.';
const TRANSPORT_MESSAGE = 'Serper transient: transport.';
const doktorA = { company: 'ООО «Доктор А»', inn: '7701234567', website: 'https://doktor-a.com/' };
const neighbour = { company: 'ООО «Улыбка»', inn: '7707654321', website: 'https://ulybka.test/' };
const base = { verticalName: 'Стоматологические клиники', hypothesisTitle: 'Стоматологические клиники', language: 'ru' as const };

const searchFailure = (url: string, message: string): VeRelevanceEvidence => ({ status: 'error', text: '', url, reason: message,
  provider_error: { kind: 'transient', message } });
const unconfirmed = (url: string): VeRelevanceEvidence => ({ status: 'unavailable', text: '', url, reason: 'website_identity_unverified', pages: 1 });
const keyOf = (checkpoint: VeRelevanceCheckpoint, url: string) =>
  Object.entries(checkpoint.website_evidence).find(([, item]) => item.url === url)![0];

describe('временный сбой поиска — дело компании, а не всей базы', () => {
  it('6b5bf9e8: сохранённый сбой от 10.09 при набранной цели не делает проход сбойным', async () => {
    const rows = [doktorA, neighbour];
    const first = await findIrrelevantRows({ ...base, rows,
      fetchEvidence: jest.fn(async (url: string) => url.includes('doktor-a')
        ? searchFailure(doktorA.website, LEGACY_MESSAGE) : unconfirmed(url)) as unknown as typeof fetchVeRelevanceEvidence });
    // Чекпойнт в том виде, в каком он лежит у базы на проде: запись прежней
    // версии читателя (без reader_revision и счётчика попыток) и вердикт error.
    const saved = structuredClone(first.checkpoint);
    const key = keyOf(saved, doktorA.website);
    saved.website_evidence[key] = { url: doktorA.website, text: '', reason: LEGACY_MESSAGE, status: 'error', refined: true,
      provider_error: { kind: 'transient', message: LEGACY_MESSAGE }, reader_version: 1,
      review_attempt: saved.website_evidence[key].review_attempt, review_attempts: 0 };
    saved.verdicts[key] = { reason: LEGACY_MESSAGE, status: 'error', version: 2, evidence: [],
      context_hash: saved.verdicts[key].context_hash, review_attempts: 0 };

    // Цель набрана: платный поиск закрыт, предел сайтов 0 (checkCollectedRelevance).
    const fetchEvidence = jest.fn();
    const gate = await findIrrelevantRows({ ...base, rows, checkpoint: saved, allowPaidSearch: false, websiteLimit: 0,
      fetchEvidence: fetchEvidence as unknown as typeof fetchVeRelevanceEvidence });
    expect(fetchEvidence).not.toHaveBeenCalled();
    // До правки: error «Serper transient: search service unavailable.», retryable,
    // покрытие неполное — этап уходил в повторы, затем база в failed.
    expect([gate.error, gate.retryable, gate.coverage.complete]).toEqual([undefined, false, true]);
    expect(gate.decisions.get(0)).toMatchObject({ status: 'needs_review', search_deferred: true });
    expect(gate.decisions.get(0)).not.toHaveProperty('website_review_version');
    expect(gate.errored.size).toBe(0);
    // Компания остаётся непроверенной и в запуск не попадает.
    expect(gate.unchecked.has(0)).toBe(true);
  });

  it('ba3dc535: свежий сбой одной компании не просит повтора этапа, а сбой в хвосте очереди не валит проход', async () => {
    const reader = jest.fn(async (url: string) => url.includes('doktor-a')
      ? searchFailure(doktorA.website, TRANSPORT_MESSAGE) : unconfirmed(url));
    const fetchEvidence = reader as unknown as typeof fetchVeRelevanceEvidence;
    const fresh = await findIrrelevantRows({ ...base, rows: [doktorA, neighbour], fetchEvidence });
    expect(reader).toHaveBeenCalledTimes(2);
    // До правки: retryable true и покрытие неполное — стадия повторялась, а
    // исчерпав повторы, отдавала базу в failed.
    expect([fresh.error, fresh.retryable, fresh.coverage.complete]).toEqual([undefined, false, true]);
    expect(fresh.decisions.get(0)).toMatchObject({ status: 'needs_review', search_deferred: true });
    const key = keyOf(fresh.checkpoint, doktorA.website);
    // Ограниченный повтор самой компании сохраняется.
    expect(fresh.checkpoint.website_evidence[key]).toMatchObject({ provider_error: { kind: 'transient' }, provider_error_attempts: 1 });

    // Следующий проход: впереди новая компания, предел сайтов 1 — до повтора
    // сбойной очередь не доходит (как 4 173 отложенных поиска у ba3dc535).
    reader.mockClear();
    const extra = { company: 'ООО «Кидс Парк»', inn: '7705555555', website: 'https://kids-park.test/' };
    const starved = await findIrrelevantRows({ ...base, rows: [doktorA, neighbour, extra], websiteLimit: 1,
      checkpoint: structuredClone(fresh.checkpoint), fetchEvidence });
    expect(reader.mock.calls.map(([url]) => url)).toEqual([extra.website]);
    expect([starved.error, starved.retryable, starved.coverage.complete]).toEqual([undefined, false, true]);
    expect(starved.decisions.get(0)).toMatchObject({ status: 'needs_review', search_deferred: true });

    // Повтор без предела доходит до компании; после трёх попыток поиск по ней
    // больше не покупается, а она остаётся в резерве.
    let checkpoint = starved.checkpoint;
    reader.mockClear();
    for (let pass = 0; pass < 3; pass++) {
      checkpoint = (await findIrrelevantRows({ ...base, rows: [doktorA, neighbour, extra], checkpoint, fetchEvidence })).checkpoint;
    }
    expect(reader.mock.calls.filter(([url]) => url === doktorA.website)).toHaveLength(2);
    const released = await findIrrelevantRows({ ...base, rows: [doktorA, neighbour, extra], checkpoint, fetchEvidence });
    expect(reader.mock.calls.filter(([url]) => url === doktorA.website)).toHaveLength(2);
    expect([released.error, released.retryable, released.coverage.complete]).toEqual([undefined, false, true]);
    expect(released.decisions.get(0)).toMatchObject({ status: 'needs_review',
      reason: 'Сервис поиска не ответил после повторных попыток; контакт сохранён в резерве.' });
  });

  it('отмена задачи во время поиска — не сбой Serper: ни ярлыка, ни попытки', async () => {
    const job = new AbortController();
    const saved: VeRelevanceCheckpoint[] = [];
    let searching!: () => void;
    const started = new Promise<void>((resolve) => { searching = resolve; });
    const search = jest.fn((_query: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      searching();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const fetchEvidence = ((website: string, opts: Parameters<typeof fetchVeRelevanceEvidence>[1]) =>
      fetchVeRelevanceEvidence(website, { ...opts, search, fetchPage: async () => { throw new Error('offline'); } })) as typeof fetchVeRelevanceEvidence;
    const gate = findIrrelevantRows({ ...base, rows: [{ company: doktorA.company, inn: doktorA.inn }], signal: job.signal, fetchEvidence,
      onCheckpoint: async (checkpoint) => { saved.push(structuredClone(checkpoint)); } });
    const outcome = gate.then(() => 'resolved', (error: unknown) => error);
    await started;
    job.abort(new Error('VE2 base_collect inactivity timeout'));
    expect(await outcome).toEqual(new Error('VE2 base_collect inactivity timeout'));
    expect(search).toHaveBeenCalledTimes(1);
    expect(saved.flatMap((checkpoint) => Object.values(checkpoint.website_evidence)).filter((item) => item.provider_error)).toEqual([]);
  });
});

describe('цель набрана — база не падает на временном сбое поставщика', () => {
  // Раунд базы 6b5bf9e8 на момент отказа 23.09 05:34 UTC.
  const progress: VeCollectionTargetProgress = { mode: 'preview', round: 1, status: 'collecting', max_rounds: 100, ready_rows: 718,
    ready_target: 500, max_candidates: 10_000, candidates_processed: 1_903, first_round_candidates: 2_000 };
  const round = (readyRows: number, error: string | null) => finishCollectionRound(progress,
    { candidates: 0, readyRows, exhausted: false, canContinue: true, error, validationRetry: true });

  it('718 из 500 и «Serper transient» — цель достигнута, а не failed', () => {
    expect(round(718, LEGACY_MESSAGE)).toMatchObject({ status: 'target_reached', ready_rows: 718 });
    expect(round(718, LEGACY_MESSAGE)).not.toHaveProperty('reason');
    expect(round(500, TRANSPORT_MESSAGE).status).toBe('target_reached');
    expect(round(718, 'Requesty 503: Service Unavailable').status).toBe('target_reached');
  });

  it('недобор или отказ, требующий человека, по-прежнему останавливают раунд', () => {
    // Недобор уходит в failed и поднимается автоподъёмом временных сбоев.
    expect(round(369, TRANSPORT_MESSAGE)).toMatchObject({ status: 'error', reason: TRANSPORT_MESSAGE });
    expect(round(718, 'Serper billing: insufficient search credits.').status).toBe('error');
    expect(round(718, 'Serper configuration: search API key or request is invalid.').status).toBe('error');
    expect(round(718, 'Очистка названий завершилась не полностью').status).toBe('error');
  });
});
