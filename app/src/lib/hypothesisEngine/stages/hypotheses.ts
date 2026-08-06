/**
 * Стадия hypotheses — проход (a): мгновенный исчерпывающий список
 * гипотез-кандидатов (25–40, tier 1/2/3) из «генетической памяти» модели.
 * Кандидаты сохраняются в job.result.candidates — их верифицирует стадия
 * evidence. На этом шаге поиск и доказательства НЕ используются.
 */

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeHypothesesBatchSchema, type HeBrandCloudOutput, type HeSiteProfileOutput } from '../schemas';
import { projectMarket, type HeMarket } from '../market';
import { buildHypothesesInstantMessages } from '../prompts/hypotheses';
import { buildHypothesesInstantMessagesEn } from '../prompts/hypotheses.en';
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
} from './shared';
import type { HeCompetitorEntry } from './competitors';

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
    return await getPortfolioProfile({ limit: 10 });
  } catch (e) {
    stageLog(ctx, `[hypotheses] getPortfolioProfile упал: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * История ручной разметки гипотез ДРУГИХ проектов (accepted/rejected) —
 * калибровка «какие гипотезы живут / умирают на ревью специалиста».
 * Сбой чтения → undefined, стадия продолжается.
 */
export async function loadMarkupHistory(
  ctx: HeStageContext,
  projectId: string,
): Promise<HeMarkupHistory | undefined> {
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
 */
export async function loadActualsHistory(ctx: HeStageContext): Promise<HeActualsHistoryItem[] | undefined> {
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
    loadMarkupHistory(ctx, job.project_id),
    loadActualsHistory(ctx),
  ]);

  stageLog(ctx, '[hypotheses] мгновенный проход: 25–40 кандидатов…');
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
  };
  const llm = await callLLMWithSchema(
    (market === 'us' ? buildHypothesesInstantMessagesEn : buildHypothesesInstantMessages)(promptInput),
    HeHypothesesBatchSchema,
    // 25–40 гипотез с description/fit_rationale/rationale/search_queries на
    // русском — кириллические BPE-токены дорогие, 8–16k обрезало бы JSON
    // посередине (поймали на проде: Unterminated string).
    { model: getHeModel('research'), maxTokens: 32768 },
  );
  addUsage(usage, llm);

  const candidates = llm.data.hypotheses;
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
