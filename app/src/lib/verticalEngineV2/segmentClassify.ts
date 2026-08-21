/**
 * Классификация строк базы по сегментам шаблона 85/15 — нужна для
 * материализации сегментных вариантов при запуске (Instantly не умеет
 * условные блоки, поэтому запуск сплитит лиды на кампании по сегментам).
 *
 * Каждая строка → условие сегмента (`when` дословно) или null (дефолтный
 * текст письма). Модель — bulk (sonnet), батчи по 40 строк, до 6 параллельно.
 * Контракт: частичные сбои переживаем (батч → лог, остальные продолжаются);
 * системный сбой (упали ВСЕ батчи) → null: вызывающий идёт по старому пути
 * (одна кампания, сегментные варианты выкинуты с предупреждением).
 */

import { z } from 'zod';
import { callLLMWithSchema, getVeModel, type LLMMessage } from './llm';

/** Строк в одном LLM-вызове (компактные ячейки, ~2-4k токенов на батч). */
const BATCH_SIZE = 40;
/** Параллельных вызовов (волнами). */
const CONCURRENCY = 6;
/** Кап символов ячейки в промпте. */
const MAX_CELL_CHARS = 80;

const AssignmentsSchema = z.object({
  assignments: z.array(
    z.object({
      row: z.number().int(),
      segment: z.string().nullable(),
    }),
  ),
});

export interface SegmentClassifyInput {
  /** Строки базы (только те, что реально уходят в запуск). */
  rows: Array<Record<string, unknown>>;
  /** Условия сегментов (when дословно, в том виде, что в шаблоне). */
  segments: string[];
  /** Язык промпта: по тексту условий (кириллица → ru). */
  language: 'ru' | 'en';
  log?: (msg: string) => void;
}

function truncateCell(value: unknown): string {
  const s = String(value ?? '').trim();
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

function buildClassifyMessages(
  segments: string[],
  batch: Array<{ index: number; cells: Record<string, string> }>,
  language: 'ru' | 'en',
): LLMMessage[] {
  const segList = segments.map((s, i) => `${i + 1}. «${s}»`).join('\n');
  const rowsJson = JSON.stringify(batch);
  if (language === 'en') {
    return [
      {
        role: 'system',
        content:
          'You classify B2B lead rows into audience segments for an outreach campaign. Answer strictly in JSON.',
      },
      {
        role: 'user',
        content: `Segments (conditions, verbatim):\n${segList}\n\nRows (index + non-empty cells):\n${rowsJson}\n\nFor each row decide which single segment condition it matches best ("segment" = the condition text EXACTLY as listed). If no condition plausibly fits — "segment": null. Return JSON: {"assignments": [{"row": <index>, "segment": <condition or null>}, ...]} covering every row index from the input.`,
      },
    ];
  }
  return [
    {
      role: 'system',
      content:
        'Ты классифицируешь строки базы лидов по сегментам аудитории для аутрич-кампании. Отвечай строго в JSON.',
    },
    {
      role: 'user',
      content: `Сегменты (условия, дословно):\n${segList}\n\nСтроки (index + непустые ячейки):\n${rowsJson}\n\nДля каждой строки реши, под какое ОДНО условие сегмента она подходит лучше всего ("segment" = текст условия ТОЧНО как в списке). Если ни одно правдоподобно не подходит — "segment": null. Верни JSON: {"assignments": [{"row": <index>, "segment": <условие или null>}, ...]} для КАЖДОГО index из входа.`,
    },
  ];
}

/**
 * Классифицировать строки. Возвращает Map «индекс строки во входном массиве →
 * условие сегмента (дословное)». Строки без уверенного матча в Map не
 * попадают (= дефолтный текст). null — системный сбой (все батчи упали).
 */
export async function classifyBaseRowsIntoSegments(
  input: SegmentClassifyInput,
): Promise<Map<number, string> | null> {
  const { rows, segments, language, log } = input;
  const cleaned = [...new Set(segments.map((s) => s.trim()).filter(Boolean))];
  if (rows.length === 0 || cleaned.length === 0) return new Map();

  const canonical = new Map(cleaned.map((s) => [s.toLowerCase(), s]));

  // Батчи с компактными строками: только непустые ячейки, кап на ячейку.
  const batches: Array<{ start: number; items: Array<{ index: number; cells: Record<string, string> }> }> = [];
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const items = rows.slice(start, start + BATCH_SIZE).map((row, i) => {
      const cells: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) {
        const cell = truncateCell(value);
        if (cell) cells[key] = cell;
      }
      return { index: start + i, cells };
    });
    batches.push({ start, items });
  }

  const result = new Map<number, string>();
  let failedBatches = 0;
  for (let wave = 0; wave < batches.length; wave += CONCURRENCY) {
    const group = batches.slice(wave, wave + CONCURRENCY);
    await Promise.all(
      group.map(async (batch) => {
        try {
          const llm = await callLLMWithSchema(
            buildClassifyMessages(cleaned, batch.items, language),
            AssignmentsSchema,
            // Роль gate: присвоение сегмента — классификация, мини-модель.
            { model: getVeModel('gate'), maxTokens: 4096 },
          );
          const validRows = new Set(batch.items.map((it) => it.index));
          for (const a of llm.data.assignments) {
            if (!validRows.has(a.row)) continue;
            const key = a.segment?.trim().toLowerCase();
            if (!key) continue;
            const condition = canonical.get(key);
            if (condition) result.set(a.row, condition);
          }
        } catch (e) {
          failedBatches += 1;
          log?.(
            `[segmentClassify] батч ${batch.start}–${batch.start + batch.items.length - 1} упал: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  if (failedBatches === batches.length) return null;
  return result;
}

/** Язык промпта классификации по условиям сегментов: кириллица → ru. */
export function detectSegmentLanguage(segments: string[]): 'ru' | 'en' {
  return /[А-Яа-яЁё]/.test(segments.join(' ')) ? 'ru' : 'en';
}
