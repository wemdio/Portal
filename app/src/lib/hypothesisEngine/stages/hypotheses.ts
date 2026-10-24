/**
 * Стадия hypotheses — проход (a): мгновенный исчерпывающий список
 * гипотез-кандидатов (RU — 25–40, tier 1/2/3; us — с 16.10.2026 до 15 широких
 * аудиторий без квот, prompts/hypotheses.en.ts) из «генетической памяти» модели.
 * Кандидаты сохраняются в job.result.candidates — их верифицирует стадия
 * evidence. На этом шаге поиск и доказательства НЕ используются.
 *
 * Мягкие проверки ответа (оба рынка, только строка лога): квоты промпта
 * (RU — 25–40 кандидатов, tier 2 ≥ 8, tier 3 ≥ 8; us — не больше 15) и повторы
 * title.
 *
 * Только market='us':
 *  - пол схемы (HeHypothesesBatchSchemaUs): не меньше HE_HYPOTHESES_FLOOR_US
 *    кандидатов с непустым title. Нарушение — повтор вызова с разбором ошибки
 *    (llm.ts, у EN-промпта повтор видит весь прошлый ответ); повтор тоже ниже
 *    пола — берём его ответ как есть (callHypothesesUs), стадия не падает.
 *    Кандидат с пустым title сам по себе повтора не вызывает: код его
 *    выбрасывает бесплатно (вместе с отклонёнными и повторами ниже);
 *  - гипотезы проекта, отклонённые человеком (status='rejected'), уходят в
 *    промпт запретом и отсекаются кодом по нормализованному title; повторы
 *    title внутри ответа схлопываются до первого — evidence не платит за
 *    одного кандидата дважды.
 */

import { z } from 'zod';

import {
  callLLMWithSchema,
  getHeModel,
  LLMValidationError,
  tryRepairTruncatedJson,
  type HeLlmSchemaCallOptions,
  type LLMMessage,
} from '../llm';
import {
  HeHypothesesBatchSchema,
  HeHypothesisCandidateSchema,
  type HeBrandCloudOutput,
  type HeHypothesisCandidate,
  type HeSiteProfileOutput,
} from '../schemas';
import { projectMarket, type HeMarket } from '../market';
import { buildHypothesesInstantMessages } from '../prompts/hypotheses';
import { buildHypothesesInstantMessagesEn } from '../prompts/hypotheses.en';
import { readHeIcpFrame } from '../icpFrame';
import { HE_COLLECT_COUNTRIES_INVALID, engCountryLabel, readHeCollectCountries } from '../engCountries';
import { getPortfolioProfile, type HePortfolioEntry } from '../datasetStats';
import type { HeJob } from '../types';
import {
  addUsage,
  latestDoneJobResult,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  type HeStageContext,
  type HeStageResult,
  type HeUsage,
} from './shared';
import type { HeCompetitorEntry } from './competitors';

/* ─────────────── пол ответа и разметка (только market='us') ─────────────── */

/**
 * Пол списка кандидатов рынка 'us'. С 16.10.2026 EN-промпт просит до 15 широких
 * аудиторий без минимума (обычно 6–12), и честный ответ из 4–6 аудиторий
 * повтором не наказывается: повтор оплачивает генерацию всего ответа заново.
 * Ответ короче 3 — отказ или обрубок, а не «рынков мало»: одна осмысленная
 * попытка (повтор схемы видит весь прошлый ответ и ошибку) дешевле
 * исследования, построенного на одной-двух гипотезах.
 */
const HE_HYPOTHESES_FLOOR_US = 3;

/**
 * Схема ответа рынка 'us': общий кандидат (пробелы по краям title срезаются) и
 * пол списка, посчитанный по кандидатам с непустым title. Пустой title схему
 * не роняет: повтор схемы оплачивает генерацию ВСЕГО ответа (25–40 кандидатов,
 * до 32 768 токенов на ресёрч-модели) заново, а такую строку код выбрасывает
 * даром (runHypothesesStage). Повтор — только когда непустых меньше пола.
 * Локальная: RU отвечает по общей HeHypothesesBatchSchema, и её поведение не
 * меняется.
 */
const HeHypothesesBatchSchemaUs = z.object({
  hypotheses: z
    .array(HeHypothesisCandidateSchema.extend({ title: z.string().trim() }))
    .refine(
      (list) => list.filter((h) => h.title).length >= HE_HYPOTHESES_FLOOR_US,
      `return the distinct fitting audiences (up to 15): fewer than ${HE_HYPOTHESES_FLOOR_US} with a non-empty title is not a complete answer`,
    ),
});

