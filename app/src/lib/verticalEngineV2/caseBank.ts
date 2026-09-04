/**
 * Кейс-банк «Движка вертикалей» (ve_cases): доказательные кейсы КЛИЕНТА,
 * которые подставляются в цепочки/шаблоны как proof под конкретную вертикаль.
 *
 * Источники кейсов (колонка source):
 *  - 'site'   — извлечены стадией site_profile из текста сайта клиента
 *               (insert недостающих → delete старых site-строк и дубликатов);
 *  - 'upload' — вставлены специалистом текстом через API
 *               (POST projects/[id]/cases); сайт-стадия их никогда не трогает.
 *
 * Здесь же живут:
 *  - heCaseDraftSchema — zod-схема структурированного кейса (локальная для
 *    кейс-банка, НЕ из schemas.ts): industry/client_type/task/metrics/result/text;
 *  - structureCaseTexts — разбор вставки на отдельные кейсы с исходниками
 *    (общий хелпер для API-роута загрузки; модель getVeModel('gate'));
 *  - scoreCaseForVertical / selectCaseForVertical — подбор кейса под вертикаль
 *    (взвешенный токен-оверлап названия+синонимов вертикали по полям
 *    industry/client_type/task, порог MIN_CASE_SCORE, tie-break upload);
 *  - normalizeCaseText — нормализация текста кейса для дедупа;
 *  - renderClientCaseBlock — блок «КЕЙС КЛИЕНТА …» для промптов chain/template.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { callLLMWithSchema, getVeModel, type LLMMessage } from './llm';
import type { VeCase } from './types';

/* ─────────────────────────── Типы ─────────────────────────── */

/**
 * Строка ve_cases — единственный источник правды в types.ts (DB-аккуратный:
 * nullable-поля + updated_at). Ре-экспорт сохраняет существующие импорты
 * (stages/chain и stages/template берут VeCase отсюда).
 */
export type { VeCase } from './types';

/* ─────────────────── LLM-структуризация кейса ─────────────────── */

/**
 * Структурированный черновик кейса (до записи в БД). Схема намеренно
 * локальная (не в schemas.ts): это вспомогательная LLM-структура кейс-банка.
 * metrics — свободный json (ключ → значение), ТОЛЬКО реально найденные цифры.
 */
export const heCaseDraftSchema = z.object({
  industry: z.string().default(''),
  client_type: z.string().default(''),
  task: z.string().default(''),
  metrics: z.record(z.string(), z.unknown()).default({}),
  result: z.string().default(''),
  text: z.string(),
});

/**
 * Черновик кейса на границе промптов/рендера. Поля nullable: тип покрывает и
 * выход heCaseDraftSchema (LLM-драфт, пустые строки — z.infer сюда assignable),
 * и строку ve_cases (null из БД) — stages/chain и stages/template передают в
 * промпты VeCase напрямую. renderClientCaseBlock отрабатывает пустые/null.
 */
export interface VeCaseDraft {
  industry: string | null;
  client_type: string | null;
  task: string | null;
  metrics: Record<string, unknown>;
  result: string | null;
  text: string | null;
}

export const MAX_CASE_TEXT_CHARS = 20000;
export const MAX_CASES_PER_IMPORT = 20;

/** Safe, user-facing explanation; no provider payload or secrets. */
export class VeCaseImportIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeCaseImportIncompleteError';
  }
}

/** Manual imports preserve the source; site/legacy drafts still use summaries. */
export const veCaseImportDraftSchema = z.object({
  industry: z.string().trim().max(300).default(''),
  client_type: z.string().trim().max(500).default(''),
  task: z.string().trim().min(1).max(1500),
  metrics: z.record(z.string().max(100), z.union([z.string().trim().max(300), z.number().finite()]))
    .refine((value) => Object.keys(value).length <= 20, 'Слишком много метрик').default({}),
  result: z.string().trim().min(1).max(1500),
  text: z.string().trim().min(20).max(MAX_CASE_TEXT_CHARS),
});

const veCaseImportSchema = z.object({
  has_more: z.boolean(),
  cases: z.array(veCaseImportDraftSchema).max(MAX_CASES_PER_IMPORT),
});

