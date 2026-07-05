/**
 * LLM-отсев B2C/ИП/гос компаний — ТРЕТИЙ рубеж OutreachOS-пайплайна.
 *
 * Зачем: структурные правила (excludeB2c.ts) ловят ~4% шума (ФИО, .shop,
 * «школа» в названии), но онлайн-школа с нейтральным доменом, геймдев или
 * Триколор структурно неотличимы от B2B. Разовая LLM-чистка кампаний 05.07
 * показала ещё ~10% такого шума. Владелец: «главное чтобы потом было без
 * [шума]» — поэтому классификация встроена в ежедневный прогон.
 *
 * Механика: та же связка, что name-cleanup (Requesty router, policy/cleanup →
 * gpt-4o-mini — единственный policy-алиас, не сломанный для русского, см.
 * память requesty-policy-gemini-flash-broken). Свой лёгкий caller, БЕЗ импорта
 * processingSteps (не тащим base-constructor фреймворк и держим изоляцию).
 *
 * ДВЕ СТУПЕНИ (как в разовой чистке кампаний 05.07): (1) классификация →
 * кандидаты в шум; (2) «адвокат дьявола» по кандидатам — вердикт снимается,
 * если есть убедительный B2B-сценарий (Skyeng=корп-направление, издательство=
 * опт, радио=реклама бизнесу). Эвал на 868 с ground truth: одна ступень ложно
 * убивала 18/37 проверенных B2B — вторая ступень обязательна.
 *
 * FAIL-OPEN: нет ключа / HTTP-ошибка / кривой JSON на ступени 1 → батч целиком
 * остаётся (мы теряем фильтрацию, не лиды). На ступени 2 наоборот: сбой
 * рефьюта СОХРАНЯЕТ флаг шума (владелец: «главное чтобы потом было без шума»).
 */

import 'server-only';

export interface CompanyForClassify {
  name: string;
  website: string;
}

export interface LlmNoiseResult {
  /** Индексы (по входному массиву) компаний, уверенно распознанных как шум. */
  noise: Set<number>;
  /** Сколько компаний реально получили вердикт (для лога/мониторинга). */
  classified: number;
  /** Сколько батчей упало и осталось без фильтрации (fail-open). */
  failedBatches: number;
  /** Сколько кандидатов в шум спас «адвокат дьявола» (ступень 2). */
  refuted: number;
}

const REQUESTY_URL = 'https://router.requesty.ai/v1/chat/completions';
const MODEL = process.env.OUTREACHOS_CLASSIFY_MODEL || 'policy/cleanup';
const BATCH_SIZE = 40;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;

/** Категории-шум: только эти вердикты выкидывают компанию из заливки. */
const NOISE_CATEGORIES = new Set(['B2C', 'IP', 'GOV']);

const SYSTEM_PROMPT = `Ты классифицируешь российские компании для базы B2B cold-outreach (продукт — платформа холодных email-рассылок, покупатель — компании, продающие другим бизнесам).

Для КАЖДОЙ компании из списка определи по названию и домену, кому она продаёт:
- B2B — бизнесам: софт, IT-услуги, интеграторы, промышленность/опт, агентства, консалтинг, HR-услуги для компаний, поставщики В потребительские вертикали (оборудование для ресторанов, финтех для школ — это B2B).
- B2C — физлицам: онлайн-школы/курсы/репетиторы, ритейл и интернет-магазины, услуги населению (ремонт, такси, салоны), недвижимость физлицам, медиа/ТВ/игры для аудитории, спортклубы, отели, развлечения.
- MIXED — заметно и бизнесу, и физлицам.
- IP — ИП/частник/самозанятый (ФИО в названии, частная практика, tilda-лендинг).
- GOV — госструктура, бюджетное учреждение, НИИ, НКО, ассоциация, федерация, СРО.
- UNCLEAR — по названию и домену определить нельзя.

Знание известных брендов используй. ВАЖНО: при сомнении между B2B и B2C ставь UNCLEAR — ложно выкинутый B2B дороже пропущенного B2C.

Ответ — СТРОГО JSON без пояснений: {"verdicts":[{"i":<номер из списка>,"c":"<категория>"}]} — по одному вердикту на каждый номер.`;

const REFUTE_PROMPT = `Ты адвокат дьявола. Компании ниже — кандидаты на УДАЛЕНИЕ из B2B cold-outreach базы (помечены как B2C/ИП/гос). Продукт — платформа холодных email-рассылок; покупатель — компании, которым нужны B2B-клиенты.

Для КАЖДОЙ компании попробуй ОПРОВЕРГНУТЬ вердикт: есть ли убедительный сценарий, что она продаёт бизнесам? Считается: заметное корпоративное направление (Skyeng → Skyeng B2B), опт/white-label (издательство продаёт тиражи сетям), реклама бизнесу (медиа/радио живут продажей рекламы), софт/услуги для отрасли, кадровое агентство для компаний. НЕ считается: «бизнес тоже может купить» без признаков.

noise=false ТОЛЬКО при убедительном B2B-сценарии. Сомнение — подтверждай удаление (noise=true).

Ответ — СТРОГО JSON: {"verdicts":[{"i":<номер>,"noise":true|false}]} — по одному на каждый номер.`;

