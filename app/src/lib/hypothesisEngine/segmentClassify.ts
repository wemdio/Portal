/**
 * Классификация строк базы по сегментам шаблона 85/15 — нужна для
 * материализации сегментных вариантов при запуске (Instantly не умеет
 * условные блоки, поэтому запуск сплитит лиды на кампании по сегментам).
 *
 * Каждая строка → условие сегмента (`when` дословно) или null (дефолтный
 * текст письма). Модель — роль gate (мини-модель, getHeModel('gate')), батчи
 * по 40 строк, до 6 параллельно. Частичные сбои переживаем (батч → лог,
 * остальные продолжаются); что значит строка без ответа — зависит от
 * контракта (ниже).
 *
 * Полнота ответа обязательна (`requireCompleteJson`) у контрактов market='us'
 * ('held', 'main'): для классификатора отремонтированный обрубок — это короткий
 * список, который выглядит уверенным. Такой батч повторяется, а если и повтор
 * обрезан — честно падает в лог. Прежний контракт RU ('default') ответ, как до
 * порта ENG (решение владельца 14.10.2026 «Как было»), не требует полным:
 * обрезанный JSON ремонтируется, разобранные строки уходят в свои сегменты,
 * остальные — в дефолтный текст.
 *
 * ДВА КОНТРАКТА (с 09.10.2026), и развилка — у вызывающего (launchTemplate.ts,
 * шаг 5c), по рынку проекта:
 *  - classifyBaseRowsIntoSegmentsDetailed — для market='us'. «Нет ответа» НЕ
 *    равно дефолтному сегменту: явный ответ модели (условие или null — «ни одно
 *    не подходит») лежит в assignments, а строки упавшего батча, строки, которые
 *    модель не разметила, и строки с условием не из списка — в unanswered.
 *    Запуск их ОТКЛАДЫВАЕТ (не шлёт дефолтный текст), а не угадывает. Плюс
 *    расход модели (usage) — его пишет аудит запуска.
 *  - heLegacySegmentAssignments поверх того же вызова (с unansweredFate
 *    'default') — прежний контракт RU-инструмента, байт в байт по поведению
 *    (до 09.10.2026 — classifyBaseRowsIntoSegments): строки без ответа уходят
 *    в дефолтный текст письма, null — только когда упали ВСЕ батчи. Промпт,
 *    батчи и модель у обоих контрактов одни.
 *
 * Третий вызывающий — ночной долив us-проекта (stages/baseCollectRefill.ts,
 * раскладка строк ночи по сегментным кампаниям запуска): тот же детальный
 * контракт market='us' с unansweredFate 'main' — строка без ответа там не
 * откладывается, а уходит в основную кампанию с основным текстом.
 */

import { z } from 'zod';
import {
  callLLMWithSchema,
  getHeModel,
  HeLlmHttpError,
  HeLlmTimeoutError,
  HeLlmTransportError,
  LLMValidationError,
  type LLMMessage,
} from './llm';

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
  /** Куда писать о сбоях батчей; по умолчанию — console.warn процесса. */
  log?: (msg: string) => void;
}

/** Расход модели классификатора: удачные ответы + оплаченные и отброшенные попытки. */
export interface SegmentClassifyUsage {
  tokensUsed: number;
  costUsd: number;
}

/**
 * Полный результат классификации (контракт market='us', см. шапку).
 *
 * assignments — только ЯВНЫЕ ответы модели: условие сегмента (дословно, как в
 * шаблоне) или null — «ни одно условие не подходит», то есть дефолтный текст
 * по решению модели. unanswered — индексы строк без годного ответа (батч упал,
 * строка не размечена, условие не из списка, пустая строка вместо null); они
 * НИКОГДА не маскируются под дефолт.
 */
export interface HeSegmentClassification {
  assignments: Map<number, string | null>;
  unanswered: number[];
  failedBatches: number;
  totalBatches: number;
  /** Класс сбоя каждого упавшего батча (failureLabel) — для аудита запуска. */
  failureKinds: string[];
  usage: SegmentClassifyUsage;
}

