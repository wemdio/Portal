/**
 * Стадия evidence — проход (b): верификация каждого кандидата реальными
 * источниками. Для каждого кандидата: 2–4 таргетированных Serper-запроса,
 * фетч топ-1–2 источников, LLM-вердикт keep/merge/drop + массив доказательств
 * (claim + quote + URL только из найденного) + перекалиброванный %.
 * Принятые гипотезы пишутся в ve_hypotheses (status='proposed').
 *
 * Устойчивость: сбой поиска → тонкие доказательства, стадия завершается;
 * сбой фетча источника → источник пропускается. Отмена и таймаут LLM
 * останавливают этап; повторный запуск продолжает последний checkpoint,
 * не превращая незавершённого кандидата в drop. Временный отказ провайдера
 * также уходит в ограниченный retry; прочие ошибки, например валидация
 * ответа, сохраняют прежнее поведение stage_error для одного кандидата.
 *
 * Кодовая верификация (verifyEvidence.ts): каждый evidence-пункт проверяется
 * против реально скачанных источников (URL ∈ fetched, цитата — подстрока
 * текста). Сфабрикованные пункты отбрасываются; гипотеза без проверенных
 * доказательств капается по % (≤ 20) — см. evidence_dropped в result.
 */

import { callLLMWithSchema, getVeActiveJobSignal, getVeModel } from '../llm';
import { VeOperationTimeoutError, withVeDeadline } from '../operationDeadline';
import { evidenceInputHash, readEvidenceCheckpoint, type EvidenceCheckpoint } from '../evidenceCheckpoint';
import { isRetryableStageError } from '../jobRetry';
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
import type { VeJob } from '../types';
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
const READ_TIMEOUT_MS = 30_000;

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

function throwIfCancelled(ctx: VeStageContext, error?: unknown): void {
  ctx.signal?.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') throw error;
}

