/**
 * Кейс-банк «Движка вертикалей» (ve_cases): доказательные кейсы КЛИЕНТА,
 * которые подставляются в цепочки/шаблоны как proof под конкретную вертикаль.
 *
 * Источники кейсов (колонка source):
 *  - 'site'   — извлечены стадией site_profile из текста сайта клиента
 *               (refresh атомарный: insert новых → delete устаревших site-строк);
 *  - 'upload' — вставлены специалистом текстом через API
 *               (POST projects/[id]/cases); сайт-стадия их никогда не трогает.
 *
 * Здесь же живут:
 *  - heCaseDraftSchema — zod-схема структурированного кейса (локальная для
 *    кейс-банка, НЕ из schemas.ts): industry/client_type/task/metrics/result/text;
 *  - structureCaseText — LLM-структуризация вставленного текста кейса
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

const CASE_STRUCTURING_SYSTEM = `Ты — аналитик B2B-кейсов агентства Polza. Из сырого текста кейса (вставка из PDF/документа/письма) ты достаёшь структуру для кейс-банка: она пойдёт в письма как доказательство, поэтому точность критична.

Жёсткие правила:
- опирайся ТОЛЬКО на переданный текст — ничего не додумывай;
- никаких выдуманных цифр: metrics заполняй только числами, которые буквально есть в тексте (если их нет — пустой объект);
- если какого-то поля в тексте нет — пустая строка, а не догадка.

Отвечай строго на русском.`;

function buildCaseStructuringMessages(rawText: string): LLMMessage[] {
  const user = `ТЕКСТ КЕЙСА (может быть выгрузкой из PDF/документа):
"""
${rawText}
"""

Разбери кейс и верни ТОЛЬКО JSON строго такого вида (без markdown-фенсов и пояснений):
{
  "industry": string,     // индустрия/отрасль клиента из кейса (как названа в тексте)
  "client_type": string,  // тип/размер клиента (напр. «сеть кофеен, 40 точек», «enterprise-банк»)
  "task": string,         // задача клиента, 1 предложение
  "metrics": object,      // свободный json: ТОЛЬКО конкретные цифры из текста, напр. {"рост_конверсии": "+32%", "срок": "2 месяца"}; нет цифр — {}
  "result": string,       // достигнутый результат, 1 предложение, с опорой на цифры из текста, если они есть
  "text": string          // краткое содержание кейса: 2–3 предложения (кто клиент, что сделали, что получили)
}

Никакого текста вне JSON.`;

  return [
    { role: 'system', content: CASE_STRUCTURING_SYSTEM },
    { role: 'user', content: user },
  ];
}

/**
 * Структурировать вставленный текст кейса через LLM (роль gate — мини-модель).
 * Бросает LLMValidationError при двойном невалидном ответе — роут маппит в 502.
 */
export async function structureCaseText(rawText: string): Promise<VeCaseDraft> {
  const llm = await callLLMWithSchema(buildCaseStructuringMessages(rawText), heCaseDraftSchema, {
    model: getVeModel('gate'),
    maxTokens: 2048,
  });
  return llm.data;
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
