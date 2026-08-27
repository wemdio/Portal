/** @jest-environment node */

/**
 * Red-phase contract for the detailed Vertical Engine v2 segment classifier.
 *
 * The legacy Map<number, string> result cannot distinguish an explicit
 * `segment: null` (a legitimate default-text lead) from a row omitted because
 * an LLM batch failed or returned an incomplete/invalid payload. The
 * pre-launch audit needs that distinction: failed/missing rows must never be
 * reported to a specialist as ordinary default rows.
 */

const mockCallLLMWithSchema = jest.fn();
const mockGetVeModel = jest.fn(() => 'test-gate-model');

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLMWithSchema(...args),
  getVeModel: () => mockGetVeModel(),
}));

import { classifyBaseRowsIntoSegmentsDetailed } from '@/lib/verticalEngineV2/segmentClassify';

function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Email: `lead-${i}@example.test`,
    Компания: `Компания ${i}`,
  }));
}

function llmResult(
  assignments: Array<{ row: number; segment: string | null }>,
  usage: { tokensUsed?: number; costUsd?: number } = {},
) {
  return {
    data: { assignments },
    tokensUsed: usage.tokensUsed ?? 0,
    costUsd: usage.costUsd ?? 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('classifyBaseRowsIntoSegmentsDetailed', () => {
  it('marks every row as an explicit default without LLM calls when there are no segments', async () => {
    const result = await classifyBaseRowsIntoSegmentsDetailed({
      rows: rows(3),
      segments: [],
      language: 'ru',
    });

    expect(mockCallLLMWithSchema).not.toHaveBeenCalled();
    expect(result.assignments).toEqual(
      new Map<number, string | null>([
        [0, null],
        [1, null],
        [2, null],
      ]),
    );
    expect(result.unclassifiedRows).toEqual([]);
    expect(result.failedBatches).toBe(0);
    expect(result.totalBatches).toBe(0);
    expect(result.usage).toEqual({ tokensUsed: 0, costUsd: 0 });
  });

  it('keeps explicit null as default but marks missing and unknown assignments unclassified', async () => {
    mockCallLLMWithSchema.mockResolvedValue(
      llmResult(
        [
          { row: 0, segment: '  шКоЛы  ' },
          { row: 1, segment: null },
          { row: 2, segment: 'Несуществующий сегмент' },
          // row 3 is omitted by the model and must not silently become default.
        ],
        { tokensUsed: 17, costUsd: 0.004 },
      ),
    );

    const result = await classifyBaseRowsIntoSegmentsDetailed({
      rows: rows(4),
      segments: ['Школы', 'Клиники'],
      language: 'ru',
    });

    expect(result.assignments).toEqual(
      new Map<number, string | null>([
        [0, 'Школы'],
        [1, null],
      ]),
    );
    expect(result.assignments.has(1)).toBe(true);
    expect(result.assignments.get(1)).toBeNull();
    expect(result.assignments.has(2)).toBe(false);
    expect(result.assignments.has(3)).toBe(false);
    expect(result.unclassifiedRows).toEqual([2, 3]);
    expect(result.failedBatches).toBe(0);
    expect(result.totalBatches).toBe(1);
    expect(result.usage).toEqual({ tokensUsed: 17, costUsd: 0.004 });
  });

  it('keeps successful rows and exposes every row from a failed batch as unclassified', async () => {
    const firstBatchAssignments = Array.from({ length: 40 }, (_, row) => ({
      row,
      segment: row % 2 === 0 ? 'Школы' : null,
    }));
    const log = jest.fn();
    mockCallLLMWithSchema
      .mockResolvedValueOnce(
        llmResult(firstBatchAssignments, { tokensUsed: 100, costUsd: 0.025 }),
      )
      .mockRejectedValueOnce(new Error('Requesty 502'));

    const result = await classifyBaseRowsIntoSegmentsDetailed({
      rows: rows(41),
      segments: ['Школы', 'Клиники'],
      language: 'ru',
      log,
    });

    expect(mockCallLLMWithSchema).toHaveBeenCalledTimes(2);
    expect(result.assignments.size).toBe(40);
    expect(result.assignments.get(0)).toBe('Школы');
    expect(result.assignments.has(1)).toBe(true);
    expect(result.assignments.get(1)).toBeNull();
    expect(result.assignments.has(40)).toBe(false);
    expect(result.unclassifiedRows).toEqual([40]);
    expect(result.failedBatches).toBe(1);
    expect(result.totalBatches).toBe(2);
    expect(result.usage).toEqual({ tokensUsed: 100, costUsd: 0.025 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Requesty 502'));
  });

  it('returns diagnostics instead of null when every batch fails', async () => {
    mockCallLLMWithSchema.mockRejectedValue(new Error('provider unavailable'));

    const result = await classifyBaseRowsIntoSegmentsDetailed({
      rows: rows(41),
      segments: ['Школы'],
      language: 'ru',
    });

    expect(result.assignments).toEqual(new Map());
    expect(result.unclassifiedRows).toEqual(Array.from({ length: 41 }, (_, i) => i));
    expect(result.failedBatches).toBe(2);
    expect(result.totalBatches).toBe(2);
    expect(result.usage).toEqual({ tokensUsed: 0, costUsd: 0 });
  });

  it('aggregates usage across all successful batches', async () => {
    mockCallLLMWithSchema
      .mockResolvedValueOnce(
        llmResult(
          Array.from({ length: 40 }, (_, row) => ({ row, segment: null })),
          { tokensUsed: 30, costUsd: 0.01 },
        ),
      )
      .mockResolvedValueOnce(
        llmResult([{ row: 40, segment: 'Клиники' }], {
          tokensUsed: 7,
          costUsd: 0.003,
        }),
      );

    const result = await classifyBaseRowsIntoSegmentsDetailed({
      rows: rows(41),
      segments: ['Клиники'],
      language: 'ru',
    });

    expect(result.unclassifiedRows).toEqual([]);
    expect(result.failedBatches).toBe(0);
    expect(result.totalBatches).toBe(2);
    expect(result.usage.tokensUsed).toBe(37);
    expect(result.usage.costUsd).toBeCloseTo(0.013, 10);
  });
});
