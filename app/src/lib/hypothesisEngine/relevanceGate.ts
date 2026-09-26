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

/**
 * Оборот мотива покупки внутри EN-summary.
 *
 * EN-промпт кластеризации обещает ДВЕ вещи: summary — ровно два предложения, и
 * второе начинается точными словами «They buy because …» (prompts/clustering.en.ts,
 * самопроверки 4 и 5). Обещание промпта — не инвариант, и резать по одной фразе
 * мало:
 *  - модель пишет тот же мотив иначе: «These companies buy because …»,
 *    «They purchase the service because …»;
 *  - вертикали, склеенные ДО правки промпта (формат «1–2 предложения: кто это и
 *    почему покупает»), зачина не несут вовсе и держат мотив внутри ОДНОГО
 *    предложения — граница там проходит посередине, а не по точке;
 *  - порядок предложений модель иногда переставляет.
 *
 * Поэтому ищем не метку, а сам оборот: анафора (they/these/those/such/their) +
 * глагол покупки рядом + причинный союз. Описание компании так не звучит:
 * первое предложение пишется без антецедента и начинается конкретной группой
 * («Mid-market staffing agencies …»; «Companies that buy media …» под шаблон не
 * попадает — между подлежащим и глаголом стоит «that»), поэтому описание
 * шаблон не режет. Союз «to» в список НЕ взят намеренно: «such platforms
 * subscribe to industry feeds» — это описание, а не мотив.
 */
const EN_BUYING_MOTIVE =
  /\b(?:why\s+(?:they|these\s+companies)\s+buy\s*:|(?:and\s+)?(?:they|these|those|such|their)(?:\s+[a-z][a-z-]*){0,3}?\s+(?:buys?|purchases?|invests?|spends?|pays?|procures?|subscribes?|adopts?|outsources?)\b[^.!?]{0,80}?\s(?:because|in\s+order\s+to|so\s+that)\b)/i;

/**
 * Признак того, что предложение говорит о покупке, а не о компании. Нужен на
 * шаге 3 (см. companyPartOfSummaryEn), когда оборот выше не нашёлся, а
 * структура промпта соблюдена: «They buy to fill a thin pipeline.», «The
 * purchase is driven by a missing BD function.».
 */
const EN_PURCHASE_TALK =
  /\b(?:buy|buys|buying|bought|purchase|purchases|purchasing|invest|invests|investing|spend|spends|spending|pay|pays|paying|because)\b/i;

/**
 * Начала предложений. Без словаря сокращений: лишнее деление на «Inc.» делает
 * правило только осторожнее — шаг 3 работает ровно на двух предложениях, то
 * есть на обещанной промптом форме, а на тексте, разбитом лишний раз, молчит.
 */
function sentenceStartsEn(text: string): number[] {
  const starts = [0];
  const re = /[.!?…]["')\]]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const next = m.index + m[0].length;
    if (next < text.length) starts.push(next);
  }
  return starts;
}

/** Хвост вида «, and» / «;» / «—», остающийся после реза посередине предложения. */
function trimConnectorTailEn(text: string): string {
  return text.replace(/(?:[\s,;:—–]|\band\b|\bbut\b|\bwhile\b)+$/i, '').trim();
}

