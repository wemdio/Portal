/** @jest-environment node */
import { findIrrelevantRows, type VeWebsiteWaveTiming } from '@/lib/verticalEngineV2/relevanceGate';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';

jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(async () => undefined) }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
  company: `Компания ${i + 1}`, inn: `77000000${String(i + 10)}`, website: `https://company-${i + 1}.test`,
}));

it('стена волны не включает долговечное сохранение', async () => {
  const waves: VeWebsiteWaveTiming[] = [];
  await findIrrelevantRows({
    rows: rows(8), verticalName: 'V', hypothesisTitle: 'H', language: 'ru' as const,
    onWebsiteTiming: (w) => waves.push(w),
    onCheckpoint: async () => { await sleep(300); },
    fetchEvidence: (async (website: string) => {
      await sleep(10);
      return { status: 'unavailable', text: '', url: website, reason: 'no_usable_website_text', pages: 1 };
    }) as unknown as typeof fetchVeRelevanceEvidence,
  } as Parameters<typeof findIrrelevantRows>[0]);
  expect(waves).toHaveLength(1);
  // save() стоит 300 мс; чтение сайтов — ~10 мс. Если save попал в wallMs,
  // "простой слотов" вырастет на 8 × 300 мс из ничего.
  expect(waves[0].wallMs).toBeLessThan(200);
});
