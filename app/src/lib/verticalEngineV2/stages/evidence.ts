/**
 * Стадия evidence — проход (b): верификация каждого кандидата реальными
 * источниками. Для каждого кандидата: 2–4 таргетированных Serper-запроса,
 * фетч топ-1–2 источников, LLM-вердикт keep/merge/drop + массив доказательств
 * (claim + quote + URL только из найденного) + перекалиброванный %.
 * Принятые гипотезы пишутся в ve_hypotheses (status='proposed').
 *
 * Устойчивость: сбой поиска → тонкие доказательства, стадия завершается;
 * сбой фетча источника → источник пропускается; сбой LLM по одному
 * кандидату → кандидат отбрасывается с reason='stage_error', остальные
 * продолжаются.
 *
 * Кодовая верификация (verifyEvidence.ts): каждый evidence-пункт проверяется
 * против реально скачанных источников (URL ∈ fetched, цитата — подстрока
 * текста). Сфабрикованные пункты отбрасываются; гипотеза без проверенных
 * доказательств капается по % (≤ 20) — см. evidence_dropped в result.
 */

import { callLLMWithSchema, getVeModel } from '../llm';
import {
  VeEvidenceVerdictSchema,
  type VeHypothesisCandidate,
  type VeSiteProfileOutput,
} from '../schemas';
import { projectMarket } from '../market';
import {
  moscowDateKey,
  normalizeVerifiedRuSeasonality,
} from '../ruSeasonality';
import { anchorPotentialPct } from '../scoreAnchor';
import { verifyEvidenceItems } from '../verifyEvidence';
import {
  buildEvidenceMessages,
  type EvidenceResearchSignal,
} from '../prompts/evidence';
import { buildEvidenceMessagesEn } from '../prompts/evidence.en';
import type {
  VeEvidenceItem,
  VeHypothesisTier,
  VeJob,
  VeRuSeasonality,
} from '../types';
import { loadMarkupHistory, loadPortfolioProfile } from './hypotheses';
import { resolveFetchText, resolveSearch } from './io';
import {
  addUsage,
  latestDoneJobResult,
  newUsage,
  readProject,
  readSiteProfile,
  stageLog,
  truncate,
  type VeStageContext,
  type VeStageResult,
} from './shared';

const MAX_MARKET_QUERIES_PER_CANDIDATE = 3;
const MAX_SEASONAL_QUERIES_PER_CANDIDATE = 3;
const MAX_SEARCH_ITEMS_PER_SCOPE = 6;
const MAX_MARKET_SOURCES = 2;
// Up to two corroborating pages per demand/availability/procurement lane when
// search has them; still bounded so one hypothesis cannot dominate stage cost.
const MAX_SEASONAL_SOURCES = 6;
const SOURCE_EXCERPT = 1500;
const MAX_EVIDENCE_PER_HYPOTHESIS = 6;

type EvidenceSearchScope = 'market' | 'seasonality';

interface ScopedSearchResult {
  title: string;
  link: string;
  snippet?: string;
  scope: EvidenceSearchScope;
  signal: EvidenceResearchSignal;
  query: string;
}

interface ScopedSource {
  url: string;
  text: string;
  scope: EvidenceSearchScope;
  signal: EvidenceResearchSignal;
  query: string;
}

interface EvidenceQueryLane {
  query: string;
  signal: EvidenceResearchSignal;
}

interface AcceptedHypothesis {
  tier: VeHypothesisTier;
  title: string;
  description: string;
  fit_rationale: string;
  evidence: VeEvidenceItem[];
  seasonality: VeRuSeasonality | null;
  potential_pct: number;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueQueries(queries: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of queries) {
    const query = raw.replace(/\s+/g, ' ').trim();
    const key = query.toLocaleLowerCase('ru-RU');
    if (!query || seen.has(key)) continue;
    seen.add(key);
    result.push(query);
    if (result.length >= limit) break;
  }
  return result;
}