/** Сколько отклонённых title проекта уходит в промпт запретом (код отсекает все). */
const REJECTED_TITLES_PROMPT_LIMIT = 60;

function normTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Title гипотез проекта, отклонённых человеком (status='rejected'), без
 * повторов. Только market='us'. Сбой чтения роняет стадию до платного вызова:
 * без списка повтор research мог бы снова предложить отклонённое.
 */
async function readRejectedTitles(ctx: HeStageContext, projectId: string): Promise<string[]> {
  const { data, error } = await ctx.supabase
    .from('he_hypotheses')
    .select('title')
    .eq('project_id', projectId)
    .eq('status', 'rejected');
  if (error) throw new Error(`he_hypotheses read rejected: ${error.message}`);
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const row of (data ?? []) as Array<{ title?: unknown }>) {
    if (typeof row.title !== 'string') continue;
    const key = normTitle(row.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(row.title.trim());
  }
  return titles;
}

/**
 * Ответ последней попытки без пола: общая схема, пустые title выброшены,
 * остальные обрезаны по краям. null — разобрать нечего, и стадия бросает
 * исходный отказ. Разбор тот же, что у llm.ts: срезать markdown-фенсы, затем
 * JSON.parse, а при сбое — ремонт обрезанного JSON.
 */
function lenientHypothesesFrom(rawText: string): HeHypothesisCandidate[] | null {
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = tryRepairTruncatedJson(cleaned);
  }
  if (parsed === null) return null;
  const validated = HeHypothesesBatchSchema.safeParse(parsed);
  if (!validated.success) return null;
  const kept = validated.data.hypotheses
    .filter((h) => h.title.trim())
    .map((h) => ({ ...h, title: h.title.trim() }));
  return kept.length ? kept : null;
}

/**
 * Вызов модели рынка 'us' со схемой с полом. Обе попытки ниже пола (меньше
 * HE_HYPOTHESES_FLOOR_US кандидатов с непустым title) — берём ответ последней
 * без пола (lenientHypothesesFrom) и пишем это в лог: исследование идёт
 * дальше на том, что модель дала, а не падает, чтобы клиент перезапускал его
 * целиком. Прочие отказы — как были.
 *
 * Деньги: в худшем случае 2 оплаченных вызова (было 1). Их расход стадия в
 * этой ветке не знает (он едет только с результатом), но воркер пишет в учёт
 * больший из расхода стадии и суммы оплаченных ответов модели (канал активной
 * джобы), так что он не теряется.
 */
async function callHypothesesUs(
  ctx: HeStageContext,
  messages: LLMMessage[],
  options: HeLlmSchemaCallOptions,
  usage: HeUsage,
): Promise<HeHypothesisCandidate[]> {
  try {
    const llm = await callLLMWithSchema(messages, HeHypothesesBatchSchemaUs, options);
    addUsage(usage, llm);
    return llm.data.hypotheses;
  } catch (e) {
    if (!(e instanceof LLMValidationError)) throw e;
    const recovered = lenientHypothesesFrom(e.rawText);
    if (!recovered) throw e;
    stageLog(
      ctx,
      `[hypotheses] ответ дважды не прошёл пол схемы (≥ ${HE_HYPOTHESES_FLOOR_US} кандидатов с непустым title) — `
        + `берём последний как есть: ${recovered.length} кандидатов`,
    );
    return recovered;
  }
}

/**
 * Мягкие проверки ответа модели — только строка лога, без отказа (оба рынка):
 * квоты промпта и повторы title. RU — 25–40 кандидатов, tier 2 ≥ 8, tier 3 ≥ 8
 * (как раньше); us — с 16.10.2026 квот нет, проверяется только потолок 15.
 */