/** These adapters only read: a timed-out late result cannot publish stage state. */
async function optionalRead<T>(ctx: VeStageContext, label: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await withVeDeadline(label, READ_TIMEOUT_MS, ctx.signal, read);
  } catch (error) {
    throwIfCancelled(ctx, error);
    stageLog(ctx, `[evidence] ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
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
  report: (label: string) => Promise<void>;
}): Promise<ScopedSearchResult[]> {
  const discoveredLinks = new Set<string>();
  const laneResults: ScopedSearchResult[][] = [];
  for (const lane of input.lanes) {
    const results: ScopedSearchResult[] = [];
    await input.report(`поиск: ${lane.query}`);
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
      throwIfCancelled(input.ctx, e);
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
  report: (label: string) => Promise<void>;
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
    await input.report(`чтение источника: ${item.link}`);
    try {
      sources.push({
        url: item.link,
        text: truncate(await input.fetchText(item.link), SOURCE_EXCERPT),
        scope: item.scope,
        signal: item.signal,
        query: item.query,
      });
    } catch (error) {
      throwIfCancelled(input.ctx, error);
      stageLog(input.ctx, `[evidence] фетч ${item.link} пропущен`);
    }
  }
  return sources;
}

/**
 * Живой прогресс стадии → ve_jobs.progress ({done, total, label}); его
 * показывает UI шага «Исследование». Running CAS также проверяет владение:
 * отменённая/перехваченная задача больше не имеет права публиковать результат.
 */
async function reportProgress(
  ctx: VeStageContext,
  jobId: string,
  done: number,
  total: number,
  label: string,
): Promise<void> {
  const now = new Date().toISOString();
  await writeJobState(ctx, jobId, { progress: { done, total, label, substep_started_at: now, updated_at: now } });
  stageLog(ctx, `[evidence] ${done}/${total}: ${label}`);
}

class EvidenceCheckpointWriteError extends Error {}

async function writeJobState(ctx: VeStageContext, jobId: string, patch: Record<string, unknown>): Promise<void> {
  throwIfCancelled(ctx);
  try {
    const { data, error } = await ctx.supabase.from('ve_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', jobId).eq('status', 'running').select('id');
    throwIfCancelled(ctx);
    if (error || data?.length !== 1 || data[0].id !== jobId) throw new EvidenceCheckpointWriteError(`Evidence checkpoint/running ownership: ${error?.message ?? 'job is no longer running'}`);
  } catch (error) {
    throwIfCancelled(ctx, error);
    if (error instanceof EvidenceCheckpointWriteError) throw error;
    throw new EvidenceCheckpointWriteError(`Evidence checkpoint write: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveCheckpoint(ctx: VeStageContext, job: VeJob, checkpoint: EvidenceCheckpoint, total: number, label = 'сохранён прогресс проверки'): Promise<void> {
  const result = { ...job.result, evidence_checkpoint: structuredClone(checkpoint) };
  const now = new Date().toISOString();
  await writeJobState(ctx, job.id, {
    result, progress: { done: checkpoint.next_index, total, label, substep_started_at: now, updated_at: now },
  });
  job.result = result;
  stageLog(ctx, `[evidence] checkpoint ${checkpoint.next_index}/${total}: ${label}`);
}

export async function runEvidenceStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  ctx = { ...ctx, signal: ctx.signal ?? getVeActiveJobSignal() ?? undefined };
  throwIfCancelled(ctx);
  const project = await withVeDeadline('evidence project read', READ_TIMEOUT_MS, ctx.signal, () => readProject(ctx.supabase, job.project_id));
  const profile = readSiteProfile<VeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка ve_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const hypothesesResult = await withVeDeadline('evidence candidates read', READ_TIMEOUT_MS, ctx.signal, () => latestDoneJobResult<{ candidates?: VeHypothesisCandidate[] }>(
    ctx.supabase,
    job.project_id,
    'hypotheses',
  ));
  const candidates = hypothesesResult?.candidates ?? [];
  if (!candidates.length) {
    throw new Error('Нет кандидатов: сначала выполните стадию hypotheses');
  }
  const allTitles = candidates.map((c) => c.title);

  const model = getVeModel('research');
  const inputHash = evidenceInputHash({ project_id: job.project_id, market, profile, candidates, model });
  let checkpoint = readEvidenceCheckpoint(job.result?.evidence_checkpoint, inputHash, candidates.length);
  if (!checkpoint) {
    await reportProgress(ctx, job.id, 0, candidates.length, 'загружаем калибровку');
    const [portfolioProfile, markupHistory] = await Promise.all([
      optionalRead(ctx, 'portfolio read', () => loadPortfolioProfile(ctx, market), undefined),
      optionalRead(ctx, 'markup read', () => loadMarkupHistory(ctx, job.project_id), undefined),
    ]);
    checkpoint = {
      version: 1, input_hash: inputHash, next_index: 0, accepted: [], merged: 0, dropped: 0, evidence_dropped: 0,
      usage: newUsage(), today_moscow: moscowDateKey(), portfolio_profile: portfolioProfile ?? null, markup_history: markupHistory ?? null,
    };
    await saveCheckpoint(ctx, job, checkpoint, candidates.length);
  }
  const { accepted, usage } = checkpoint;
  const portfolioProfile = checkpoint.portfolio_profile;
  const markupHistory = checkpoint.markup_history;
  const todayMoscow = checkpoint.today_moscow;

  for (let i = checkpoint.next_index; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const report = (label: string) => reportProgress(ctx, job.id, i, candidates.length, `${candidate.title}: ${label}`);
    await report('проверяем гипотезу');
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
      report,
    });
    const seasonalResults = await collectScopedSearchResults({
      ctx,
      search,
      lanes: seasonalLanes,
      scope: 'seasonality',
      report,
    });
    const searchResults = [...marketResults, ...seasonalResults];

    // 2) Fetch at most two market and six seasonal pages; failures are best-effort.
    const sources = await fetchScopedSources({
      ctx,
      fetchText,
      marketResults,
      seasonalResults,
      report,
    });

    // 3) LLM-вердикт. Временный сбой/timeout → retry; отмена → остановка.
    // Прочие ошибки одного кандидата сохраняют прежний stage_error/drop.
    await report('вердикт модели');
    // Local returns for drop/merge must still reach the shared checkpoint below.
    await (async () => {
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
          { model, maxTokens: 4096, signal: ctx.signal },
        );
        throwIfCancelled(ctx);
        addUsage(usage, llm);
        // The model has already billed this response. Persist its usage before a
        // read-only anchor can time out; next_index remains the unfinished candidate.
        await saveCheckpoint(ctx, job, checkpoint, candidates.length, `${candidate.title}: ответ модели получен`);
        const v = llm.data;

        if (v.verdict === 'drop') {
          checkpoint.dropped += 1;
          stageLog(ctx, `[evidence] drop: ${v.reason}`);
          return;
        }

        // Кодовая пост-верификация: URL обязан быть среди скачанных источников,
        // цитата — подстрокой его текста. Сфабрикованное выкидываем; гипотеза
        // без единого проверенного доказательства капается по % (свои же правила
        // промпта: «нет доказательного пути» → низкий потенциал).
        const check = verifyEvidenceItems(v.evidence, sources);
        if (check.dropped > 0) {
          checkpoint.evidence_dropped += check.dropped;
          stageLog(
            ctx,
            `[evidence] «${candidate.title}»: отброшено ${check.dropped} недоказанных пунктов (URL/цитата не из скачанного)`,
          );
        }
        // Дата-якорь: программный матч сегмента датасета + факт reply% →
        // ограниченная поправка (0.7×LLM + 0.3×datasetScore). Без честного
        // матча/объёма — оценка LLM без изменений (см. scoreAnchor.ts).
        await report('сверка с данными кампаний');
        const anchor = await optionalRead(ctx, 'dataset anchor', () => anchorPotentialPct(v.potential_pct, candidate.title, market), { pct: v.potential_pct, applied: false });
        throwIfCancelled(ctx);
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
            checkpoint.merged += 1;
            return;
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
        throwIfCancelled(ctx, e);
        if (e instanceof EvidenceCheckpointWriteError || e instanceof VeOperationTimeoutError || (e instanceof Error && e.name === 'TimeoutError')) throw e;
        if (isRetryableStageError(e instanceof Error ? e.message : String(e))) throw e;
        checkpoint.dropped += 1;
        stageLog(ctx, `[evidence] stage_error по «${candidate.title}»: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    checkpoint.next_index = i + 1;
    await saveCheckpoint(ctx, job, checkpoint, candidates.length);
  }

  // 4) Идемпотентная перезапись: сносим прошлые предложенные (ещё не
  //    кластеризованные) гипотезы проекта, вставляем свежие.
  await reportProgress(ctx, job.id, checkpoint.next_index, candidates.length, 'сохраняем проверенные гипотезы');
  throwIfCancelled(ctx);
  const { error: delError } = await ctx.supabase
    .from('ve_hypotheses')
    .delete()
    .eq('project_id', job.project_id)
    .is('vertical_id', null)
    .eq('status', 'proposed');
  if (delError) throw new Error(`ve_hypotheses cleanup: ${delError.message}`);
  throwIfCancelled(ctx);

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
    throwIfCancelled(ctx);
    const { error: insError } = await ctx.supabase.from('ve_hypotheses').insert(rows);
    if (insError) throw new Error(`ve_hypotheses insert: ${insError.message}`);
    throwIfCancelled(ctx);
  }

  const result = {
    total_candidates: candidates.length,
    kept: accepted.length,
    merged: checkpoint.merged,
    dropped: checkpoint.dropped,
    evidence_dropped: checkpoint.evidence_dropped,
  };
  stageLog(ctx, `[evidence] итог: ${JSON.stringify(result)}`);
  return { result: { ...job.result, ...result }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
