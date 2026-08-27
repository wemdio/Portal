/** @jest-environment node */

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchAndExtract: jest.fn(),
}));

import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import {
  ENRICH_CHECKPOINT_ATTEMPTED_COL,
  stepEnrich,
} from '@/lib/tools/processingSteps';

const fetchAndExtractMock = jest.mocked(fetchAndExtract);
const HEADER = ['Компания', 'Сайт', 'Описание'];
const noop = async () => {};

describe('stepEnrich checkpoint/resume', () => {
  beforeEach(() => {
    fetchAndExtractMock.mockReset();
  });

  it('на resume не повторяет уже завершённую пустую попытку и очищает metadata', async () => {
    fetchAndExtractMock.mockResolvedValue('Новое описание');

    const out = await stepEnrich(
      [
        [...HEADER, ENRICH_CHECKPOINT_ATTEMPTED_COL],
        ['Уже проверена', 'https://failed.example', '', '1'],
        ['Ещё не проверена', 'https://pending.example', '', ''],
        ['Готовая', 'https://ready.example', 'Ручное описание', '1'],
      ],
      noop,
    );

    expect(fetchAndExtractMock).toHaveBeenCalledTimes(1);
    expect(fetchAndExtractMock).toHaveBeenCalledWith(
      'https://pending.example',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(out).toEqual([
      HEADER,
      ['Уже проверена', 'https://failed.example', ''],
      ['Ещё не проверена', 'https://pending.example', 'Новое описание'],
      ['Готовая', 'https://ready.example', 'Ручное описание'],
    ]);
  });

  it('пишет отметки пустых ответов и ошибок только во внутренний checkpoint', async () => {
    fetchAndExtractMock.mockImplementation(async (url) => {
      if (String(url).includes('error-')) throw new Error('unreachable');
      return '';
    });

    const rows = Array.from({ length: 251 }, (_, index) => [
      `Company ${index}`,
      index % 2 === 0
        ? `https://empty-${index}.example`
        : `https://error-${index}.example`,
    ]);
    const checkpoints: string[][][] = [];

    const out = await stepEnrich(
      [['Компания', 'Сайт'], ...rows],
      noop,
      undefined,
      async (checkpoint) => { checkpoints.push(checkpoint); },
    );

    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    const intermediate = checkpoints[0];
    const markerIdx = intermediate[0].indexOf(ENRICH_CHECKPOINT_ATTEMPTED_COL);
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(intermediate.slice(1).filter((row) => row[markerIdx] === '1').length)
      .toBeGreaterThanOrEqual(250);

    expect(checkpoints.at(-1)?.[0]).toEqual(HEADER);
    expect(out[0]).toEqual(HEADER);
    expect(out.every((row) => row.length === HEADER.length)).toBe(true);
  });

  it('сохраняет чистый финальный checkpoint раньше progress=100', async () => {
    fetchAndExtractMock.mockResolvedValue('');
    const events: string[] = [];

    await stepEnrich(
      [HEADER, ['Company', 'https://company.example', '']],
      async (progress) => { events.push(`progress:${progress}`); },
      undefined,
      async (checkpoint) => {
        const hasMetadata = checkpoint[0].includes(ENRICH_CHECKPOINT_ATTEMPTED_COL);
        events.push(hasMetadata ? 'checkpoint:metadata' : 'checkpoint:clean');
      },
    );

    expect(events).toContain('checkpoint:clean');
    expect(events).toContain('progress:100');
    expect(events.indexOf('checkpoint:clean')).toBeLessThan(events.indexOf('progress:100'));
    expect(events.filter((event) => event === 'progress:100')).toHaveLength(1);
  });
});
