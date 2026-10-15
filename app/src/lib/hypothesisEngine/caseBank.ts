/**
 * Кейс-банк «Движка вертикалей» (he_cases): доказательные кейсы КЛИЕНТА,
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
 *    (общий хелпер для API-роута загрузки; модель getHeModel('gate'));
 *  - scoreCaseForVertical / selectCaseForVertical — подбор кейса под вертикаль
 *    (взвешенный токен-оверлап названия+синонимов вертикали по полям
 *    industry/client_type/task, порог MIN_CASE_SCORE, tie-break upload;
 *    у market='us' — английские стоп-слова и нормализация окончаний);
 *  - normalizeCaseText — нормализация текста кейса для дедупа;
 *  - renderClientCaseBlock — блок «КЕЙС КЛИЕНТА …» для промптов chain/template.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { callLLMWithSchema, getHeModel, type LLMMessage } from './llm';
import { projectMarket, type HeMarket } from './market';
import type { HeCase } from './types';

/* ─────────────────────────── Типы ─────────────────────────── */

/**
 * Строка he_cases — единственный источник правды в types.ts (DB-аккуратный:
 * nullable-поля + updated_at). Ре-экспорт сохраняет существующие импорты
 * (stages/chain и stages/template берут HeCase отсюда).
 */
export type { HeCase } from './types';

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
 * и строку he_cases (null из БД) — stages/chain и stages/template передают в
 * промпты HeCase напрямую. renderClientCaseBlock отрабатывает пустые/null.
 */