function takeRoundRobin<T>(groups: T[][], limit: number): T[] {
  const result: T[] = [];
  for (let index = 0; result.length < limit; index += 1) {
    let found = false;
    for (const group of groups) {
      if (index >= group.length) continue;
      result.push(group[index]);
      found = true;
      if (result.length >= limit) break;
    }
    if (!found) break;
  }
  return result;
}

function roundRobinByQuery<T extends { query: string }>(items: T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.query) ?? [];
    group.push(item);
    groups.set(item.query, group);
  }
  return takeRoundRobin([...groups.values()], limit);
}

async function collectScopedSearchResults(input: {
  ctx: VeStageContext;
  search: NonNullable<VeStageContext['search']>;
  lanes: EvidenceQueryLane[];
  scope: EvidenceSearchScope;
}): Promise<ScopedSearchResult[]> {
  const discoveredLinks = new Set<string>();
  const laneResults: ScopedSearchResult[][] = [];
  for (const lane of input.lanes) {
    const results: ScopedSearchResult[] = [];
    try {
      for (const item of await input.search(lane.query)) {
        const link = item.link.trim();
        if (
          !link ||
          discoveredLinks.has(link) ||
          results.length >= MAX_SEARCH_ITEMS_PER_SCOPE
        ) continue;
        discoveredLinks.add(link);
        results.push({
          ...item,
          link,
          scope: input.scope,
          signal: lane.signal,
          query: lane.query,
        });
      }
    } catch (e) {
      stageLog(
        input.ctx,
        `[evidence] поиск «${lane.query}» упал: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    laneResults.push(results);
  }
  return takeRoundRobin(laneResults, MAX_SEARCH_ITEMS_PER_SCOPE);
}

async function fetchScopedSources(input: {
  ctx: VeStageContext;
  fetchText: NonNullable<VeStageContext['fetchText']>;
  marketResults: ScopedSearchResult[];
  seasonalResults: ScopedSearchResult[];
}): Promise<ScopedSource[]> {
  // Quotas guarantee that broad market results cannot crowd targeted seasonal
  // pages out of the bounded fetch budget. Within each scope, query-level
  // round-robin gives every signal lane one top-source opportunity.
  const selectedByUrl = new Map<string, ScopedSearchResult>();
  for (const item of roundRobinByQuery(input.marketResults, MAX_MARKET_SOURCES)) {
    selectedByUrl.set(item.link, item);
  }
  for (const item of roundRobinByQuery(input.seasonalResults, MAX_SEASONAL_SOURCES)) {
    // Fetch an overlapping URL only once, but retain its targeted seasonal
    // provenance when it participates in both discovery scopes.
    selectedByUrl.set(item.link, item);
  }
  const selected = [...selectedByUrl.values()];
  const sources: ScopedSource[] = [];
  for (const item of selected) {
    try {
      sources.push({
        url: item.link,
        text: truncate(await input.fetchText(item.link), SOURCE_EXCERPT),
        scope: item.scope,
        signal: item.signal,
        query: item.query,
      });
    } catch {
      stageLog(input.ctx, `[evidence] фетч ${item.link} пропущен`);
    }
  }
  return sources;
}

/**
 * Живой прогресс стадии → ve_jobs.progress ({done, total, label}); его
 * показывает UI шага «Исследование». Best-effort: сбой обновления
 * не должен валить стадию.
 */
async function reportProgress(
  ctx: VeStageContext,
  jobId: string,
  done: number,
  total: number,
  label: string,
): Promise<void> {
  try {
    await ctx.supabase
      .from('ve_jobs')
      .update({ progress: { done, total, label } })
      .eq('id', jobId);
  } catch {
    // прогресс — best-effort, сбой игнорируем
  }
}

export async function runEvidenceStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<VeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка ve_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const hypothesesResult = await latestDoneJobResult<{ candidates?: VeHypothesisCandidate[] }>(
    ctx.supabase,
    job.project_id,
    'hypotheses',
  );
  const candidates = hypothesesResult?.candidates ?? [];
  if (!candidates.length) {
    throw new Error('Нет кандидатов: сначала выполните стадию hypotheses');
  }
  const allTitles = candidates.map((c) => c.title);

  // Та же калибровка, что и на стадии hypotheses, — best-effort: сбой →
  // undefined, верификация продолжается. Грузим один раз на всех кандидатов.
  const [portfolioProfile, markupHistory] = await Promise.all([
    loadPortfolioProfile(ctx, market),
    loadMarkupHistory(ctx, job.project_id),
  ]);

  const accepted: AcceptedHypothesis[] = [];
  let merged = 0;
  let dropped = 0;
  let evidenceDropped = 0;
  const todayMoscow = moscowDateKey();

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    await reportProgress(ctx, job.id, i + 1, candidates.length, 'проверяем гипотезу');
    stageLog(ctx, `[evidence] «${candidate.title}»…`);

    // 1) General market research + a separate, bounded RU seasonality lane.
    // Both lanes reuse the same adapters but keep discovery dedup scope-local;
    // fetch-level dedup below prevents duplicate downloads without allowing a
    // broad market result outside its quota to hide targeted seasonal evidence.
    const fallbackQuery = market === 'us' ? `${candidate.title} market size` : `${candidate.title} рынок объём`;
    const marketQueries = uniqueQueries(
      candidate.search_queries.length ? candidate.search_queries : [fallbackQuery],
      MAX_MARKET_QUERIES_PER_CANDIDATE,
    );
    const marketLanes: EvidenceQueryLane[] = marketQueries.map((query) => ({
      query,
      signal: 'market',
    }));
    const seasonalLanes: EvidenceQueryLane[] = market === 'ru'
      ? [
          {
            query: `${candidate.title} сезонность спроса Россия высокий сезон`,
            signal: 'demand_peak',
          },
          {
            query: `${candidate.title} низкий сезон доступность ЛПР отпуска Россия`,
            signal: 'negative_availability',
          },
          {
            query: `${candidate.title} цикл закупок бюджеты планирование Россия`,
            signal: 'procurement_lead_time',
          },
        ].slice(0, MAX_SEASONAL_QUERIES_PER_CANDIDATE) as EvidenceQueryLane[]
      : [];
    const marketResults = await collectScopedSearchResults({
      ctx,
      search,
      lanes: marketLanes,
      scope: 'market',
    });
    const seasonalResults = await collectScopedSearchResults({
      ctx,
      search,
      lanes: seasonalLanes,
      scope: 'seasonality',
    });
    const searchResults = [...marketResults, ...seasonalResults];

    // 2) Fetch at most two market and six seasonal pages; failures are best-effort.
    const sources = await fetchScopedSources({
      ctx,
      fetchText,
      marketResults,
      seasonalResults,
    });

    // 3) LLM-вердикт. Сбой по одному кандидату → drop с reason='stage_error'.
    try {
      // Переменная, а не литерал (см. hypotheses.ts): промпт-контракт с полями
      // portfolioProfile / markupHistory приземляется параллельно.
      const verdictInput = {
        candidate,
        profile,
        allCandidateTitles: allTitles,
        sources,
        searchResults,
        todayMoscow,
        ...(portfolioProfile ? { portfolioProfile } : {}),
        ...(markupHistory ? { markupHistory } : {}),
      };
      const llm = await callLLMWithSchema(
        (market === 'us' ? buildEvidenceMessagesEn : buildEvidenceMessages)(verdictInput),
        VeEvidenceVerdictSchema,
        { model: getVeModel('research'), maxTokens: 4096 },
      );
      addUsage(usage, llm);
      const v = llm.data;

      if (v.verdict === 'drop') {
        dropped += 1;
        stageLog(ctx, `[evidence] drop: ${v.reason}`);
        continue;
      }

      // Кодовая пост-верификация: URL обязан быть среди скачанных источников,
      // цитата — подстрокой его текста. Сфабрикованное выкидываем; гипотеза
      // без единого проверенного доказательства капается по % (свои же правила
      // промпта: «нет доказательного пути» → низкий потенциал).
      const check = verifyEvidenceItems(v.evidence, sources);
      if (check.dropped > 0) {
        evidenceDropped += check.dropped;
        stageLog(
          ctx,
          `[evidence] «${candidate.title}»: отброшено ${check.dropped} недоказанных пунктов (URL/цитата не из скачанного)`,
        );
      }
      // Дата-якорь: программный матч сегмента датасета + факт reply% →
      // ограниченная поправка (0.7×LLM + 0.3×datasetScore). Без честного
      // матча/объёма — оценка LLM без изменений (см. scoreAnchor.ts).
      const anchor = await anchorPotentialPct(v.potential_pct, candidate.title, market);
      if (anchor.applied && anchor.pct !== v.potential_pct) {
        stageLog(ctx, `[evidence] «${candidate.title}»: ${v.potential_pct}% → ${anchor.pct}% (${anchor.note})`);
      }
      // Кап «нет проверенных доказательств» — ПОСЛЕ якоря: иначе горячий
      // сегмент датасета поднимал бы неверифицированную гипотезу до ~43%.
      const finalPct = check.valid.length === 0 ? Math.min(anchor.pct, 20) : anchor.pct;
      const rawSeasonality = v.seasonality ?? null;
      const seasonality = market === 'ru' && rawSeasonality !== null
        ? normalizeVerifiedRuSeasonality(rawSeasonality, sources)
        : null;
      if (
        rawSeasonality !== null &&
        rawSeasonality.classification !== 'unknown' &&
        seasonality?.classification === 'unknown'
      ) {
        stageLog(
          ctx,
          `[evidence] «${candidate.title}»: сезонность не подтверждена URL/цитатой, сохранён unknown`,
        );
      }

      if (v.verdict === 'merge' && v.merge_with_title) {
        const target = accepted.find((a) => normTitle(a.title) === normTitle(v.merge_with_title as string));
        if (target) {
          target.evidence = [...target.evidence, ...check.valid].slice(0, MAX_EVIDENCE_PER_HYPOTHESIS);
          target.potential_pct = Math.max(target.potential_pct, finalPct);
          if (
            (!target.seasonality || target.seasonality.classification === 'unknown') &&
            seasonality !== null &&
            seasonality.classification !== 'unknown'
          ) {
            target.seasonality = seasonality;
          }
          merged += 1;
          continue;
        }
        // Цель мержа не найдена среди принятых — трактуем как keep.
        stageLog(ctx, `[evidence] merge-цель «${v.merge_with_title}» не найдена, keep`);
      }

      accepted.push({
        tier: candidate.tier,
        title: candidate.title,
        description: candidate.description,
        // Вердикт обязан пронести fit_rationale (возможно, уточнив по фактам);
        // пустое поле — откат к исходной цепочке кандидата.
        fit_rationale: v.fit_rationale || candidate.fit_rationale,
        evidence: check.valid.slice(0, MAX_EVIDENCE_PER_HYPOTHESIS),
        seasonality,
        potential_pct: finalPct,
      });
    } catch (e) {
      dropped += 1;
      stageLog(ctx, `[evidence] stage_error по «${candidate.title}»: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Идемпотентная перезапись: сносим прошлые предложенные (ещё не
  //    кластеризованные) гипотезы проекта, вставляем свежие.
  const { error: delError } = await ctx.supabase
    .from('ve_hypotheses')
    .delete()
    .eq('project_id', job.project_id)
    .is('vertical_id', null)
    .eq('status', 'proposed');
  if (delError) throw new Error(`ve_hypotheses cleanup: ${delError.message}`);

  if (accepted.length) {
    const rows = accepted.map((a) => ({
      project_id: job.project_id,
      tier: a.tier,
      title: a.title,
      description: a.description,
      fit_rationale: a.fit_rationale,
      evidence: a.evidence,
      seasonality: a.seasonality,
      potential_pct: a.potential_pct,
      status: 'proposed',
    }));
    const { error: insError } = await ctx.supabase.from('ve_hypotheses').insert(rows);
    if (insError) throw new Error(`ve_hypotheses insert: ${insError.message}`);
  }

  const result = {
    total_candidates: candidates.length,
    kept: accepted.length,
    merged,
    dropped,
    evidence_dropped: evidenceDropped,
  };
  stageLog(ctx, `[evidence] итог: ${JSON.stringify(result)}`);
  return { result, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