function apiKey(): string {
  return (
    process.env.OUTREACHOS_CLASSIFY_API_KEY ||
    process.env.OPENROUTER_CLEANUP_API_KEY ||
    ''
  ).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Вызов Requesty с ретраями на 5xx — паттерн callOpenRouter из processingSteps. */
async function callLlm(key: string, systemPrompt: string, userContent: string): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      const res = await fetch(REQUESTY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - OutreachOS B2C filter',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
          max_tokens: 1500,
          response_format: { type: 'json_object' },
        }),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        return json.choices?.[0]?.message?.content || '';
      }
      if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw new Error(`Requesty ${res.status}`);
    } catch (err) {
      clearTimeout(timeout);
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw new Error('Requesty max retries exceeded');
}

/** Сырые записи verdicts из ответа модели; терпит codefence. Кривой JSON → null. */
function parseVerdictRecords(raw: string): Record<string, unknown>[] | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(stripped) as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) return null;
    return parsed.verdicts.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  } catch {
    return null;
  }
}

function parseVerdicts(raw: string): { i: number; c: string }[] | null {
  const records = parseVerdictRecords(raw);
  if (!records) return null;
  const out: { i: number; c: string }[] = [];
  for (const v of records) {
    if (typeof v.i !== 'number' || typeof v.c !== 'string') continue;
    out.push({ i: v.i, c: v.c.trim().toUpperCase() });
  }
  return out;
}

function parseRefutes(raw: string): { i: number; noise: boolean }[] | null {
  const records = parseVerdictRecords(raw);
  if (!records) return null;
  const out: { i: number; noise: boolean }[] = [];
  for (const v of records) {
    if (typeof v.i !== 'number' || typeof v.noise !== 'boolean') continue;
    out.push({ i: v.i, noise: v.noise });
  }
  return out;
}

/**
 * Классифицирует компании батчами; возвращает индексы уверенного шума.
 * Никогда не бросает: любой сбой = батч без фильтрации (fail-open).
 */
export async function llmClassifyNoise(
  companies: readonly CompanyForClassify[],
  log: (msg: string) => void = () => {},
): Promise<LlmNoiseResult> {
  const result: LlmNoiseResult = { noise: new Set(), classified: 0, failedBatches: 0, refuted: 0 };
  if (companies.length === 0) return result;
  const key = apiKey();
  if (!key) {
    log('LLM-фильтр: нет OUTREACHOS_CLASSIFY_API_KEY/OPENROUTER_CLEANUP_API_KEY — пропускаем (fail-open)');
    return result;
  }

  const listingOf = (items: readonly CompanyForClassify[]): string =>
    items
      .map((c, j) => `${j + 1}. ${c.name || '(без названия)'} — ${c.website || '(без сайта)'}`)
      .join('\n');

  // Ступень 1: классификация → кандидаты в шум.
  for (let start = 0; start < companies.length; start += BATCH_SIZE) {
    const batch = companies.slice(start, start + BATCH_SIZE);
    try {
      const raw = await callLlm(key, SYSTEM_PROMPT, `Компании (${batch.length}):\n${listingOf(batch)}`);
      const verdicts = parseVerdicts(raw);
      if (!verdicts) {
        result.failedBatches++;
        log(`LLM-фильтр: батч ${start}-${start + batch.length - 1} — кривой JSON, оставляем всех`);
        continue;
      }
      const seen = new Set<number>();
      for (const { i, c } of verdicts) {
        if (!Number.isInteger(i) || i < 1 || i > batch.length || seen.has(i)) continue;
        seen.add(i);
        result.classified++;
        if (NOISE_CATEGORIES.has(c)) result.noise.add(start + i - 1);
      }
    } catch (err) {
      result.failedBatches++;
      log(
        `LLM-фильтр: батч ${start}-${start + batch.length - 1} упал (${err instanceof Error ? err.message : String(err)}), оставляем всех`,
      );
    }
  }

  // Ступень 2: адвокат дьявола — снимаем флаг при убедительном B2B-сценарии.
  // Сбой рефьюта СОХРАНЯЕТ флаг (шум важнее недобора — выбор владельца).
  const flagged = [...result.noise].sort((a, b) => a - b);
  for (let start = 0; start < flagged.length; start += BATCH_SIZE) {
    const chunk = flagged.slice(start, start + BATCH_SIZE);
    try {
      const raw = await callLlm(
        key,
        REFUTE_PROMPT,
        `Кандидаты (${chunk.length}):\n${listingOf(chunk.map((idx) => companies[idx]))}`,
      );
      const refutes = parseRefutes(raw);
      if (!refutes) {
        log(`LLM-фильтр: рефьют ${start}-${start + chunk.length - 1} — кривой JSON, флаги сохранены`);
        continue;
      }
      const seen = new Set<number>();
      for (const { i, noise } of refutes) {
        if (!Number.isInteger(i) || i < 1 || i > chunk.length || seen.has(i)) continue;
        seen.add(i);
        if (!noise) {
          result.noise.delete(chunk[i - 1]);
          result.refuted++;
        }
      }
    } catch (err) {
      log(
        `LLM-фильтр: рефьют ${start}-${start + chunk.length - 1} упал (${err instanceof Error ? err.message : String(err)}), флаги сохранены`,
      );
    }
  }
  return result;
}
