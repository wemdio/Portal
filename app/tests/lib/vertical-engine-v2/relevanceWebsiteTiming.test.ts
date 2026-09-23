/** @jest-environment node */

/**
 * Фаза сайтов идёт барьерами по восемь: следующая восьмёрка не стартует, пока
 * не вернётся самый медленный из текущей. Пока видимость — только ярлыки
 * причин, выигрыш пула нечем ни защитить, ни проверить после деплоя. Здесь под
 * тестом сам замер: занятость слотов, простой на барьере и разделение одного
 * ярлыка таймаута на постраничный и общий дедлайн.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { findIrrelevantRows, journalWaveTiming, type VeWebsiteWaveTiming } from '@/lib/verticalEngineV2/relevanceGate';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';
import { withProviderUsage } from '@/lib/providerUsage';
import { logInfo } from '@/lib/loggerServer';
import { reportProxyNodeResult, resetProxyGroupsCache, resetProxyNodeHealth } from '@/lib/enrich/proxyPool';
import type { VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';

jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(async () => undefined) }));
const logInfoMock = logInfo as jest.MockedFunction<typeof logInfo>;
jest.mock('node:perf_hooks', () => {
  const actual = jest.requireActual('node:perf_hooks');
  return { ...actual, monitorEventLoopDelay: jest.fn((options) => actual.monitorEventLoopDelay(options)) };
});
const loopDelayMock = monitorEventLoopDelay as jest.MockedFunction<typeof monitorEventLoopDelay>;

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

beforeEach(() => { logInfoMock.mockClear(); loopDelayMock.mockClear(); });

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
      proxyAttempts: 2, proxyRescued: 1, proxyVerified: 1, proxyDenied: 0, proxyFailed: 1, proxyUnavailable: 0, loopDelayMaxMs: 37,
      outcomes: { ok: 2, unavailable: 3, providerError: 0, deferred: 0, timeoutPage: 2, timeoutDeadline: 1, slowButUsable: 1 } };
    // Три RU-ноды, вторая выбыла: в журнал идёт её номер, а не адрес.
    const nodes = ['http://user:secret@10.1.1.1:8000', 'http://user:secret@10.1.1.2:8000', 'http://user:secret@10.1.1.3:8000'];
    const savedPriority = process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
    process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify(nodes);
    resetProxyGroupsCache();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i += 1) reportProxyNodeResult(nodes[1], 'down', 'UND_ERR_SOCKET');
    warn.mockRestore();
    try {
      journalWaveTiming(wave);
      expect(logInfoMock).not.toHaveBeenCalled();
      await withProviderUsage({ projectId: 'p1', baseId: 'b1', jobId: 'j1', stage: 'base_collect' },
        async () => undefined, async () => { journalWaveTiming(wave); });
      expect(logInfoMock).toHaveBeenCalledTimes(1);
      const [event, , context] = logInfoMock.mock.calls[0];
      expect(event).toBe('ve2_website_wave');
      // Версия 3: повтор через прокси по умолчанию и выбывание нод меняют форму
      // волны — сравнивать с версиями 1 и 2 нельзя.
      expect(context).toEqual(expect.objectContaining({ version: 3, projectId: 'p1', baseId: 'b1', jobId: 'j1',
        stage: 'base_collect', slots: 8, wallMs: 41_000, sumMs: 9_000,
        proxyAttempts: 2, proxyRescued: 1, proxyVerified: 1, proxyDenied: 0, proxyFailed: 1, proxyUnavailable: 0,
        proxyNodesOut: [2], loopDelayMaxMs: 37 }));
      expect(JSON.stringify(context)).not.toMatch(/secret|10\.1\.1/);
    } finally {
      resetProxyNodeHealth();
      if (savedPriority === undefined) delete process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
      else process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = savedPriority;
      resetProxyGroupsCache();
    }
  });

  it('медленная страница считается «пригодной» только при готовом тексте; прокси и задержка цикла — в волне', async () => {
    const waves: VeWebsiteWaveTiming[] = [];
    // Готовый текст ведёт гейт к платной классификации — её не ждём:
    // волна уже записана, дальше этап отменяется.
    const stop = new AbortController();
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => { throw new Error('network is not allowed in this test'); }) as never;
    // Гистограмма волны — заглушка с известным максимумом (в наносекундах).
    const histogram = { enable: jest.fn(), disable: jest.fn(), max: 37e6 };
    loopDelayMock.mockImplementationOnce(() => histogram as never);
    try {
      await gate({
        signal: stop.signal,
        onWebsiteTiming: (wave) => { waves.push(wave); stop.abort(); },
        fetchEvidence: (async (website: string) => {
          if (website.includes('company-1.test')) return { status: 'ok', text: 'Производим насосы на собственном заводе.', url: website,
            reason: 'identity_verified_website', timeout: 'page', pages: 3, proxy: { attempts: 2, rescued: 1, verified: 1, denied: 0 } };
          // Молчал только каталог из поиска: ответ окончательный, текста нет.
          if (/company-[23]\.test/.test(website)) return { status: 'unavailable', text: '', url: website,
            reason: 'website_identity_unverified', timeout: 'page', pages: 4, proxy: { attempts: 0, rescued: 0, verified: 0, denied: 1 } };
          if (website.includes('company-4.test')) return { status: 'unavailable', text: '', url: website,
            reason: 'website_evidence_timeout', timeout: 'page', pages: 2, proxy: { attempts: 1, rescued: 0, verified: 0, denied: 0, failed: 1 } };
          // Все RU-ноды выбыли: пропуск не брался, ярлык — таймаут.
          if (website.includes('company-5.test')) return { status: 'unavailable', text: '', url: website,
            reason: 'website_evidence_timeout', timeout: 'page', pages: 2, proxy: { attempts: 0, rescued: 0, verified: 0, denied: 0, unavailable: 1 } };
          return { status: 'unavailable', text: '', url: website, reason: 'no_usable_website_text', pages: 1 };
        }) as unknown as typeof fetchVeRelevanceEvidence,
      }).catch(() => undefined);
    } finally {
      global.fetch = originalFetch;
    }
    expect(waves).toHaveLength(1);
    expect(waves[0].outcomes).toEqual(expect.objectContaining({ ok: 1, slowButUsable: 1, timeoutPage: 2, unavailable: 5 }));
    expect(waves[0]).toEqual(expect.objectContaining({ proxyAttempts: 3, proxyRescued: 1, proxyVerified: 1, proxyDenied: 2,
      proxyFailed: 1, proxyUnavailable: 1 }));
    // Задержка цикла снята за волну и переведена в миллисекунды.
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    expect(waves[0].loopDelayMaxMs).toBe(37);
  });

  it('гистограмма задержки выключается и при отмене волны', async () => {
    const stop = new AbortController();
    await expect(gate({
      signal: stop.signal,
      onWebsiteTiming: () => undefined,
      fetchEvidence: (async () => { stop.abort(); throw stop.signal.reason; }) as unknown as typeof fetchVeRelevanceEvidence,
    })).rejects.toBeDefined();
    expect(loopDelayMock).toHaveBeenCalled();
    // Повторное выключение возвращает false: таймер гистограммы уже снят.
    for (const { value: histogram } of loopDelayMock.mock.results) expect(histogram.disable()).toBe(false);
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

  // Проверяет только разделение телеметрии: ошибка приходит из адаптера
  // страницы, и ярлык в обоих случаях даёт молчание своей главной. Настоящее
  // срабатывание общего дедлайна после прочитанного сайта — в
  // relevanceEvidenceProxy.test.ts.
  it('телеметрия различает постраничный и общий дедлайн, ярлык — таймаут своей главной', async () => {
    const perPage = await run(new VeOperationTimeoutError('relevance evidence page', 5_000));
    expect(perPage.reason).toBe('website_evidence_timeout');
    expect(perPage.timeout).toBe('page');

    const overall = await run(new VeOperationTimeoutError('relevance website evidence', 120_000));
    expect(overall.reason).toBe('website_evidence_timeout');
    expect(overall.timeout).toBe('deadline');
  });
});