const CASE_STRUCTURING_SYSTEM = `Ты — аналитик B2B-кейсов агентства Polza. Из сырого текста (вставка из PDF/документа/письма) выделяй ОТДЕЛЬНЫЕ клиентские проекты. Кейсы пойдут в письма как доказательство, поэтому точность критична.

Жёсткие правила:
- опирайся ТОЛЬКО на переданный текст — ничего не додумывай;
- один кейс — одна конкретная работа для одного клиента. В одной вставке может быть несколько кейсов: верни отдельный объект для каждого;
- абзацы, пункты «задача / решение / результат» и переносы страниц сами по себе НЕ делят кейс. Не делай отдельный кейс из каждого абзаца или показателя;
- не смешивай клиентов, задачи, результаты и цифры разных проектов. Не объединяй разные работы только потому, что у них одна отрасль;
- кейс должен содержать контекст клиента, конкретную задачу и достигнутый результат. Если их нет, не создавай пустую карточку. Рекламные обещания, списки отраслей и логотипов — не кейсы;
- industry и client_type заполняй только из текста; если одно поле неизвестно — пустая строка. Если неизвестны оба — пропусти кейс;
- никаких выдуманных цифр: metrics заполняй только числами, которые буквально есть в ИСХОДНОМ ФРАГМЕНТЕ ЭТОГО кейса (если их нет — пустой объект). Значения metrics — строки с цифрами или числа, не вложенные объекты;
- text — дословный непрерывный фрагмент исходной вставки, включающий клиента, задачу и результат только этого кейса. НЕ пересказ и НЕ сокращение; не исправляй написание. Исходные фрагменты разных кейсов не должны пересекаться;
- если конкретных кейсов нет — верни пустой массив; не выдумывай недостающие факты ради заполнения;
- максимум ${MAX_CASES_PER_IMPORT} кейсов за один раз. Если во вставке больше конкретных кейсов, обязательно верни has_more=true: весь разбор будет остановлен с просьбой разделить текст. Нельзя молча вернуть первые ${MAX_CASES_PER_IMPORT}; если все кейсы вошли, has_more=false.

Отвечай строго на русском.`;