export interface HeCaseDraft {
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
 *
 * market — рынок проекта для правила учёта расхода в llm.ts: staff-роут
 * работает вне журнала ENG, и без рынка us-проект считался бы по RU-правилу.
 */
export async function structureCaseText(rawText: string, market?: HeMarket): Promise<HeCaseDraft> {
  const llm = await callLLMWithSchema(buildCaseStructuringMessages(rawText), heCaseDraftSchema, {
    model: getHeModel('gate'),
    maxTokens: 2048,
    ...(market ? { market } : {}),
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

/*
 * ── Токены ENG-проекта (he_projects.market = 'us') ──
 *
 * У ENG вертикали и кейсы английские (кейсы сайта извлекает EN-промпт
 * site_profile), а набор выше английскому домену не обучен: в нём только
 * английские служебные слова. Поэтому «services», «business», «company»
 * засчитывались как совпадение вертикали, а «clinics» не совпадало с «clinic».
 * Итог — релевантный кейс проигрывал нерелевантным, у которых в полях те же
 * общие слова (пример и цифры — отчёт лейна names-cases, раунд 3).
 *
 * RU-путь ниже не меняется ни на байт: tokenize и STOP_TOKENS прежние, и
 * EN-ветка включается ТОЛЬКО по рынку проекта.
 */

/**
 * Служебные слова английского, которых нет в STOP_TOKENS. Сравниваются с
 * токеном как он есть (до нормализации окончаний).
 */
const EN_FUNCTION_TOKENS = new Set([
  'with', 'by', 'from', 'into', 'via', 'per', 'as', 'is', 'are', 'be', 'our', 'your', 'their', 'its',
  'we', 'you', 'they', 'that', 'this', 'these', 'who', 'which', 'new', 'more', 'other', 'all',
]);

/**
 * Доменно-общие слова английских кейсов и вертикалей — тот же принцип, что у
 * русской половины STOP_TOKENS: слово встречается в кейсах ЛЮБОЙ индустрии и
 * поэтому не отличает одну вертикаль от другой. Формы — после нормализации
 * множественного числа (normalizeEnPlural), то есть «services» ловится как
 * «service».
 *
 * Состав:
 *  - русская половина STOP_TOKENS по-английски: sale (продажи), service
 *    (услуги), client/customer (клиенты), business (бизнес), lead (лиды),
 *    inquiry/request (заявки), company (компания), market (рынок),
 *    growth/grow (рост), work (работа), project (проект), solution (решение),
 *    product (продукт);
 *  - тип организации, а не отрасль: firm, agency, group, provider, owner —
 *    «marketing agency» и «staffing agency» иначе совпадали бы по «agency»
 *    с весом поля индустрии, а этого одного хватает до порога MIN_CASE_SCORE;
 *  - размер и охват: small, medium, mid, midsize, large, local («small
 *    business» стоит в client_type кейсов любой отрасли);
 *  - industry, sector, revenue, team — рамка задачи кейса («increase
 *    revenue», «sales team»), не отрасль.
 *
 * Чего в списке НЕТ, сознательно: delivery (в отличие от RU «доставка»: у ENG
 * это и отрасль — food delivery, courier), marketing, software, startup, b2b,
 * office, store — они называют отрасль или сегмент.
 */
const EN_DOMAIN_STOP_TOKENS = new Set([
  'sale', 'service', 'client', 'customer', 'business', 'lead', 'inquiry', 'request', 'company',
  'market', 'growth', 'grow', 'work', 'project', 'solution', 'product',
  'firm', 'agency', 'group', 'provider', 'owner',
  'small', 'medium', 'mid', 'midsize', 'large', 'local',
  'industry', 'sector', 'revenue', 'team',
]);

/**
 * Множественное число → единственное, консервативно: только латиница от 4
 * букв; -ies → -y (agencies), -es после ss/sh/ch/x/z (businesses, boxes),
 * иначе -s. Окончания -ss/-us/-is/-as не трогаются (glass, campus, analysis,
 * saas).
 */
function normalizeEnPlural(token: string): string {
  if (token.length < 4 || !/^[a-z]+$/.test(token)) return token;
  if (token.length >= 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !/(?:ss|us|is|as)$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * -ing / -ed → основа, только если основа не короче 4 букв (staffing → staff,
 * marketing → market; hiring и seed остаются как есть). Применяется ПОСЛЕ
 * проверки стоп-слов: иначе «marketing» превратился бы в стоп-слово «market»
 * и отрасль пропала бы из скора.
 */
function normalizeEnVerbal(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  if (token.endsWith('ing') && token.length - 3 >= 4) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length - 2 >= 4) return token.slice(0, -2);
  return token;
}

/**
 * Токены ENG-проекта. domainStop=false — без доменных стоп-слов (только
 * служебные): фолбэк scoreCaseForVertical для вертикали, от названия
 * которой после стоп-слов не осталось ничего.
 */
function tokenizeEn(text: string, domainStop: boolean): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-zа-яё0-9]+/i)) {
    if (raw.length < 2 || STOP_TOKENS.has(raw) || EN_FUNCTION_TOKENS.has(raw)) continue;
    const singular = normalizeEnPlural(raw);
    if (domainStop && EN_DOMAIN_STOP_TOKENS.has(singular)) continue;
    out.push(normalizeEnVerbal(singular));
  }
  return out;
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
 *
 * market='us' — английские токены (tokenizeEn: служебные и доменные
 * стоп-слова EN, нормализация окончаний). Фолбэк: если от НАЗВАНИЯ
 * вертикали после стоп-слов не осталось ни одного токена (вертикаль
 * «Business services»), обе стороны считаются без доменных стоп-слов —
 * общие слова и есть её отрасль. Без фолбэка у такой вертикали скор всегда 0
 * (кейса нет, даже когда он про неё) либо решают случайные слова синонимов.
 * Смотрим на название, а не на название с синонимами: один уцелевший токен
 * синонима («B2B service providers» → b2b) фолбэк не отменяет. У RU-пути
 * фолбэка нет — как и было, пустой набор даёт 0.
 */
export function scoreCaseForVertical(
  target: CaseScoreTarget,
  vertical: VerticalScoreInput,
  market: HeMarket = 'ru',
): number {
  const verticalText = [vertical.name, ...(vertical.synonyms ?? [])].filter(Boolean).join(' ');
  let tokenizeField: (text: string) => string[] = tokenize;
  if (market === 'us') {
    const domainStop = tokenizeEn(vertical.name ?? '', true).length > 0;
    tokenizeField = (text) => tokenizeEn(text, domainStop);
  }
  const verticalTokens = new Set(tokenizeField(verticalText));
  if (!verticalTokens.size) return 0;
  const fieldTokens: Array<[number, Set<string>]> = [
    [FIELD_WEIGHTS.industry, new Set(tokenizeField(target.industry ?? ''))],
    [FIELD_WEIGHTS.client_type, new Set(tokenizeField(target.client_type ?? ''))],
    [FIELD_WEIGHTS.task, new Set(tokenizeField(target.task ?? ''))],
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
 *
 * Рынок проекта читается здесь же (he_projects.market), потому что оба
 * вызывающих (stages/chain, stages/template) передают только вертикаль.
 * Сбой этого чтения стадию не роняет и кейс не отнимает: скор считается
 * прежними (RU) токенами — ровно так, как до EN-токенов считался у всех.
 */
export async function selectCaseForVertical(
  supabase: SupabaseClient,
  projectId: string,
  vertical: VerticalScoreInput,
): Promise<HeCase | null> {
  const [{ data, error }, market] = await Promise.all([
    supabase
      .from('he_cases')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    readCaseScoringMarket(supabase, projectId),
  ]);
  if (error) throw new Error(`he_cases read: ${error.message}`);

  let best: HeCase | null = null;
  let bestScore = 0;
  for (const row of (data ?? []) as HeCase[]) {
    const score = scoreCaseForVertical(row, vertical, market);
    const uploadWinsTie =
      best !== null && score === bestScore && row.source === 'upload' && best.source !== 'upload';
    if (score > bestScore || uploadWinsTie) {
      best = row;
      bestScore = score;
    }
  }
  return best !== null && bestScore >= MIN_CASE_SCORE ? best : null;
}

/** Рынок проекта для подбора кейса; любой сбой чтения — 'ru' (см. выше). */
async function readCaseScoringMarket(supabase: SupabaseClient, projectId: string): Promise<HeMarket> {
  try {
    const { data, error } = await supabase
      .from('he_projects')
      .select('market')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) return 'ru';
    return projectMarket(data as { market?: string | null });
  } catch {
    return 'ru';
  }
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