function logSoftChecks(ctx: HeStageContext, candidates: HeHypothesisCandidate[], market: HeMarket): void {
  const tiers = candidates.reduce<Record<number, number>>((acc, h) => {
    acc[h.tier] = (acc[h.tier] ?? 0) + 1;
    return acc;
  }, {});
  const seen = new Set<string>();
  let duplicates = 0;
  for (const h of candidates) {
    const key = normTitle(h.title);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  const issues: string[] = [];
  if (market === 'us') {
    if (candidates.length > 15) issues.push(`кандидатов ${candidates.length} (просили до 15)`);
  } else {
    if (candidates.length < 25 || candidates.length > 40) issues.push(`кандидатов ${candidates.length} (просили 25–40)`);
    if ((tiers[2] ?? 0) < 8) issues.push(`tier 2: ${tiers[2] ?? 0} (просили ≥ 8)`);
    if ((tiers[3] ?? 0) < 8) issues.push(`tier 3: ${tiers[3] ?? 0} (просили ≥ 8)`);
  }
  if (duplicates) issues.push(`повторов title: ${duplicates}`);
  if (issues.length) stageLog(ctx, `[hypotheses] мягкая проверка ответа: ${issues.join('; ')}`);
}

/* ─────────────── калибровочные данные (best-effort) ─────────────── */

/** История ручной разметки гипотез: топ-N частотных title по каждому вердикту. */
export interface HeMarkupHistory {
  accepted: string[];
  rejected: string[];
}

const MARKUP_HISTORY_LIMIT = 10;
/** Сколько свежих размеченных строк сканируем для частотной статистики. */
const MARKUP_HISTORY_SCAN = 2000;

/**
 * Чистая агрегация разметки: частота title отдельно по accepted/rejected,
 * топ-N по убыванию частоты (при равенстве — порядок первого появления).
 * Матчинг строго по точному title (после trim, регистр значим), пустые
 * title и прочие статусы (proposed) игнорируются.
 */
export function aggregateMarkupHistory(
  rows: Array<{ title?: unknown; status?: unknown }>,
  limit = MARKUP_HISTORY_LIMIT,
): HeMarkupHistory {
  const accepted = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const row of rows) {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    if (!title) continue;
    const bucket = row.status === 'accepted' ? accepted : row.status === 'rejected' ? rejected : null;
    if (!bucket) continue;
    bucket.set(title, (bucket.get(title) ?? 0) + 1);
  }
  const top = (freq: Map<string, number>): string[] =>
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([title]) => title);
  return { accepted: top(accepted), rejected: top(rejected) };
}

/**
 * Портфельный профиль датасета для калибровки промпта. При любом сбое
 * (датасет лежит/не сконфигурирован) возвращаем undefined — стадия
 * продолжается без калибровки. Рынок us: датасет — это RU-кампании,
 * калибровка по нему бессмысленна → undefined, датасет не дёргаем
 * (см. также рыночный гейт в datasetStats.ts).
 */
