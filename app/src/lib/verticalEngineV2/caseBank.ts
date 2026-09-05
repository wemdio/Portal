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

const veCaseSourceDraftSchema = veCaseImportDraftSchema.omit({ text: true }).extend({
  source_start: z.number().int().min(1),
  source_end: z.number().int().min(1),
});

const veCaseImportSchema = z.object({
  has_more: z.boolean(),
  cases: z.array(veCaseSourceDraftSchema).max(MAX_CASES_PER_IMPORT),
});

interface CaseSourcePart {
  id: number;
  start: number;
  end: number;
  text: string;
  recommendation: boolean;
}

/** Narrow labels mark operator suggestions, never factual customer outcomes. */
function isCaseRecommendation(text: string): boolean {
  const unmarked = text.replace(/^[\s#>*_-]+/u, '');
  return /^(?:хорошо\s+использовать\s+для(?=\s|:|$)|рекомендуемые\s+сегменты\s*:)/iu.test(unmarked);
}

/**
 * Addressable source parts, not case boundaries. A case may span many parts.
 * Cutting after sentence punctuation also handles several cases on one line;
 * decimal dots stay inside their part because no whitespace follows them.
 */
function caseSourceParts(rawText: string): CaseSourcePart[] {
  const parts: CaseSourcePart[] = [];
  let start = 0;
  const append = (end: number) => {
    while (start < end && /\s/u.test(rawText[start])) start++;
    let trimmedEnd = end;
    while (trimmedEnd > start && /\s/u.test(rawText[trimmedEnd - 1])) trimmedEnd--;
    if (trimmedEnd > start) {
      const text = rawText.slice(start, trimmedEnd);
      parts.push({ id: parts.length + 1, start, end: trimmedEnd, text, recommendation: isCaseRecommendation(text) });
    }
    start = end;
  };
  for (let index = 0; index < rawText.length; index++) {
    const char = rawText[index];
    if (char === '\r' || char === '\n' || (/[.!?;]/u.test(char) && (index + 1 === rawText.length || /\s/u.test(rawText[index + 1])))) {
      append(index + 1);
    }
  }
  append(rawText.length);
  return parts;
}

const CASE_STRUCTURING_SYSTEM = `Ты — аналитик B2B-кейсов агентства Polza. Из сырого текста (вставка из PDF/документа/письма) выделяй ОТДЕЛЬНЫЕ клиентские проекты. Кейсы пойдут в письма как доказательство, поэтому точность критична.

Жёсткие правила:
- опирайся ТОЛЬКО на переданный текст — ничего не додумывай;
- один кейс — одна конкретная работа для одного клиента. В одной вставке может быть несколько кейсов: верни отдельный объект для каждого;
- абзацы, пункты «задача / решение / результат» и переносы страниц сами по себе НЕ делят кейс. Не делай отдельный кейс из каждого абзаца или показателя;
- не смешивай клиентов, задачи, результаты и цифры разных проектов. Не объединяй разные работы только потому, что у них одна отрасль;
- кейс должен содержать контекст клиента, конкретную выполненную работу и фактический результат. Сам выпуск изделий, их комплектация, упаковка и решённая логистическая проблема — уже результат; не требуй выручку, проценты роста или «бизнес-эффект», которых нет в тексте;
- client_type: если назван клиент, ОБЯЗАТЕЛЬНО сохрани его имя; не заменяй название общим сегментом. Тип клиента можно дополнить только когда он прямо указан;
- industry: фактическая отрасль клиента, а не сегмент для будущих продаж. Если отрасль не названа — пустая строка. Одного имени клиента достаточно, чтобы сохранить кейс без отрасли;
- task: что конкретно сделали для клиента. result: что фактически изготовили, упаковали, доставили или какую проблему решили. «Проект выполнен», «заказ исполнен» и подобные общие фразы теряют содержание — не используй их вместо результата;
- в task обязательно сохраняй указанное фактическое назначение работы/изделий и для какой аудитории или события это было сделано. Не путай реальное назначение выполненного заказа с рекомендациями для будущих продаж;
- сохрани все существенные исходные детали в task/result/metrics: тираж, количество изделий в наборе, материал/покрытие, формат, срок с единицами (например рабочие дни), индивидуальную упаковку и логистику. Не своди разные числа в одно и не теряй характеристики без цифр;
- явно помеченные РЕКОМЕНДАЦИИ («Хорошо использовать для…», «Рекомендуемые сегменты:…») — предложения специалиста о будущем применении кейса. Они НЕ подтверждают отрасль клиента, выполненную работу или результат. Не переноси их в industry/client_type/task/result/metrics и не используй цифры из этих заметок как достигнутые показатели;
- никаких выдуманных цифр: metrics заполняй только числами, которые буквально есть в ИСХОДНОМ ФРАГМЕНТЕ ЭТОГО кейса (если их нет — пустой объект). Значения metrics — строки с цифрами или числа, не вложенные объекты;
- исходник разбит на пронумерованные ЧАСТИ. Это адреса строк/предложений, НЕ готовые кейсы. Для каждого кейса верни source_start/source_end — ID первой и последней части ВКЛЮЧИТЕЛЬНО. Используй только существующие целые ID; диапазоны кейсов не пересекаются;
- диапазон обязан включать ВЕСЬ кейс: заголовок с клиентом, все предложения выполненной работы/результата и заключительные рекомендации, если они есть. Рекомендации сохраняются в оригинале для специалиста, хотя не являются фактами в полях. Не обрезай кейс до одного предложения и не захватывай начало следующего клиента;
- поле text НЕ возвращай и исходник НЕ переписывай: сервер сам возьмёт точный исходный диапазон по ID, без переформулировок;
- если конкретных кейсов нет — верни пустой массив; не выдумывай недостающие факты ради заполнения;
- максимум ${MAX_CASES_PER_IMPORT} кейсов за один раз. Если во вставке больше конкретных кейсов, обязательно верни has_more=true: весь разбор будет остановлен с просьбой разделить текст. Нельзя молча вернуть первые ${MAX_CASES_PER_IMPORT}; если все кейсы вошли, has_more=false.

Отвечай строго на русском.`;

function buildCaseStructuringMessages(parts: CaseSourcePart[]): LLMMessage[] {
  const user = `ИСХОДНЫЕ ЧАСТИ КЕЙСОВ (ID в квадратных скобках — адрес, а не факт о кейсе):
${parts.map((part) => `[${part.id}]${part.recommendation ? ' [РЕКОМЕНДАЦИЯ, НЕ ФАКТ]' : ''} ${part.text}`).join('\n')}

Раздели самостоятельные проекты и верни ТОЛЬКО JSON такого вида (без markdown-фенсов и пояснений):
{
  "has_more": boolean, // true, если конкретных кейсов во вставке больше ${MAX_CASES_PER_IMPORT}; иначе false
  "cases": [
    {
      "industry": string,     // отрасль клиента из этого кейса, если названа
      "client_type": string,  // сохрани имя клиента, если оно названо; не заменяй сегментом
      "task": string,         // конкретная выполненная работа со значимыми характеристиками
      "metrics": object,      // только реальные цифры этого кейса с единицами; не цифры из рекомендаций; нет цифр — {}
      "result": string,       // конкретный выпуск / упаковка / логистика / другой результат без общих заглушек
      "source_start": integer, // ID первой части: с заголовком клиента
      "source_end": integer    // ID последней части ВКЛЮЧИТЕЛЬНО: с финальными заметками кейса
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
    const originalParts = caseSourceParts(original);
    const facts = originalParts.filter((part) => !part.recommendation).map((part) => part.text).join('\n');
    const recommendations = normalizeCaseText(originalParts.filter((part) => part.recommendation).map((part) => part.text).join('\n'));
    if (draft.industry && recommendations.includes(normalizeCaseText(draft.industry)) && !normalizeCaseText(facts).includes(normalizeCaseText(draft.industry))) {
      throw new Error(`${label}: отрасль взята из рекомендации, а не из фактов о клиенте`);
    }
    const genericResult = /^(?:проект|заказ|работа)\s+(?:успешно\s+)?(?:выполнен[ао]?|заверш[её]н[ао]?|исполнен[ао]?)[.!]?$/iu;
    if (isCaseRecommendation(draft.task) || isCaseRecommendation(draft.result) || genericResult.test(draft.result)) {
      throw new Error(`${label}: укажите фактически выполненную работу и конкретный результат`);
    }
    const supportedNumbers = new Set(numericTokens(facts));
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
  const parts = caseSourceParts(rawText);
  const llm = await callLLMWithSchema(buildCaseStructuringMessages(parts), veCaseImportSchema, {
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
  // Validate again at this boundary; neither a typed model response nor a mock
  // proves that IDs are actual integers within this source's bounds.
  const parsed = veCaseImportSchema.safeParse(llm.data);
  if (!parsed.success) throw new Error('Не удалось определить границы кейсов в исходном тексте');
  const spans: Array<{ start: number; end: number }> = [];
  const drafts = parsed.data.cases.map(({ source_start: start, source_end: sourceEnd, ...draft }, index) => {
    if (start > sourceEnd || sourceEnd > parts.length) {
      throw new Error(`Кейс ${index + 1}: границы исходного текста некорректны`);
    }
    // Models often stop at the last fact even when asked to retain notes.
    // Attach only immediately adjacent explicitly labelled recommendations;
    // never skip a factual part or move across the next client's heading.
    let end = sourceEnd;
    while (end < parts.length && parts[end].recommendation) end++;
    if (spans.some((span) => start <= span.end && end >= span.start)) {
      throw new Error(`Кейс ${index + 1}: границы исходного текста пересекаются`);
    }
    spans.push({ start, end });
    return { ...draft, text: rawText.slice(parts[start - 1].start, parts[end - 1].end) };
  });
  return validateCaseDrafts(rawText, drafts);
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