/**
 * Цель отбора — описание КОМПАНИИ, а не причины, по которой мы хотели бы ей
 * продать. he_verticals.summary служит обеим задачам: человеку в кабинете он
 * объясняет «почему они покупают», а сюда приезжает как «кого мы ищем». Гейт
 * видит только company/website/category/vacancy_title — по этим полям мотив
 * покупки не проверяется никак, и модель вычёркивала подходящие компании за то,
 * что в полях не видно причины покупки. Цена ошибки высокая: помеченные строки
 * вырезаются из запуска (launchTemplate) и из добора (baseCollectRefill), без
 * состояния «на пересмотр» — клиент теряет компанию молча.
 *
 * Поэтому мотив отрезаем — по двум признакам, и оба взяты из обещаний
 * EN-промпта, а не из догадки о том, как модель напишет:
 *   1) оборот мотива (EN_BUYING_MOTIVE) — режем по нему где угодно, в том числе
 *      посередине предложения: у вертикалей, склеенных до правки промпта, мотив
 *      и описание живут в одном предложении;
 *   2) если оборот стоит первым — значит модель переставила предложения, и
 *      описание идёт после него: отдаём хвост, а не пустую строку;
 *   3) если оборота нет вовсе — опираемся на вторую гарантию промпта: ровно два
 *      предложения, мотив — во втором. Второе предложение отбрасываем только
 *      когда оно действительно про покупку (EN_PURCHASE_TALK).
 * Ни один шаг не может вернуть пустое: цель с мотивом хуже, чем цель без
 * мотива, но цель из одного имени вертикали хуже обеих — у пробы среза дефолт
 * стоит на «не принадлежит», и без описания она забракует любой срез.
 *
 * ЧЕСТНАЯ ГРАНИЦА: надёжного разделителя внутри свободного текста не бывает —
 * промпт не компилятор. Развязка по-настоящему делается ПОЛЕМ: clustering
 * возвращает «кто это» и «почему покупают» отдельно, цель отбора берёт первое,
 * письма — оба. Это миграция he_verticals + схема ответа кластеризации + правка
 * клиентской проекции, то есть отдельная волна; здесь сделано максимум, что
 * можно сделать на существующем поле.
 *
 * Только EN: RU-ветка обслуживает legacy-инструмент /tools/hypothesis-engine и
 * должна остаться байт-в-байт прежней.
 *
 * Экспортируется, потому что ту же цель получают ещё два консьюмера того же
 * summary — проба среза (sliceProbe.ts) и матрица вокабуляра (stages/vocab.ts,
 * откуда термины и запросы уезжают прямо в сбор). Резать надо тем же правилом:
 * у пробы дефолт стоит на «не принадлежит», и мотив внутри цели топит её ещё
 * вернее, чем гейт.
 */
export function companyPartOfSummaryEn(summary: string): string {
  const text = summary.trim();
  if (!text) return '';

  const starts = sentenceStartsEn(text);
  const motive = text.search(EN_BUYING_MOTIVE);

  // 1) Оборот найден — он и есть граница описания компании.
  if (motive > 0) {
    const head = trimConnectorTailEn(text.slice(0, motive));
    if (head) return head;
  }
  // 2) Оборот стоит первым — описание идёт следующими предложениями.
  if (motive === 0 && starts.length > 1) {
    const tail = text.slice(starts[1]).trim();
    if (tail) return tail;
  }
  // 3) Оборота нет — работаем по форме, которую обещает промпт.
  if (motive < 0 && starts.length === 2 && EN_PURCHASE_TALK.test(text.slice(starts[1]))) {
    const head = trimConnectorTailEn(text.slice(0, starts[1]));
    if (head) return head;
  }
  return text;
}

function buildRelevanceMessages(
  verticalName: string,
  verticalSummary: string,
  batch: Array<{ i: number; company: string; website: string; category: string; vacancy_title: string }>,
  language: 'ru' | 'en',
): LLMMessage[] {
  const rowsJson = JSON.stringify(batch);
  if (language === 'en') {
    const target = companyPartOfSummaryEn(verticalSummary);
    return [
      {
        role: 'system',
        content:
          'You filter a collected lead base for one market vertical. A row is relevant only if the company itself plausibly belongs to the vertical (not merely mentions it in a vacancy or sells to it). Judge only what the company IS — its line of business and its company type. A reason to buy anything, processes, software, budget, hiring and headcount are context, never requirements. Answer strictly in JSON.',
      },
      {
        role: 'user',
        content: `Vertical: «${verticalName}»${target ? ` — ${target}` : ''}\n\nRows (i + fields):\n${rowsJson}\n\nReturn JSON {"irrelevant": [<i>, ...]} with the indices of rows whose company clearly does NOT belong to this vertical. When in doubt — keep the row (do not list it).`,
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
