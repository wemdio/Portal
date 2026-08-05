/**
 * Стадия evidence — проход (b): верификация каждого кандидата реальными
 * источниками. Для каждого кандидата: 2–4 таргетированных Serper-запроса,
 * фетч топ-1–2 источников, LLM-вердикт keep/merge/drop + массив доказательств
 * (claim + quote + URL только из найденного) + перекалиброванный %.
 * Принятые гипотезы пишутся в he_hypotheses (status='proposed').
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

import { callLLMWithSchema, getHeModel } from '../llm';
import {
  HeEvidenceVerdictSchema,
  type HeHypothesisCandidate,
  type HeSiteProfileOutput,
} from '../schemas';
import { projectMarket } from '../market';
import { verifyEvidenceItems } from '../verifyEvidence';
import { buildEvidenceMessages } from '../prompts/evidence';
import { buildEvidenceMessagesEn } from '../prompts/evidence.en';
import type { HeEvidenceItem, HeHypothesisTier, HeJob } from '../types';
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
  type HeStageContext,
  type HeStageResult,
} from './shared';

const MAX_QUERIES_PER_CANDIDATE = 3;
const MAX_SEARCH_ITEMS = 8;
const MAX_SOURCES_TO_FETCH = 2;
const SOURCE_EXCERPT = 1500;
const MAX_EVIDENCE_PER_HYPOTHESIS = 6;

interface AcceptedHypothesis {
  tier: HeHypothesisTier;
  title: string;
  description: string;
  fit_rationale: string;
  evidence: HeEvidenceItem[];
  potential_pct: number;
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Живой прогресс стадии → he_jobs.progress ({done, total, label}); его
 * показывает UI шага «Исследование». Best-effort: сбой обновления
 * не должен валить стадию.
 */
async function reportProgress(
  ctx: HeStageContext,
  jobId: string,
  done: number,
  total: number,
  label: string,
): Promise<void> {
  try {
    await ctx.supabase
      .from('he_jobs')
      .update({ progress: { done, total, label } })
      .eq('id', jobId);
  } catch {
    // прогресс — best-effort, сбой игнорируем
  }
}

export async function runEvidenceStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const project = await readProject(ctx.supabase, job.project_id);
  const profile = readSiteProfile<HeSiteProfileOutput>(project);
  const search = resolveSearch(ctx);
  const fetchText = resolveFetchText(ctx);
  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);

  const hypothesesResult = await latestDoneJobResult<{ candidates?: HeHypothesisCandidate[] }>(
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

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    await reportProgress(ctx, job.id, i + 1, candidates.length, 'проверяем гипотезу');
    stageLog(ctx, `[evidence] «${candidate.title}»…`);

    // 1) Поиск по запросам кандидата (2–4), дедуп ссылок, best-effort.
    const fallbackQuery = market === 'us' ? `${candidate.title} market size` : `${candidate.title} рынок объём`;
    const queries = (candidate.search_queries.length ? candidate.search_queries : [fallbackQuery])
      .slice(0, MAX_QUERIES_PER_CANDIDATE);
    const seenLinks = new Set<string>();
    const searchResults: Array<{ title: string; link: string; snippet?: string }> = [];
    for (const q of queries) {
      try {
        for (const item of await search(q)) {
          if (seenLinks.has(item.link) || searchResults.length >= MAX_SEARCH_ITEMS) continue;
          seenLinks.add(item.link);
          searchResults.push(item);
        }
      } catch (e) {
        stageLog(ctx, `[evidence] поиск «${q}» упал: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 2) Фетч топ-1–2 источников; сбойные пропускаем.
    const sources: Array<{ url: string; text: string }> = [];
    for (const item of searchResults.slice(0, MAX_SOURCES_TO_FETCH)) {
      try {
        sources.push({ url: item.link, text: truncate(await fetchText(item.link), SOURCE_EXCERPT) });
      } catch {
        stageLog(ctx, `[evidence] фетч ${item.link} пропущен`);
      }
    }

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
        ...(portfolioProfile ? { portfolioProfile } : {}),
        ...(markupHistory ? { markupHistory } : {}),
      };
      const llm = await callLLMWithSchema(
        (market === 'us' ? buildEvidenceMessagesEn : buildEvidenceMessages)(verdictInput),
        HeEvidenceVerdictSchema,
        { model: getHeModel('research'), maxTokens: 4096 },
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
      const verifiedPct =
        check.valid.length === 0 ? Math.min(v.potential_pct, 20) : v.potential_pct;

      if (v.verdict === 'merge' && v.merge_with_title) {
        const target = accepted.find((a) => normTitle(a.title) === normTitle(v.merge_with_title as string));
        if (target) {
          target.evidence = [...target.evidence, ...check.valid].slice(0, MAX_EVIDENCE_PER_HYPOTHESIS);
          target.potential_pct = Math.max(target.potential_pct, verifiedPct);
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
        potential_pct: verifiedPct,
      });
    } catch (e) {
      dropped += 1;
      stageLog(ctx, `[evidence] stage_error по «${candidate.title}»: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Идемпотентная перезапись: сносим прошлые предложенные (ещё не
  //    кластеризованные) гипотезы проекта, вставляем свежие.
  const { error: delError } = await ctx.supabase
    .from('he_hypotheses')
    .delete()
    .eq('project_id', job.project_id)
    .is('vertical_id', null)
    .eq('status', 'proposed');
  if (delError) throw new Error(`he_hypotheses cleanup: ${delError.message}`);

  if (accepted.length) {
    const rows = accepted.map((a) => ({
      project_id: job.project_id,
      tier: a.tier,
      title: a.title,
      description: a.description,
      fit_rationale: a.fit_rationale,
      evidence: a.evidence,
      potential_pct: a.potential_pct,
      status: 'proposed',
    }));
    const { error: insError } = await ctx.supabase.from('he_hypotheses').insert(rows);
    if (insError) throw new Error(`he_hypotheses insert: ${insError.message}`);
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