export async function loadPortfolioProfile(
  ctx: HeStageContext,
  market: HeMarket,
): Promise<HePortfolioEntry[] | undefined> {
  if (market === 'us') {
    stageLog(ctx, '[hypotheses] market=us — калибровка по RU-датасету пропущена');
    return undefined;
  }
  try {
    // market дублируем в опциях: гейт выше уже отсёк us, но второй рубеж
    // внутри datasetStats переживёт случайный вызов в обход этой обёртки.
    return await getPortfolioProfile({ limit: 10, market });
  } catch (e) {
    stageLog(ctx, `[hypotheses] getPortfolioProfile упал: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * История ручной разметки гипотез ДРУГИХ проектов (accepted/rejected) —
 * калибровка «какие гипотезы живут / умирают на ревью специалиста».
 * Сбой чтения → undefined, стадия продолжается.
 * Рынок us: `he_hypotheses` не скоупится ни по рынку, ни по владельцу, то
 * есть в EN-промпт уехали бы русские заголовки чужих RU-проектов под
 * подписью «вкус этого клиента» — гейтим так же, как loadPortfolioProfile.
 */
export async function loadMarkupHistory(
  ctx: HeStageContext,
  projectId: string,
  market: HeMarket,
): Promise<HeMarkupHistory | undefined> {
  if (market === 'us') {
    stageLog(ctx, '[hypotheses] market=us — калибровка по разметке RU-проектов пропущена');
    return undefined;
  }
  try {
    const { data, error } = await ctx.supabase
      .from('he_hypotheses')
      .select('title, status')
      .in('status', ['accepted', 'rejected'])
      .neq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(MARKUP_HISTORY_SCAN);
    if (error) throw new Error(error.message);
    return aggregateMarkupHistory(data ?? []);
  } catch (e) {
    stageLog(ctx, `[hypotheses] история разметки недоступна: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Элемент фактического замера: прогноз вертикали против фактического reply%. */
export interface HeActualsHistoryItem {
  name: string;
  predicted_pct: number;
  actual_reply_pct: number;
  actual_sent: number | null;
}

/**
 * Фактические замеры прошлых запусков (петля сверки, he_verticals.actual_*)
 * — якоря шкалы potential_pct для промпта. До применения миграции
 * 20260806_0001 колонок нет → ошибка чтения → undefined (без них промпт
 * работает как раньше). Best-effort, как остальная калибровка.
 * Рынок us: `he_verticals` читается по всей таблице (ни проекта, ни рынка),
 * то есть шкалой для англоязычного проекта служили бы фактические reply%
 * чужих RU-запусков — тот же гейт, что у остальной калибровки.
 */
export async function loadActualsHistory(
  ctx: HeStageContext,
  market: HeMarket,
): Promise<HeActualsHistoryItem[] | undefined> {
  if (market === 'us') {
    stageLog(ctx, '[hypotheses] market=us — калибровка по фактам RU-запусков пропущена');
    return undefined;
  }
  try {
    const { data, error } = await ctx.supabase
      .from('he_verticals')
      .select('name, potential_pct, actual_reply_pct, actual_sent')
      .not('actual_reply_pct', 'is', null)
      .order('actual_measured_at', { ascending: false })
      .limit(5);
    if (error) throw new Error(error.message);
    const items = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((r) => typeof r.actual_reply_pct === 'number')
      .map((r) => ({
        name: String(r.name ?? ''),
        predicted_pct: typeof r.potential_pct === 'number' ? r.potential_pct : 0,
        actual_reply_pct: r.actual_reply_pct as number,
        actual_sent: typeof r.actual_sent === 'number' ? r.actual_sent : null,
      }))
      .filter((r) => r.name);
    return items.length ? items : undefined;
  } catch (e) {
    stageLog(ctx, `[hypotheses] фактические замеры недоступны: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export async function runHypothesesStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);
  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const competitorsResult = await latestDoneJobResult<{ competitors?: HeCompetitorEntry[] }>(
    ctx.supabase,
    job.project_id,
    'competitors',
  );
  const competitors = (competitorsResult?.competitors ?? []).map((c) => ({
    name: c.name,
    url: c.url,
    why: c.why,
    geo: c.geo,
  }));

  const brandCloudResult = await latestDoneJobResult<{ entities?: HeBrandCloudOutput['entities'] }>(
    ctx.supabase,
    job.project_id,
    'brand_cloud',
  );
  const brandCloud = brandCloudResult?.entities ?? [];

  // Калибровочные данные — best-effort: сбой любого источника → undefined,
  // мгновенный проход продолжается без калибровки.
  const [portfolioProfile, markupHistory, actualsHistory] = await Promise.all([
    loadPortfolioProfile(ctx, market),
    loadMarkupHistory(ctx, job.project_id, market),
    loadActualsHistory(ctx, market),
  ]);

  // Рамка ЦА клиента (brief.icp — шаг «Brief» ENG-кабинета) — только в
  // EN-промпт и только как указание модели: после вызова ни один код гипотезы
  // с рамкой не сверяет (см. icpFrame.ts). На RU-рынке не читается вовсе, и
  // RU-вход промпта остаётся прежним. Читается вместе с проектом в начале
  // стадии: рамка, сохранённая после этого, войдёт в следующий прогон.
  const icpFrame = market === 'us' ? readHeIcpFrame(project.brief?.icp) : null;
  if (icpFrame) {
    stageLog(
      ctx,
      `[hypotheses] рамка ЦА клиента в промпте: target ${icpFrame.include.length}, exclude ${icpFrame.exclude.length}, `
        + `size ${icpFrame.size ? 'да' : 'нет'}, geo ${icpFrame.geo ? 'да' : 'нет'}`,
    );
  }

  // Страны сбора проекта (brief.collect_countries) — замок сборки: компании вне
  // списка не соберутся, и промпт обязан не предлагать рынки, которых в этих
  // странах нет (план 2026-10-16-eng-countries, §1A). Только us и только
  // непустой список — иначе вход промпта прежний байт в байт. Значения, которых
  // справочник больше не знает, и заглушка испорченного ключа в промпт не идут:
  // по ним не собирается ничего. Уже написанные гипотезы не переписываются —
  // список действует на новые прогоны.
  const collectCountries = market === 'us'
    ? (() => {
      const read = readHeCollectCountries(project.brief?.collect_countries);
      return read.countries
        .filter((c) => c !== HE_COLLECT_COUNTRIES_INVALID && !read.unavailable.includes(c))
        .map(engCountryLabel);
    })()
    : [];
  if (collectCountries.length) {
    stageLog(ctx, `[hypotheses] страны сбора проекта в промпте: ${collectCountries.length}`);
  }

  // Отклонённые человеком гипотезы проекта (us): запрет в промпте и фильтр ниже.
  const rejectedTitles = market === 'us' ? await readRejectedTitles(ctx, job.project_id) : [];
  if (rejectedTitles.length) {
    stageLog(
      ctx,
      `[hypotheses] отклонённых гипотез проекта: ${rejectedTitles.length} — в промпт запретом, совпавшие отсекаем кодом`,
    );
  }

  stageLog(
    ctx,
    market === 'us'
      ? '[hypotheses] мгновенный проход: до 15 широких аудиторий…'
      : '[hypotheses] мгновенный проход: 25–40 кандидатов…',
  );
  // Объект собираем переменной, а не литералом в вызове: поля portfolioProfile /
  // markupHistory добавляются в HypothesesPromptInput параллельным изменением —
  // так стадия компилируется и до, и после приземления промпт-контракта.
  const promptInput = {
    profile,
    websiteUrl: project.website_url,
    brandCloud,
    competitors,
    ...(portfolioProfile ? { portfolioProfile } : {}),
    ...(markupHistory ? { markupHistory } : {}),
    ...(actualsHistory ? { actualsHistory } : {}),
    // Ручное описание бизнеса (спасение тонких сайтов) — поверх профиля.
    ...(typeof project.brief?.business_override === 'string' && project.brief.business_override.trim()
      ? { businessOverride: project.brief.business_override.trim() }
      : {}),
    ...(icpFrame ? { icpFrame } : {}),
    ...(collectCountries.length ? { collectCountries } : {}),
    ...(rejectedTitles.length ? { rejectedTitles: rejectedTitles.slice(0, REJECTED_TITLES_PROMPT_LIMIT) } : {}),
  };
  const messages = (market === 'us' ? buildHypothesesInstantMessagesEn : buildHypothesesInstantMessages)(promptInput);
  // 25–40 гипотез с description/fit_rationale/rationale/search_queries на
  // русском — кириллические BPE-токены дорогие, 8–16k обрезало бы JSON
  // посередине (поймали на проде: Unterminated string).
  const options = { model: getHeModel('research'), maxTokens: 32768 };
  let candidates: HeHypothesisCandidate[];
  if (market === 'us') {
    candidates = await callHypothesesUs(ctx, messages, options, usage);
  } else {
    const llm = await callLLMWithSchema(messages, HeHypothesesBatchSchema, options);
    addUsage(usage, llm);
    candidates = llm.data.hypotheses;
  }
  logSoftChecks(ctx, candidates, market);

  if (market === 'us') {
    // Пустой title, отклонённое человеком и повторы title внутри ответа — до
    // evidence, где за каждого кандидата платят поиском и вердиктом. Пустой
    // title схема пропускает (пол считается по непустым), выбрасывается он здесь.
    const rejected = new Set(rejectedTitles.map(normTitle));
    const seen = new Set<string>();
    let blankDropped = 0;
    let rejectedDropped = 0;
    let duplicatesDropped = 0;
    candidates = candidates.filter((h) => {
      const key = normTitle(h.title);
      if (!key) {
        blankDropped += 1;
        return false;
      }
      if (rejected.has(key)) {
        rejectedDropped += 1;
        return false;
      }
      if (seen.has(key)) {
        duplicatesDropped += 1;
        return false;
      }
      seen.add(key);
      return true;
    });
    if (blankDropped || rejectedDropped || duplicatesDropped) {
      stageLog(
        ctx,
        `[hypotheses] отсечено: пустых title ${blankDropped}, отклонённых ранее ${rejectedDropped}, `
          + `повторов title ${duplicatesDropped}`,
      );
    }
  }

  const tierCounts = candidates.reduce<Record<number, number>>((acc, h) => {
    acc[h.tier] = (acc[h.tier] ?? 0) + 1;
    return acc;
  }, {});
  stageLog(ctx, `[hypotheses] кандидатов: ${candidates.length} (tier: ${JSON.stringify(tierCounts)})`);

  return {
    result: { candidates, tier_counts: tierCounts },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