/**
 * Что вызывающий сделает со строкой без ответа — от этого зависит только
 * хвост строки лога: 'default' (RU-контракт, строка уйдёт в дефолтный текст),
 * 'held' (us-контракт запуска, строка отложена до следующего запуска) или
 * 'main' (ночной долив us, stages/baseCollectRefill.ts: строка без ответа
 * уходит в основную кампанию с основным текстом). Результат у 'held' и 'main'
 * один и тот же — различается только текст строки лога.
 */
type UnansweredFate = 'default' | 'held' | 'main';

/**
 * Класс сбоя батча — по ТИПУ ошибки, а не по её тексту (см. llm.ts). В логе это
 * разные новости: `rate_limit` и `transient` значат «повторите запуск», а
 * `billing`/`configuration` — «повтор не поможет, нужен человек». Без класса в
 * строке лога оба выглядели одинаково — «батч упал».
 */
function failureLabel(error: unknown): string {
  if (error instanceof HeLlmHttpError) return `${error.kind}, HTTP ${error.status}`;
  if (error instanceof HeLlmTransportError) return error.kind;
  if (error instanceof HeLlmTimeoutError) return 'timeout';
  // Сюда попадает и неполный (обрезанный) ответ: полнота для классификатора
  // обязательна, и её отсутствие — не «сеть», а ответ модели.
  if (error instanceof LLMValidationError) return 'invalid_answer';
  return 'unknown';
}

/**
 * Оплаченное и выброшенное внутри llm.ts, когда вызов в итоге отказал
 * (копия правила relevanceGate.discardedSpendOf): канал единственный и он
 * текстовый — LLMValidationError несёт свою сумму строкой в сообщении. Разбор
 * ТОЛЬКО ради бухгалтерии: ни одно решение здесь на текст не опирается. Не
 * нашли — ноль, а не выдумка.
 */
