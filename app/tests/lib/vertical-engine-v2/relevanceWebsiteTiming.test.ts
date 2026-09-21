/** @jest-environment node */

/**
 * Фаза сайтов идёт барьерами по восемь: следующая восьмёрка не стартует, пока
 * не вернётся самый медленный из текущей. Пока видимость — только ярлыки
 * причин, выигрыш пула нечем ни защитить, ни проверить после деплоя. Здесь под
 * тестом сам замер: занятость слотов, простой на барьере и разделение одного
 * ярлыка таймаута на постраничный и общий дедлайн.
 */
import { findIrrelevantRows, journalWaveTiming, type VeWebsiteWaveTiming } from '@/lib/verticalEngineV2/relevanceGate';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';
import { withProviderUsage } from '@/lib/providerUsage';
import { logInfo } from '@/lib/loggerServer';
import type { VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(async () => undefined) }));
const logInfoMock = logInfo as jest.MockedFunction<typeof logInfo>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Строки без сведений о деятельности уходят в needs_review без единого
 * обращения к модели и попадают ровно в фазу сайтов — то, что замеряем. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  company: `Компания ${i + 1}`, inn: `77000000${String(i + 10)}`, website: `https://company-${i + 1}.test`,
}));
const gate = (over: Partial<Parameters<typeof findIrrelevantRows>[0]>) => findIrrelevantRows({
  rows: rows(8), verticalName: 'Промышленное оборудование', hypothesisTitle: 'Производители насосов',
  language: 'ru' as const, ...over,
} as Parameters<typeof findIrrelevantRows>[0]);

beforeEach(() => logInfoMock.mockClear());

describe('журнал длительностей фазы сайтов', () => {
  it('показывает простой слотов: стена волны равна самому медленному, а не сумме', async () => {
    const waves: VeWebsiteWaveTiming[] = [];
    await gate({
      onWebsiteTiming: (wave) => waves.push(wave),
      fetchEvidence: (async (website: string) => {
        await sleep(website.includes('company-1.test') ? 220 : 10);
        return { status: 'unavailable', text: '', url: website, reason: 'no_usable_website_text', pages: 1 };
      }) as unknown as typeof fetchVeRelevanceEvidence,
    });
    expect(waves).toHaveLength(1);
    const [wave] = waves;
    expect(wave.slots).toBe(8);
    expect(wave.companies).toBe(8);
    // Один медленный участник держит стену волны, семь слотов при этом пусты.
    expect(wave.maxMs).toBeGreaterThanOrEqual(200);
    expect(wave.wallMs).toBeGreaterThanOrEqual(wave.maxMs);
    expect(wave.sumMs).toBeLessThan(wave.slots * wave.wallMs / 2);
    const idleSlotMs = wave.slots * wave.wallMs - wave.sumMs;
    expect(idleSlotMs / wave.wallMs).toBeGreaterThan(5);
    expect(wave.pagesRead).toBe(8);
  });

  it('делит один ярлык таймаута на постраничный и общий дедлайн', async () => {
    const waves: VeWebsiteWaveTiming[] = [];
    await gate({
      onWebsiteTiming: (wave) => waves.push(wave),
      fetchEvidence: (async (website: string) => {
        const kind = /company-[12]\.test/.test(website) ? 'deadline' as const
          : /company-[345]\.test/.test(website) ? 'page' as const : undefined;
        return kind
          ? { status: 'unavailable', text: '', url: website, reason: 'website_evidence_timeout', timeout: kind, pages: 2 }
          : { status: 'unavailable', text: '', url: website, reason: 'website_identity_unverified', pages: 1 };
      }) as unknown as typeof fetchVeRelevanceEvidence,
    });
    expect(waves[0].outcomes).toEqual(expect.objectContaining({
      timeoutDeadline: 2, timeoutPage: 3, unavailable: 3, ok: 0, providerError: 0, deferred: 0,
    }));
  });

  it('пишет журнал после долговечного сохранения, а не до него', async () => {
    const order: string[] = [];
    await gate({
      onCheckpoint: async () => { order.push('save'); },
      onWebsiteTiming: () => order.push('timing'),
      fetchEvidence: (async (website: string) =>
        ({ status: 'unavailable', text: '', url: website, reason: 'no_usable_website_text', pages: 0 })
      ) as unknown as typeof fetchVeRelevanceEvidence,
    });
    // Долговечная точка идёт первой: журнал пишется уже после сохранения.
    expect(order).toContain('timing');
    expect(order[order.indexOf('timing') - 1]).toBe('save');
  });

  it('синтетические секунды оффлайн-адаптера в журнал не попадают', async () => {
    await withProviderUsage({ projectId: 'p', jobId: 'j', stage: 'base_collect' }, async () => undefined, () => gate({
      fetchEvidence: (async (website: string) =>
        ({ status: 'unavailable', text: '', url: website, reason: 'no_usable_website_text' })
      ) as unknown as typeof fetchVeRelevanceEvidence,
    }));
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it('строка журнала уходит отдельным источником и только внутри области учёта', async () => {
    const wave: VeWebsiteWaveTiming = { slots: 8, companies: 8, cached: 0, wallMs: 41_000, sumMs: 9_000,
      maxMs: 40_500, minMs: 120, buckets: [3, 2, 1, 1, 0, 0, 1], saveMs: 800, pagesRead: 19,
      outcomes: { ok: 2, unavailable: 3, providerError: 0, deferred: 0, timeoutPage: 2, timeoutDeadline: 1, slowButUsable: 1 } };
    journalWaveTiming(wave);
    expect(logInfoMock).not.toHaveBeenCalled();
    await withProviderUsage({ projectId: 'p1', baseId: 'b1', jobId: 'j1', stage: 'base_collect' },
      async () => undefined, async () => { journalWaveTiming(wave); });
    expect(logInfoMock).toHaveBeenCalledTimes(1);
    const [event, , context] = logInfoMock.mock.calls[0];
    expect(event).toBe('ve2_website_wave');
    expect(context).toEqual(expect.objectContaining({ version: 1, projectId: 'p1', baseId: 'b1', jobId: 'j1',
      stage: 'base_collect', slots: 8, wallMs: 41_000, sumMs: 9_000 }));
  });
});

describe('разделение таймаута в доказательствах сайта', () => {
  const page = (over: Partial<VeEvidencePage> & { url: string }): VeEvidencePage =>
    ({ text: '', links: [], inns: [], ...over });
  const run = (thrown: Error) => fetchVeRelevanceEvidence('https://romashka.ru', {
    companyInn: '7700000001', companyName: 'Ромашка', companyAddress: 'Казань, ул. Мира, 5', focus: 'мебель',
    fetchPage: async (url) => { if (url.includes('romashka.ru')) throw thrown; return page({ url }); },
    search: (async () => []) as never,
  });

  it('постраничный дедлайн и общий дедлайн различимы, а ярлык причины не меняется', async () => {
    const perPage = await run(new VeOperationTimeoutError('relevance evidence page', 5_000));
    expect(perPage.reason).toBe('website_evidence_timeout');
    expect(perPage.timeout).toBe('page');

    const overall = await run(new VeOperationTimeoutError('relevance website evidence', 120_000));
    expect(overall.reason).toBe('website_evidence_timeout');
    expect(overall.timeout).toBe('deadline');
  });
});