function buildCaseStructuringMessages(rawText: string): LLMMessage[] {
  const user = `ИСХОДНЫЙ ТЕКСТ КЕЙСОВ (может быть выгрузкой из PDF/документа):
"""
${rawText}
"""

Раздели самостоятельные проекты и верни ТОЛЬКО JSON такого вида (без markdown-фенсов и пояснений):
{
  "has_more": boolean, // true, если конкретных кейсов во вставке больше ${MAX_CASES_PER_IMPORT}; иначе false
  "cases": [
    {
      "industry": string,     // отрасль клиента из этого кейса, если названа
      "client_type": string,  // название / тип клиента из этого кейса, если названы
      "task": string,         // конкретная задача клиента
      "metrics": object,      // только цифры этого кейса, например {"тираж": 3000, "срок": "2 недели"}; нет цифр — {}
      "result": string,       // конкретный достигнутый результат
      "text": string          // дословный исходный фрагмент целого кейса, НЕ краткое содержание
    }
  ]
}

Если кейсов нет — {"has_more": false, "cases": []}. Никакого текста вне JSON.`;

  return [
    { role: 'system', content: CASE_STRUCTURING_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** Collapse whitespace while retaining offsets into the original submitted text. */
function indexedSource(text: string): { text: string; offsets: number[] } {
  let normalized = '';
  const offsets: number[] = [];
  let whitespace = false;
  for (let index = 0; index < text.length; index++) {
    if (/\s/u.test(text[index])) {
      if (!whitespace) { normalized += ' '; offsets.push(index); }
      whitespace = true;
    } else {
      normalized += text[index];
      offsets.push(index);
      whitespace = false;
    }
  }
  return { text: normalized, offsets };
}

function numericTokens(text: string): string[] {
  return [...text.matchAll(/\d+(?:[ \u00a0\u202f]\d{3})*(?:[.,]\d+)?/g)]
    .map(([number]) => number.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
}

function validateRawCaseText(rawText: string): void {
  if (typeof rawText !== 'string' || !rawText.trim()) throw new Error('Вставьте исходный текст кейсов');
  if (rawText.length > MAX_CASE_TEXT_CHARS) throw new Error(`Максимум ${MAX_CASE_TEXT_CHARS} символов за один раз`);
}

/**
 * Same checks for preview and save. Provenance and numeric presence are verified;
 * semantic attribution still needs the specialist's review before saving.
 */
export function validateCaseDrafts(rawText: string, value: unknown): VeCaseDraft[] {
  validateRawCaseText(rawText);
  const parsed = z.array(veCaseImportDraftSchema).max(MAX_CASES_PER_IMPORT).safeParse(value);
  if (!parsed.success) throw new Error('Не удалось выделить полноценные кейсы: проверьте задачу, результат и исходный фрагмент');
  const source = indexedSource(rawText);
  const spans: Array<{ start: number; end: number }> = [];
  const missing = /^(?:нет(?: данных)?|не (?:указан[аоы]?|известн[аоы]?)|unknown|n\/?a|[-—])$/i;
  return parsed.data.map((draft, index) => {
    const label = `Кейс ${index + 1}`;
    if ((!draft.industry || missing.test(draft.industry)) && (!draft.client_type || missing.test(draft.client_type))) {
      throw new Error(`${label}: не указан клиент или его отрасль`);
    }
    if (missing.test(draft.task) || missing.test(draft.result)) throw new Error(`${label}: нужны конкретные задача и результат`);
    const fragment = draft.text.replace(/\s+/g, ' ');
    const start = source.text.indexOf(fragment);
    if (start < 0) throw new Error(`${label}: исходный фрагмент не найден во вставленном тексте`);
    const end = start + fragment.length;
    if (spans.some((span) => start < span.end && end > span.start)) {
      throw new Error(`${label}: исходные фрагменты кейсов пересекаются — проверьте разделение`);
    }
    spans.push({ start, end });
    const original = rawText.slice(source.offsets[start], source.offsets[end - 1] + 1);
    const supportedNumbers = new Set(numericTokens(original));
    for (const [key, metric] of Object.entries(draft.metrics)) {
      const numbers = numericTokens(String(metric));
      if (!numbers.length || [...numbers, ...numericTokens(key)].some((number) => !supportedNumbers.has(number))) {
        throw new Error(`${label}: цифры метрики «${key}» не найдены в его исходном фрагменте`);
      }
    }
    if (numericTokens([draft.industry, draft.client_type, draft.task, draft.result].join(' '))
      .some((number) => !supportedNumbers.has(number))) {
      throw new Error(`${label}: в описании есть цифры, которых нет в его исходном фрагменте`);
    }
    return { ...draft, text: original };
  });
}

/** One bounded model call parses all engagements; saving the preview calls no model. */
export async function structureCaseTexts(rawText: string, signal?: AbortSignal): Promise<VeCaseDraft[]> {
  validateRawCaseText(rawText);
  const llm = await callLLMWithSchema(buildCaseStructuringMessages(rawText), veCaseImportSchema, {
    model: getVeModel('gate'),
    maxTokens: 14000,
    signal,
  });
  signal?.throwIfAborted();
  const response = llm.rawResponse as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  } | null;
  const choice = response?.choices?.[0];
  if (choice?.finish_reason && !['stop', 'end_turn'].includes(choice.finish_reason)) {
    throw new VeCaseImportIncompleteError('Ответ с кейсами оборвался. Разделите исходный текст на меньшие части и повторите разбор');
  }
  // The shared helper may repair invalid/truncated JSON by dropping its tail.
  // That is inappropriate for an import, which must not silently lose cases.
  if (typeof choice?.message?.content === 'string') {
    try {
      JSON.parse(choice.message.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
    } catch {
      throw new VeCaseImportIncompleteError('Ответ с кейсами неполный. Разделите исходный текст на меньшие части и повторите разбор');
    }
  }
  if (llm.data.has_more !== false) {
    throw new VeCaseImportIncompleteError(`Во вставке больше ${MAX_CASES_PER_IMPORT} кейсов или не подтверждена полнота разбора. Разделите текст на части`);
  }
  return validateCaseDrafts(rawText, llm.data.cases);
}

/* ─────────────────── Подбор кейса под вертикаль ─────────────────── */

/**
 * Стоп-слова при токен-оверлапе: ru/en предлоги/союзы + доменно-общие слова
 * («продажи», «услуги», «доставка», …) — они есть в кейсах любой индустрии
 * и не отличают одну вертикаль от другой, поэтому в скор не входят.
 */
const STOP_TOKENS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'от', 'до', 'из', 'за', 'у', 'о', 'об', 'к',
  'the', 'of', 'and', 'in', 'on', 'for', 'to', 'a', 'an', 'or', 'at',
  'продажи', 'услуги', 'клиенты', 'бизнес', 'лиды', 'заявки', 'компания', 'компании',
  'рынок', 'рост', 'доставка', 'работа', 'проект', 'решение', 'продукт',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
}

/**
 * Нормализация текста кейса для дедупа: lowercase + схлопывание пробельных
 * последовательностей. Один и тот же кейс с главной страницы и /cases
 * после нормализации совпадает.
 */
export function normalizeCaseText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface CaseScoreTarget {
  industry?: string | null;
  client_type?: string | null;
  task?: string | null;
}

export interface VerticalScoreInput {
  name: string;
  synonyms?: string[] | null;
}

/** Веса полей кейса: индустрия — самый сильный сигнал, задача — самый слабый. */
const FIELD_WEIGHTS = { industry: 3, client_type: 2, task: 1 } as const;

/**
 * Порог отбора: взвешенный скор ≥ 3 — хотя бы одно попадание в industry
 * или несколько попаданий в слабые поля (client_type + task, три task).
 * Одного generic-попадания в task недостаточно, чтобы кейс стал proof'ом цепочки.
 */
export const MIN_CASE_SCORE = 3;

/**
 * Скор релевантности кейса вертикали: по каждому уникальному токену названия
 * вертикали + синонимов суммируются веса полей, где токен встретился
 * (industry 3 / client_type 2 / task 1; lowercase, токены ≥2 символов, без
 * стоп-слов). 0 — кейс не релевантен.
 */
export function scoreCaseForVertical(target: CaseScoreTarget, vertical: VerticalScoreInput): number {
  const verticalTokens = new Set(
    tokenize([vertical.name, ...(vertical.synonyms ?? [])].filter(Boolean).join(' ')),
  );
  if (!verticalTokens.size) return 0;
  const fieldTokens: Array<[number, Set<string>]> = [
    [FIELD_WEIGHTS.industry, new Set(tokenize(target.industry ?? ''))],
    [FIELD_WEIGHTS.client_type, new Set(tokenize(target.client_type ?? ''))],
    [FIELD_WEIGHTS.task, new Set(tokenize(target.task ?? ''))],
  ];
  let score = 0;
  for (const token of verticalTokens) {
    for (const [weight, tokens] of fieldTokens) {
      if (tokens.has(token)) score += weight;
    }
  }
  return score;
}

/**
 * Лучший кейс проекта под вертикаль: max взвешенный скор, минимум
 * MIN_CASE_SCORE. Tie-break при равном скоре: source='upload' (ручная
 * загрузка важнее извлечения с сайта), затем самый ранний created_at —
 * запрос отсортирован по возрастанию, поэтому при равенстве скора и
 * источника первый встреченный и есть самый ранний. null, если релевантных
 * кейсов нет (в промпты тогда ничего не инжектится — fallback на кейсы из
 * брифа, см. промпты chain/template).
 */
export async function selectCaseForVertical(
  supabase: SupabaseClient,
  projectId: string,
  vertical: VerticalScoreInput,
): Promise<VeCase | null> {
  const { data, error } = await supabase
    .from('ve_cases')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`ve_cases read: ${error.message}`);

  let best: VeCase | null = null;
  let bestScore = 0;
  for (const row of (data ?? []) as VeCase[]) {
    const score = scoreCaseForVertical(row, vertical);
    const uploadWinsTie =
      best !== null && score === bestScore && row.source === 'upload' && best.source !== 'upload';
    if (score > bestScore || uploadWinsTie) {
      best = row;
      bestScore = score;
    }
  }
  return best !== null && bestScore >= MIN_CASE_SCORE ? best : null;
}

/* ─────────────────── Рендер блока для промптов ─────────────────── */

/**
 * Блок «КЕЙС КЛИЕНТА» для материалов промптов chain/template. Заголовок
 * фиксирован — промпт-правила ссылаются на него дословно.
 */
export function renderClientCaseBlock(caseData: VeCaseDraft): string {
  const metrics = Object.entries(caseData.metrics ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');
  return `КЕЙС КЛИЕНТА (доказательство, использовать один раз):
Индустрия: ${caseData.industry || '—'}
Тип клиента: ${caseData.client_type || '—'}
Задача: ${caseData.task || '—'}
Метрики: ${metrics || '—'}
Результат: ${caseData.result || '—'}
Описание: ${caseData.text}`;
}
