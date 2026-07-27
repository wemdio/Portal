/**
 * Кейс-банк «Движка вертикалей» (he_cases): доказательные кейсы КЛИЕНТА,
 * которые подставляются в цепочки/шаблоны как proof под конкретную вертикаль.
 *
 * Источники кейсов (колонка source):
 *  - 'site'   — извлечены стадией site_profile из текста сайта клиента
 *               (replace-on-rerun: стадия сносит старые site-кейсы проекта);
 *  - 'upload' — вставлены специалистом текстом через API
 *               (POST projects/[id]/cases); сайт-стадия их никогда не трогает.
 *
 * Здесь же живут:
 *  - heCaseDraftSchema — zod-схема структурированного кейса (локальная для
 *    кейс-банка, НЕ из schemas.ts): industry/client_type/task/metrics/result/text;
 *  - structureCaseText — LLM-структуризация вставленного текста кейса
 *    (общий хелпер для API-роута загрузки; модель getHeModel('bulk'));
 *  - scoreCaseForVertical / selectCaseForVertical — подбор кейса под вертикаль
 *    (токен-оверлап названия+синонимов вертикали по industry/client_type/task);
 *  - renderClientCaseBlock — блок «КЕЙС КЛИЕНТА …» для промптов chain/template.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { callLLMWithSchema, getHeModel, type LLMMessage } from './llm';

/* ─────────────────────────── Типы ─────────────────────────── */

export type HeCaseSource = 'site' | 'upload';

/** Строка he_cases (миграция создаётся параллельно этому коду). */
export interface HeCase {
  id: string;
  project_id: string;
  source: HeCaseSource;
  filename: string | null;
  industry: string;
  client_type: string;
  task: string;
  /** Свободный json: найденные в кейсе конкретные цифры/метрики. */
  metrics: Record<string, unknown>;
  result: string;
  /** 2–3 предложения — краткое содержание кейса. */
  text: string;
  created_at: string;
}

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
export type HeCaseDraft = z.infer<typeof heCaseDraftSchema>;

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
 * Структурировать вставленный текст кейса через LLM (bulk-модель).
 * Бросает LLMValidationError при двойном невалидном ответе — роут маппит в 502.
 */
export async function structureCaseText(rawText: string): Promise<HeCaseDraft> {
  const llm = await callLLMWithSchema(buildCaseStructuringMessages(rawText), heCaseDraftSchema, {
    model: getHeModel('bulk'),
    maxTokens: 2048,
  });
  return llm.data;
}

/* ─────────────────── Подбор кейса под вертикаль ─────────────────── */

/** Стоп-слова, не несущие смысла при токен-оверлапе (ru/en предлоги/союзы). */
const STOP_TOKENS = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'от', 'до', 'из', 'за', 'у', 'о', 'об', 'к',
  'the', 'of', 'and', 'in', 'on', 'for', 'to', 'a', 'an', 'or', 'at',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length >= 2 && !STOP_TOKENS.has(t));
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

/**
 * Скор релевантности кейса вертикали: число уникальных токенов названия
 * вертикали + синонимов, встречающихся в industry/client_type/task кейса
 * (lowercase, токены ≥2 символов, без стоп-слов). 0 — кейс не релевантен.
 */
export function scoreCaseForVertical(target: CaseScoreTarget, vertical: VerticalScoreInput): number {
  const verticalTokens = new Set(
    tokenize([vertical.name, ...(vertical.synonyms ?? [])].filter(Boolean).join(' ')),
  );
  if (!verticalTokens.size) return 0;
  const caseTokens = new Set(
    tokenize([target.industry ?? '', target.client_type ?? '', target.task ?? ''].join(' ')),
  );
  let score = 0;
  for (const token of verticalTokens) {
    if (caseTokens.has(token)) score++;
  }
  return score;
}

/**
 * Лучший кейс проекта под вертикаль: max score, минимум 1; при равенстве —
 * самый ранний по created_at (запрос отсортирован по возрастанию). null, если
 * релевантных кейсов нет (в промпты тогда ничего не инжектится — fallback на
 * кейсы из брифа, см. промпты chain/template).
 */
export async function selectCaseForVertical(
  supabase: SupabaseClient,
  projectId: string,
  vertical: VerticalScoreInput,
): Promise<HeCase | null> {
  const { data, error } = await supabase
    .from('he_cases')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`he_cases read: ${error.message}`);

  let best: HeCase | null = null;
  let bestScore = 0;
  for (const row of (data ?? []) as HeCase[]) {
    const score = scoreCaseForVertical(row, vertical);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 1 ? best : null;
}

/* ─────────────────── Рендер блока для промптов ─────────────────── */

/**
 * Блок «КЕЙС КЛИЕНТА» для материалов промптов chain/template. Заголовок
 * фиксирован — промпт-правила ссылаются на него дословно.
 */
export function renderClientCaseBlock(caseData: HeCaseDraft): string {
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