function discardedSpendOf(error: unknown): SegmentClassifyUsage {
  const match = /\[оплачено и отброшено: (\d+) tok, \$([\d.]+)\]/.exec(
    error instanceof Error ? error.message : '',
  );
  if (!match) return { tokensUsed: 0, costUsd: 0 };
  const tokensUsed = Number(match[1]);
  const costUsd = Number(match[2]);
  return {
    tokensUsed: Number.isFinite(tokensUsed) ? tokensUsed : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
  };
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
 * Классифицировать строки — полный результат (контракт market='us', см.
 * шапку). Промпт, батчи, модель и требование полноты — те же, что у
 * прежнего контракта: он теперь обёртка над этой функцией.
 *
 * Повторный ответ по одной строке: условие сегмента перекрывает прежний ответ,
 * явный null — только если ответа по строке ещё нет. Так прежний контракт
 * (heLegacySegmentAssignments) остаётся прежним и на этом крае: у
 * classifyBaseRowsIntoSegments null никогда не стирал уже названный сегмент.
 */
export async function classifyBaseRowsIntoSegmentsDetailed(
  input: SegmentClassifyInput & { unansweredFate?: UnansweredFate },
): Promise<HeSegmentClassification> {
  const { rows, segments, language } = input;
  const fate: UnansweredFate = input.unansweredFate ?? 'held';
  // Путь запуска (launchTemplate) лог не передаёт, а молчащий сбой
  // классификатора — это тихая потеря сегментных вариантов. Поэтому по
  // умолчанию — в лог процесса (воркер/роут), а не в никуда.
  const log = input.log ?? ((msg: string) => console.warn(msg));
  const cleaned = [...new Set(segments.map((s) => s.trim()).filter(Boolean))];
  const result: HeSegmentClassification = {
    assignments: new Map(),
    unanswered: [],
    failedBatches: 0,
    totalBatches: 0,
    failureKinds: [],
    usage: { tokensUsed: 0, costUsd: 0 },
  };
  if (rows.length === 0 || cleaned.length === 0) return result;

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
  result.totalBatches = batches.length;

  for (let wave = 0; wave < batches.length; wave += CONCURRENCY) {
    const group = batches.slice(wave, wave + CONCURRENCY);
    await Promise.all(
      group.map(async (batch) => {
        try {
          const llm = await callLLMWithSchema(
            buildClassifyMessages(cleaned, batch.items, language),
            AssignmentsSchema,
            // Роль gate: присвоение сегмента — классификация, мини-модель.
            // requireCompleteJson: неполный список сегментов молча раскидал бы
            // хвост батча по дефолтному тексту (см. шапку файла). Кроме
            // прежнего контракта RU ('default'): там обрезанный ответ, как до
            // порта ENG, ремонтируется и разобранные строки уходят в сегменты.
            { model: getHeModel('gate'), maxTokens: 4096, requireCompleteJson: fate !== 'default' },
          );
          result.usage.tokensUsed += llm.tokensUsed;
          result.usage.costUsd += llm.costUsd;
          const validRows = new Set(batch.items.map((it) => it.index));
          // Любое упоминание строки — для строки лога прежнего контракта.
          const mentioned = new Set<number>();
          for (const a of llm.data.assignments) {
            if (!validRows.has(a.row)) continue;
            mentioned.add(a.row);
            if (a.segment === null) {
              if (!result.assignments.has(a.row)) result.assignments.set(a.row, null);
              continue;
            }
            const key = a.segment.trim().toLowerCase();
            if (!key) continue;
            const condition = canonical.get(key);
            if (condition) result.assignments.set(a.row, condition);
          }
          const answered = batch.items.filter((it) => result.assignments.has(it.index)).length;
          if (fate === 'default') {
            // RU-контракт, строка лога прежняя. Ответ уложился в лимит, но строки
            // в нём не все: формально это не сбой (непокрытые уедут в дефолтный
            // текст), и потому единственный способ узнать о потере — сказать о ней.
            if (mentioned.size < batch.items.length) {
              log(
                `[segmentClassify] батч ${batch.start}–${batch.start + batch.items.length - 1}: ` +
                  `модель разметила ${mentioned.size} из ${batch.items.length} строк — остальные уйдут в дефолтный текст`,
              );
            }
          } else if (answered < batch.items.length) {
            log(
              `[segmentClassify] батч ${batch.start}–${batch.start + batch.items.length - 1}: ` +
                `годный ответ по ${answered} из ${batch.items.length} строк — ` +
                (fate === 'main'
                  ? 'остальные уйдут в основную кампанию с основным текстом'
                  : 'остальные отложены, в этом запуске не уйдут'),
            );
          }
        } catch (e) {
          result.failedBatches += 1;
          result.failureKinds.push(failureLabel(e));
          const spent = discardedSpendOf(e);
          result.usage.tokensUsed += spent.tokensUsed;
          result.usage.costUsd += spent.costUsd;
          log(
            `[segmentClassify] батч ${batch.start}–${batch.start + batch.items.length - 1} упал ` +
              `[${failureLabel(e)}]: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  rows.forEach((_, index) => {
    if (!result.assignments.has(index)) result.unanswered.push(index);
  });
  return result;
}

/**
 * Прежний контракт из полного результата: Map «строка → условие сегмента»
 * (явный null и строки без ответа в Map не попадают = дефолтный текст); null
 * — системный сбой, упали ВСЕ батчи. Читатель — запуск RU-проекта
 * (launchTemplate.ts, шаг 5c): ему нужен и прежний результат, и расход для
 * аудита.
 */
export function heLegacySegmentAssignments(detailed: HeSegmentClassification): Map<number, string> | null {
  if (detailed.totalBatches > 0 && detailed.failedBatches === detailed.totalBatches) return null;
  const result = new Map<number, string>();
  for (const [row, segment] of detailed.assignments) {
    if (segment !== null) result.set(row, segment);
  }
  return result;
}

/** Язык промпта классификации по условиям сегментов: кириллица → ru. */
export function detectSegmentLanguage(segments: string[]): 'ru' | 'en' {
  return /[А-Яа-яЁё]/.test(segments.join(' ')) ? 'ru' : 'en';
}
