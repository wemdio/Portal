/**
 * Стадия hypotheses — проход (a): мгновенный исчерпывающий список
 * гипотез-кандидатов (25–40, tier 1/2/3) из «генетической памяти» модели и
 * отдельным блоком 3–5 широких гипотез уровня сектора для ежедневного добора.
 * Кандидаты сохраняются в job.result.candidates — их верифицирует стадия
 * evidence. На этом шаге поиск и доказательства НЕ используются.
 */

import { callLLMWithSchema, getVeModel } from '../llm';
import {
  compileClientBriefForPrompt,
  compileClientBriefIcpForPrompt,
  readClientBrief,
} from '../clientBriefIntake';
import {
  VeHypothesesBatchSchema,
  type VeBrandCloudOutput,
  type VeHypothesesBatchOutput,
  type VeHypothesisCandidate,
  type VeSiteProfileOutput,
} from '../schemas';
import { projectMarket, type VeMarket } from '../market';
import { buildHypothesesInstantMessages, type HypothesesClientContextInput } from '../prompts/hypotheses';
import { buildHypothesesInstantMessagesEn } from '../prompts/hypotheses.en';
import { getPortfolioProfile, type VePortfolioEntry } from '../datasetStats';
import { VE_BROAD_HYPOTHESES_MAX } from '../broadHypotheses';
import type { VeJob, VeProject } from '../types';
import {
  addUsage,
  latestDoneJobResult,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  type VeStageContext,
  type VeStageResult,
} from './shared';
import type { VeCompetitorEntry } from './competitors';

/* ─────────────── широкие гипотезы ─────────────── */

export { VE_BROAD_HYPOTHESES_MAX };

function candidateTitleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Кандидаты стадии из ответа модели: широкие первыми и с признаком broad,
 * узкие — как раньше и без него. Широкая с названием узкой или другой широкой
 * отбрасывается: гипотезы проекта связываются с вертикалями по названию.
 */
export function combineHypothesisCandidates(output: VeHypothesesBatchOutput): VeHypothesisCandidate[] {
  const narrow = output.hypotheses.map((candidate) => {
    const copy: VeHypothesisCandidate = { ...candidate };
    delete copy.broad;
    return copy;
  });
  const seen = new Set(narrow.map((candidate) => candidateTitleKey(candidate.title)));
  const broad: VeHypothesisCandidate[] = [];
  for (const candidate of output.broad_hypotheses ?? []) {
    const key = candidateTitleKey(candidate.title);
    if (!key || seen.has(key) || broad.length >= VE_BROAD_HYPOTHESES_MAX) continue;
    seen.add(key);
    broad.push({ ...candidate, tier: 1, broad: true });
  }
  return [...broad, ...narrow];
}

/* ─────────────── калибровочные данные (best-effort) ─────────────── */

