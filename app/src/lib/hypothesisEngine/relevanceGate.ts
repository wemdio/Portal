/**
 * Релевант-гейт строк автосборки «Движка вертикалей». Источники тащат шум:
 * hh full-text вернёт любую компанию, чья вакансия упомянула слово; карты —
 * рубричный шум; реестр — самодекларированные ОКВЭД. До запуска строки
 * проверяются дешёвой LLM-проверкой (bulk-модель, батчи по 50): «компания ∈
 * вертикаль?». Помеченные нерелевантными строки остаются в базе для
 * прозрачности, но не уходят в запуск (фильтр в launchTemplate).
 *
 * Never-throw: сбой батча → его строки без пометок, остальные продолжаются;
 * сборка базы гейтом не валится никогда.
 */

import { z } from 'zod';
import { callLLMWithSchema, getHeModel, type LLMMessage } from './llm';

/** Строк в одном вызове (≈2-3k токенов); выше — растёт цена и риск усечения. */
const BATCH_SIZE = 50;
/** Сколько первых строк базы проверяем (запуск капнут 2000 — покрытие полное). */
const MAX_ROWS_TO_CHECK = Number(process.env.HE_RELEVANCE_MAX_ROWS) || 3000;

const RelevanceSchema = z.object({
  /** Индексы нерелевантных строк (0-based, из входного батча). */
  irrelevant: z.array(z.number().int()).default([]),
});

export interface HeRelevanceGateResult {
  /** Глобальные индексы нерелевантных строк (во входном массиве rows). */
  flagged: Set<number>;
  tokensUsed: number;
  costUsd: number;
}

function buildRelevanceMessages(
  verticalName: string,
  verticalSummary: string,
  batch: Array<{ i: number; company: string; website: string; category: string; vacancy_title: string }>,
  language: 'ru' | 'en',
): LLMMessage[] {
  const rowsJson = JSON.stringify(batch);
  if (language === 'en') {
    return [
      {
        role: 'system',
        content:
          'You filter a collected lead base for one market vertical. A row is relevant only if the company itself plausibly belongs to the vertical (not merely mentions it in a vacancy or sells to it). Answer strictly in JSON.',
      },
      {
        role: 'user',
        content: `Vertical: «${verticalName}»${verticalSummary ? ` — ${verticalSummary}` : ''}\n\nRows (i + fields):\n${rowsJson}\n\nReturn JSON {"irrelevant": [<i>, ...]} with the indices of rows whose company clearly does NOT belong to this vertical. When in doubt — keep the row (do not list it).`,
      },
    ];
  }
  return [
    {
      role: 'system',
      content:
        'Ты фильтруешь собранную базу лидов под одну вертикаль рынка. Строка релевантна, только если сама компания правдоподобно принадлежит вертикали (а не просто упоминает её в вакансии или продаёт ей). Отвечай строго в JSON.',
    },
    {
      role: 'user',
      content: `Вертикаль: «${verticalName}»${verticalSummary ? ` — ${verticalSummary}` : ''}\n\nСтроки (i + поля):\n${rowsJson}\n\nВерни JSON {"irrelevant": [<i>, ...]} с индексами строк, чья компания явно НЕ принадлежит вертикали. Сомневаешься — оставляй строку (в список не включай).`,
    },
  ];
}

/**
 * Найти нерелевантные строки среди первых MAX_ROWS_TO_CHECK. Каждая строка —
 * компактный набор полей (company/website/category/vacancy_title достаточно).
 */
export async function findIrrelevantRows(input: {
  rows: Array<Record<string, unknown>>;
  verticalName: string;
  verticalSummary?: string;
  language: 'ru' | 'en';
  log?: (msg: string) => void;
}): Promise<HeRelevanceGateResult> {
  const { rows, verticalName, verticalSummary = '', language, log } = input;
  const result: HeRelevanceGateResult = { flagged: new Set<number>(), tokensUsed: 0, costUsd: 0 };
  const checked = rows.slice(0, MAX_ROWS_TO_CHECK);
  if (checked.length === 0 || !verticalName.trim()) return result;

  for (let start = 0; start < checked.length; start += BATCH_SIZE) {
    const batch = checked.slice(start, start + BATCH_SIZE).map((r, i) => ({
      i: start + i,
      company: String(r.company ?? '').slice(0, 120),
      website: String(r.website ?? '').slice(0, 80),
      category: String(r.category ?? '').slice(0, 80),
      vacancy_title: String(r.vacancy_title ?? '').slice(0, 80),
    }));
    try {
      const llm = await callLLMWithSchema(
        buildRelevanceMessages(verticalName, verticalSummary, batch, language),
        RelevanceSchema,
        // Роль gate: мини-модель — бинарная классификация строк не требует
        // reasoning; на нём только тратились выходные токены и ловились
        // усечения max_tokens (finish_reason='length').
        { model: getHeModel('gate'), maxTokens: 2048 },
      );
      // Защита от мусорного ответа (моки/обрезка): без массива irrelevant
      // батч пропускаем, расход не считаем.
      const irrelevant = Array.isArray((llm.data as { irrelevant?: unknown[] } | undefined)?.irrelevant)
        ? (llm.data as { irrelevant: unknown[] }).irrelevant
        : null;
      if (!irrelevant) {
        log?.(`[relevanceGate] батч ${start}–${start + batch.length - 1}: ответ без irrelevant — пропуск`);
        continue;
      }
      result.tokensUsed += llm.tokensUsed;
      result.costUsd += llm.costUsd;
      for (const idx of irrelevant) {
        if (typeof idx === 'number' && idx >= start && idx < start + batch.length) result.flagged.add(idx);
      }
    } catch (e) {
      log?.(
        `[relevanceGate] батч ${start}–${start + batch.length - 1} пропущен: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return result;
}
