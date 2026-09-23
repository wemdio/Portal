/** @jest-environment node */

/**
 * 23.09.2026, прод: задача base_collect базы «Частные психиатрические клиники»
 * (02af77df) пять раз подряд висела по 20 минут на одной волне сайтов гейта
 * релевантности и не отпускала её по отмене — сторож неактивности каждый раз
 * перезапускал воркер. Волна (Promise.all по восьми компаниям) ждала каждую
 * компанию, а читатель сайта после своего 120-секундного дедлайна ещё ждал
 * запись памяти фактов — без собственного предела и без сигнала задачи. Все
 * остальные ожидания волны снимаются отменой; висела ровно эта.
 */
jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(async () => undefined) }));
jest.mock('@/lib/verticalEngineV2/llm', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/llm'),
  callLLMWithSchema: jest.fn(async () => { throw new Error('Requesty 503: offline test'); }),
}));

import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import { fetchVeRelevanceEvidence, VE_RELEVANCE_EVIDENCE_MAX_MS } from '@/lib/verticalEngineV2/relevanceEvidence';
import { parseVeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

const INN = '7707083893';
const PAGE = `<title>Клиника «Альфа»</title><main><p>Частная психиатрическая клиника: лечение и
  диагностика пациентов, стационар и амбулаторный приём.</p></main><footer>ООО «Альфа», ИНН ${INN}</footer>`;
const fetchPage = async (url: string) => parseVeEvidencePage(Buffer.from(PAGE), url, 'text/html; charset=utf-8', 'клиника');
/** Обещание, которое не завершается и не слушает отмену: так выглядела зависшая запись. */
const never = <T,>() => new Promise<T>(() => {});

type Outcome = { state: 'pending' } | { state: 'resolved'; value: unknown } | { state: 'rejected'; error: unknown };
function track<T>(promise: Promise<T>) {
  const outcome: { current: Outcome } = { current: { state: 'pending' } };
  promise.then((value) => { outcome.current = { state: 'resolved', value }; },
    (error: unknown) => { outcome.current = { state: 'rejected', error }; });
  return outcome;
}

afterEach(() => { jest.useRealTimers(); });

describe('читатель сайта: память фактов не держит результат', () => {
  it('зависшая запись памяти не задерживает проверенный результат', async () => {
    jest.useFakeTimers();
    const write = jest.fn(() => never<void>());
    const result = track(fetchVeRelevanceEvidence('https://clinic-alfa.test/', {
      companyInn: INN, companyName: 'ООО «Альфа»', fetchPage, search: async () => [],
      companyFacts: { read: async () => [], write },
    }));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ state: 'resolved', value: { status: 'ok', reason: 'identity_verified_website' } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('зависшее чтение памяти не задерживает чтение сайта', async () => {
    jest.useFakeTimers();
    const result = track(fetchVeRelevanceEvidence('https://clinic-alfa.test/', {
      companyInn: INN, companyName: 'ООО «Альфа»', fetchPage, search: async () => [],
      companyFacts: { read: () => never(), write: async () => undefined },
    }));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(result.current).toMatchObject({ state: 'resolved', value: { status: 'ok' } });
  });

  it('отмена задачи снимает ожидание записи памяти', async () => {
    const job = new AbortController();
    let written!: () => void;
    const reached = new Promise<void>((resolve) => { written = resolve; });
    const result = track(fetchVeRelevanceEvidence('https://clinic-alfa.test/', {
      signal: job.signal, companyInn: INN, companyName: 'ООО «Альфа»', fetchPage, search: async () => [],
      companyFacts: { read: async () => [], write: () => { written(); return never<void>(); } },
    }));
    await reached;
    job.abort(new Error('job cancelled'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.current).toMatchObject({ state: 'rejected', error: new Error('job cancelled') });
  });
});

describe('волна сайтов гейта ограничена и отпускает задачу по отмене', () => {
  const rows = [{ company: 'ООО «Альфа»', inn: INN, website: 'https://clinic-alfa.test' }];
  const base = { rows, verticalName: 'Частные клиники', hypothesisTitle: 'Частные психиатрические клиники', language: 'ru' as const };

  it('воспроизведение 23.09: зависшая запись памяти не держит волну и отмену', async () => {
    const job = new AbortController();
    const saves: number[] = [];
    let written!: () => void;
    const reached = new Promise<void>((resolve) => { written = resolve; });
    const readEvidence = ((website: string, opts: Parameters<typeof fetchVeRelevanceEvidence>[1]) => fetchVeRelevanceEvidence(website, {
      ...opts, fetchPage, search: async () => [],
      companyFacts: { read: async () => [], write: () => { written(); return never<void>(); } },
    })) as typeof fetchVeRelevanceEvidence;
    const gate = track(findIrrelevantRows({ ...base, signal: job.signal, fetchEvidence: readEvidence,
      onCheckpoint: async () => { saves.push(Date.now()); } }));
    await reached;
    // Сторож неактивности задачи: до правки волна не завершалась и не
    // отпускала задачу и после отмены — ровно «ignored abort» на проде.
    job.abort(new Error('VE2 base_collect inactivity timeout'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gate.current.state).toBe('rejected');
  });

  it('без отмены волна дописывает компанию и сохраняет чекпойнт в пределах своего срока', async () => {
    jest.useFakeTimers();
    const saves: string[] = [];
    const readEvidence = ((website: string, opts: Parameters<typeof fetchVeRelevanceEvidence>[1]) => fetchVeRelevanceEvidence(website, {
      ...opts, fetchPage, search: async () => [],
      companyFacts: { read: async () => [], write: () => never<void>() },
    })) as typeof fetchVeRelevanceEvidence;
    const gate = track(findIrrelevantRows({ ...base, fetchEvidence: readEvidence,
      onCheckpoint: async (checkpoint) => { saves.push(Object.values(checkpoint.website_evidence).map((item) => item.reason).join(',')); } }));
    await jest.advanceTimersByTimeAsync(6_000);
    expect(gate.current.state).toBe('resolved');
    // Первое сохранение — отметка «нет сведений о деятельности», затем волна.
    expect(saves).toContain('identity_verified_website');
  });

  it('компания, чей читатель не завершается вовсе, получает ярлык таймаута, волна идёт дальше', async () => {
    jest.useFakeTimers();
    const activity = jest.fn();
    const evidence: string[] = [];
    const gate = track(findIrrelevantRows({ ...base,
      rows: [...rows, { company: 'ООО «Бета»', inn: '7707083894', website: 'https://clinic-beta.test' }],
      fetchEvidence: (async (website: string) => (website.includes('beta')
        ? { status: 'unavailable', text: '', url: website, reason: 'website_identity_unverified', pages: 1 }
        : never())) as unknown as typeof fetchVeRelevanceEvidence,
      onActivity: activity,
      onCheckpoint: async (checkpoint) => { evidence.push(...Object.values(checkpoint.website_evidence).map((item) => item.reason)); } }));
    await jest.advanceTimersByTimeAsync(1_000);
    // Дочитанная компания видна сторожу сразу, а не в конце волны.
    expect(activity).toHaveBeenCalledTimes(1);
    expect(gate.current.state).toBe('pending');
    await jest.advanceTimersByTimeAsync(VE_RELEVANCE_EVIDENCE_MAX_MS + 30_000);
    expect(gate.current.state).toBe('resolved');
    expect(activity).toHaveBeenCalledTimes(2);
    expect(evidence).toEqual(expect.arrayContaining(['website_evidence_timeout', 'website_identity_unverified']));
    const result = (gate.current as { value: Awaited<ReturnType<typeof findIrrelevantRows>> }).value;
    // Таймаут не вердикт: компания остаётся непроверенной и уйдёт на повтор.
    expect([...result.decisions.values()].every((decision) => decision.status === 'needs_review')).toBe(true);
  });
});