/** История ручной разметки гипотез: топ-N частотных title по каждому вердикту. */
export interface VeMarkupHistory {
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
): VeMarkupHistory {
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
  ctx: VeStageContext,
  market: VeMarket,
): Promise<VePortfolioEntry[] | undefined> {
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
  ctx: VeStageContext,
  projectId: string,
): Promise<VeMarkupHistory | undefined> {
  try {
    const { data, error } = await ctx.supabase
      .from('ve_hypotheses')
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
export interface VeActualsHistoryItem {
  name: string;
  predicted_pct: number;
  actual_reply_pct: number;
  actual_sent: number | null;
}

/**
 * Фактические замеры прошлых запусков (петля сверки, ve_verticals.actual_*)
 * — якоря шкалы potential_pct для промпта. До применения миграции
 * 20260806_0001 колонок нет → ошибка чтения → undefined (без них промпт
 * работает как раньше). Best-effort, как остальная калибровка.
 */
export async function loadActualsHistory(ctx: VeStageContext): Promise<VeActualsHistoryItem[] | undefined> {
  try {
    const { data, error } = await ctx.supabase
      .from('ve_verticals')
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

/**
 * Контекст клиента для генерации гипотез: профиль сайта, конкуренты и brand
 * cloud из прошлых стадий, бриф клиента и ручное описание бизнеса. Общий для
 * полного прохода и отдельной генерации широких (stages/broadHypotheses.ts).
 */
export async function loadHypothesesClientContext(
  ctx: VeStageContext,
  project: VeProject,
  logTag = '[hypotheses]',
): Promise<HypothesesClientContextInput> {
  const profile = readSiteProfile<VeSiteProfileOutput>(project);

  const competitorsResult = await latestDoneJobResult<{ competitors?: VeCompetitorEntry[] }>(
    ctx.supabase,
    project.id,
    'competitors',
  );
  const competitors = (competitorsResult?.competitors ?? []).map((c) => ({
    name: c.name,
    url: c.url,
    why: c.why,
    geo: c.geo,
  }));

  const brandCloudResult = await latestDoneJobResult<{ entities?: VeBrandCloudOutput['entities'] }>(
    ctx.supabase,
    project.id,
    'brand_cloud',
  );
  const brandCloud = brandCloudResult?.entities ?? [];

  const clientBriefRecord = readClientBrief(project);
  const clientBrief = compileClientBriefForPrompt(clientBriefRecord);
  // Рамка ЦА идёт отдельным блоком-ограничением: список «исключить» клиент
  // задал прямо, и такие сегменты не должны появляться даже с низким процентом.
  const clientBriefIcp = compileClientBriefIcpForPrompt(clientBriefRecord?.icp ?? null);
  if (clientBriefIcp) stageLog(ctx, `${logTag} рамка ЦА из брифа применена как ограничение`);

  return {
    profile,
    websiteUrl: project.website_url,
    brandCloud,
    competitors,
    // Ручное описание бизнеса (спасение тонких сайтов) — поверх профиля.
    ...(typeof project.brief?.business_override === 'string' && project.brief.business_override.trim()
      ? { businessOverride: project.brief.business_override.trim() }
      : {}),
    // Бриф клиента: ЦА, боли и возражения из первых рук — на сайте их нет.
    ...(clientBrief ? { clientBrief } : {}),
    ...(clientBriefIcp ? { clientBriefIcp } : {}),
  };
}

export async function runHypothesesStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  // Рынок: ctx.market (воркер), фолбэк — колонка ve_projects.market.
  const market = ctx.market ?? projectMarket(project);
  const clientContext = await loadHypothesesClientContext(ctx, project);

  // Калибровочные данные — best-effort: сбой любого источника → undefined,
  // мгновенный проход продолжается без калибровки.
  const [portfolioProfile, markupHistory, actualsHistory] = await Promise.all([
    loadPortfolioProfile(ctx, market),
    loadMarkupHistory(ctx, job.project_id),
    loadActualsHistory(ctx),
  ]);

  stageLog(ctx, '[hypotheses] мгновенный проход: 3–5 широких и 25–40 кандидатов…');
  // Объект собираем переменной, а не литералом в вызове: поля portfolioProfile /
  // markupHistory добавляются в HypothesesPromptInput параллельным изменением —
  // так стадия компилируется и до, и после приземления промпт-контракта.
  const promptInput = {
    ...clientContext,
    ...(portfolioProfile ? { portfolioProfile } : {}),
    ...(markupHistory ? { markupHistory } : {}),
    ...(actualsHistory ? { actualsHistory } : {}),
  };
  const llm = await callLLMWithSchema(
    (market === 'us' ? buildHypothesesInstantMessagesEn : buildHypothesesInstantMessages)(promptInput),
    VeHypothesesBatchSchema,
    // 25–40 гипотез с description/fit_rationale/rationale/search_queries на
    // русском — кириллические BPE-токены дорогие, 8–16k обрезало бы JSON
    // посередине (поймали на проде: Unterminated string).
    { model: getVeModel('hypotheses'), maxTokens: 32768 },
  );
  addUsage(usage, llm);

  const candidates = combineHypothesisCandidates(llm.data);
  const broadCount = candidates.filter((h) => h.broad).length;
  const tierCounts = candidates.filter((h) => !h.broad).reduce<Record<number, number>>((acc, h) => {
    acc[h.tier] = (acc[h.tier] ?? 0) + 1;
    return acc;
  }, {});
  stageLog(ctx, `[hypotheses] кандидатов: ${candidates.length} (широких: ${broadCount}, tier: ${JSON.stringify(tierCounts)})`);
  if (!broadCount) stageLog(ctx, '[hypotheses] модель не вернула широких гипотез — в проекте будут только узкие');

  return {
    result: { candidates, tier_counts: tierCounts, broad_count: broadCount },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
