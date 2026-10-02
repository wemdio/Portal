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
 * продолжаются. Отмена задачи под эти правила НЕ попадает: поиск и чтение
 * ограничены сроком (io.ts) и слушают сигнал джобы, а отменённая стадия
 * прерывается — отменённая гипотеза не должна уехать в статистику как
 * отброшенная (dropped), это разные исходы.
 *
 * Под эти правила НЕ попадает и отказ ДОСТУПА к провайдеру (поиск: деньги,
 * ключ; модель: деньги, ключ, а на рынке us ещё и лимит частоты): он
 * перманентен для прогона, то есть повторится на каждом следующем кандидате, и
 * стадия прерывается ДО перезаписи he_hypotheses. Туда же — ПОЛНЫЙ отказ поиска
 * (ни одного обслуженного запроса за двух кандидатов подряд): «тонкие
 * доказательства» это про один кандидат, а не про прогон, у которого источников
 * нет вовсе. 429 модели на RU (легаси /tools/hypothesis-engine) поглощается
 * поэлементно, как до волны 3: кандидат уходит в stage_error, стадия кончается
 * за одно исполнение (политика — heRunStoppingLlmFailure в brandCloud.ts).
 *
 * Чекпойнт перебора (только market='us'): после каждого кандидата пройденный
 * префикс (принятые гипотезы и счётчики) пишется в he_jobs.result этой же
 * джобы, и повтор джобы — после паузы по 429, прерывания или обычного фейла —
 * продолжает с него. Вердикты, уже оплаченные вызовом ресёрч-модели, второй раз
 * не покупаются (как и поиск по их кандидатам). Механизм и его границы — у
 * HE_ITEM_CHECKPOINT_KEY в brandCloud.ts.
 *
 * Сама перезапись стала условной: снос прошлых 'proposed' гипотез проекта
 * делается только если этот прогон принял хотя бы одну — иначе ночь заменяла
 * хороший набор пустым.
 *
 * Кодовая верификация (verifyEvidence.ts): каждый evidence-пункт проверяется
 * против реально скачанных источников (URL ∈ fetched, цитата — подстрока
 * текста). Сфабрикованные пункты отбрасываются; гипотеза без проверенных
 * доказательств капается по % (≤ 20) — см. evidence_dropped в result.
 */

import { z } from 'zod';

import { callLLMWithSchema, getHeModel } from '../llm';
import {
  HeEvidenceItemSchema,
  HeEvidenceVerdictSchema,
  type HeEvidenceVerdict,
  type HeHypothesisCandidate,
  type HeSiteProfileOutput,
} from '../schemas';
import { projectMarket } from '../market';
import { anchorPotentialPct } from '../scoreAnchor';
import { verifyEvidenceItems } from '../verifyEvidence';
import { buildEvidenceMessages } from '../prompts/evidence';
import { buildEvidenceMessagesEn } from '../prompts/evidence.en';
import type { HeEvidenceItem, HeHypothesisTier, HeJob } from '../types';
// Политика «какой отказ провайдера модели останавливает прогон» и чекпойнт
// перебора — одни на две стадии с поэлементным платным вызовом; их дом
// brandCloud.ts (там же docblock).
import {
  heItemCheckpointFingerprint,
  heLlmRefusalLabel,
  heRunStoppingLlmFailure,
  readHeItemCheckpoint,
  writeHeItemCheckpoint,
} from './brandCloud';
import { loadMarkupHistory, loadPortfolioProfile } from './hypotheses';
import { heStageSignal, resolveFetchText, resolveSearch } from './io';
import {
  heSearchFailureStatus,
  heSearchOutageFailure,
  heSearchStageFailure,
  newHeSearchTally,
  noteHeSearchAnswered,
  noteHeSearchFailure,
} from './searchIo';
import { heIoFailureReason } from '../operationDeadline';
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
 * Чекпойнт перебора кандидатов (только market='us', см. HE_ITEM_CHECKPOINT_KEY
 * в brandCloud.ts): кандидаты [0, next) пройдены — их вердикты (keep/merge/drop)
 * и поэлементные сбои уже учтены в accepted и счётчиках. Кандидат, на котором
 * прогон остановился, в префикс не входит и на повторе спрашивается заново.
 */
const EvidenceCheckpointSchema = z.object({
  stage: z.literal('evidence'),
  v: z.literal(1),
  fingerprint: z.string(),
  next: z.number().int().min(1),
  accepted: z.array(
    z.object({
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      title: z.string(),
      description: z.string(),
      fit_rationale: z.string(),
      evidence: z.array(HeEvidenceItemSchema),
      potential_pct: z.number(),
    }),
  ),
  merged: z.number().int().min(0),
  dropped: z.number().int().min(0),
  evidence_dropped: z.number().int().min(0),
  search_answered: z.number().int().min(0),
});
type EvidenceCheckpoint = z.infer<typeof EvidenceCheckpointSchema>;

/** Годный чекпойнт этого входа или null (с причиной в логе, если он был). */
function readEvidenceCheckpoint(
  ctx: HeStageContext,
  job: HeJob,
  fingerprint: string,
  total: number,
): EvidenceCheckpoint | null {
  const raw = readHeItemCheckpoint(job);
  if (raw === null) return null;
  const parsed = EvidenceCheckpointSchema.safeParse(raw);
  if (!parsed.success || parsed.data.fingerprint !== fingerprint || parsed.data.next > total) {
    stageLog(ctx, '[evidence] чекпойнт прошлого исполнения не подходит к этому входу — перебор с начала');
    return null;
  }
  return parsed.data;
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
  const jobSignal = heStageSignal(ctx);
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
    loadMarkupHistory(ctx, job.project_id, market),
  ]);

  // Чекпойнт перебора — только us: на RU 429 не останавливает перебор, и
  // легаси-инструмент лишних записей в he_jobs не получает. Отпечаток — по
  // кандидатам целиком: другой результат стадии hypotheses — другой вход.
  const resumable = market === 'us';
  const fingerprint = resumable ? heItemCheckpointFingerprint(candidates) : '';
  const restored = resumable ? readEvidenceCheckpoint(ctx, job, fingerprint, candidates.length) : null;
  if (restored) {
    stageLog(
      ctx,
      `[evidence] продолжаем с чекпойнта прошлого исполнения этой джобы: ${restored.next}/${candidates.length} `
        + `кандидатов уже проверено (принято ${restored.accepted.length}), их вердикты повторно не покупаем`,
    );
  }
  const accepted: AcceptedHypothesis[] = restored ? restored.accepted : [];
  let merged = restored?.merged ?? 0;
  let dropped = restored?.dropped ?? 0;
  let evidenceDropped = restored?.evidence_dropped ?? 0;

  /**
   * Вердикт keep/merge кандидата → пост-верификация, якорь, кап и слияние.
   * Вынесено из цикла, чтобы у каждой ветки цикла был один выход — к записи
   * чекпойнта после кандидата (us), — а не `continue` мимо неё.
   */
  const settleVerdict = async (
    candidate: HeHypothesisCandidate,
    v: HeEvidenceVerdict,
    sources: Array<{ url: string; text: string }>,
  ): Promise<void> => {
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

    if (v.verdict === 'merge' && v.merge_with_title) {
      const target = accepted.find((a) => normTitle(a.title) === normTitle(v.merge_with_title as string));
      if (target) {
        target.evidence = [...target.evidence, ...check.valid].slice(0, MAX_EVIDENCE_PER_HYPOTHESIS);
        target.potential_pct = Math.max(target.potential_pct, finalPct);
        merged += 1;
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
      potential_pct: finalPct,
    });
  };

  // Подпись прогресса уезжает в he_jobs.progress.label и печатается клиенту
  // как есть (блок «Right now» кабинета ENG), поэтому зависит от рынка, а не
  // переводится насовсем: тот же V1 обслуживает русский внутренний инструмент.
  const progressLabel = market === 'us' ? 'checking a hypothesis' : 'проверяем гипотезу';
  // Счётчик один на всё исполнение: «тонкие доказательства» из-за пустой выдачи
  // по одному кандидату — норма, а вот НУЛЬ обслуженных запросов за всю стадию
  // означает, что кластеризация ранжировала бы гипотезы по пустоте. Остановка по
  // полному отказу поиска (heSearchOutageFailure) судит по ЭТОМУ исполнению —
  // о том, что поиск делает сейчас; обслуженные запросы префикса из чекпойнта
  // (только us) учитываются лишь в итоговой проверке после цикла.
  const tally = newHeSearchTally();
  const restoredSearchAnswered = restored?.search_answered ?? 0;
  let searchedThisRun = 0;

  for (let i = restored?.next ?? 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    await reportProgress(ctx, job.id, i + 1, candidates.length, progressLabel);
    stageLog(ctx, `[evidence] «${candidate.title}»…`);

    // 1) Поиск по запросам кандидата (2–4), дедуп ссылок, best-effort.
    const fallbackQuery = market === 'us' ? `${candidate.title} market size` : `${candidate.title} рынок объём`;
    const queries = (candidate.search_queries.length ? candidate.search_queries : [fallbackQuery])
      .slice(0, MAX_QUERIES_PER_CANDIDATE);
    const seenLinks = new Set<string>();
    const searchResults: Array<{ title: string; link: string; snippet?: string }> = [];
    for (const q of queries) {
      try {
        const items = await search(q);
        noteHeSearchAnswered(tally);
        for (const item of items) {
          if (seenLinks.has(item.link) || searchResults.length >= MAX_SEARCH_ITEMS) continue;
          seenLinks.add(item.link);
          searchResults.push(item);
        }
      } catch (e) {
        if (jobSignal?.aborted) throw e;
        noteHeSearchFailure(tally, e);
        stageLog(ctx, `[evidence] поиск «${q}» упал: ${heIoFailureReason(e)}`);
      }
    }
    // Ниже на КАЖДОГО кандидата идёт платный вызов ресёрч-модели, и его вход —
    // ровно то, что нашёл поиск. Останавливаемся до вызова и ДО перезаписи
    // he_hypotheses (прошлые предложенные гипотезы проекта должны уцелеть) в
    // двух случаях: отказ по деньгам/ключу сам не пройдёт, а поиск, не
    // обслуживший НИ ОДНОГО запроса за два кандидата подряд, лёг целиком —
    // остальным кандидатам достанется тот же пустой массив источников
    // (heSearchOutageFailure). Одна пустая выдача, один упавший кандидат и
    // одиночный блип сюда не попадают: первая считается обслуженной, вторые два
    // не переживают следующего кандидата.
    searchedThisRun += 1;
    const outage = heSearchOutageFailure(tally, searchedThisRun);
    if (outage) {
      stageLog(
        ctx,
        `[evidence] поиск отказал (обслужено запросов: ${tally.answered}) — `
          + `стадия остановлена на «${candidate.title}» (${i}/${candidates.length}), `
          + `до платного вызова модели: ${heIoFailureReason(outage)}${heSearchFailureStatus(outage)}`,
      );
      throw outage;
    }

    // 2) Фетч топ-1–2 источников; сбойные пропускаем.
    const sources: Array<{ url: string; text: string }> = [];
    for (const item of searchResults.slice(0, MAX_SOURCES_TO_FETCH)) {
      try {
        sources.push({ url: item.link, text: truncate(await fetchText(item.link), SOURCE_EXCERPT) });
      } catch (e) {
        if (jobSignal?.aborted) throw e;
        // Причину печатаем: истёкший срок и «источник не отдался» — разные
        // исходы, а раньше в логе не было ни того, ни другого.
        stageLog(ctx, `[evidence] фетч ${item.link} пропущен: ${heIoFailureReason(e)}`);
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
      } else {
        await settleVerdict(candidate, v, sources);
      }
    } catch (e) {
      // Отмена задачи — не «кандидат отброшен»: прерываем стадию, иначе цифра
      // dropped соврёт, а перебор продолжит тратить деньги после отмены.
      if (jobSignal?.aborted) throw e;
      // Отказ ДОСТУПА к модели (деньги, ключ; на us ещё и лимит частоты) — тоже
      // не «кандидат отброшен»: остальные кандидаты получат тот же ответ,
      // dropped соврёт на все оставшиеся, а перезапись he_hypotheses ниже
      // заменила бы хороший набор гипотез проекта пустым. Проглоченный здесь,
      // этот класс не доходил до джобы — а пауза по 429 и терминальный отказ по
      // 402/401 живут именно там. Бросаем исходную ошибку: воркеру нужен её тип
      // целым. Чекпойнт (us) при этом остаётся на предыдущем кандидате: этот в
      // префикс не попал и на повторе будет спрошен заново. 429 на RU сюда не
      // попадает и поглощается ниже как stage_error (heRunStoppingLlmFailure).
      const refusal = heRunStoppingLlmFailure(e, market);
      if (refusal) {
        stageLog(
          ctx,
          `[evidence] провайдер модели отказал (${heLlmRefusalLabel(refusal)}) — стадия остановлена `
            + `на «${candidate.title}» (${i}/${candidates.length}), до записи в he_hypotheses: `
            + `${heIoFailureReason(e)}`,
        );
        throw e;
      }
      dropped += 1;
      stageLog(ctx, `[evidence] stage_error по «${candidate.title}»: ${heIoFailureReason(e)}`);
    }
    if (resumable) {
      await writeHeItemCheckpoint(
        ctx,
        job,
        {
          stage: 'evidence',
          v: 1,
          fingerprint,
          next: i + 1,
          accepted,
          merged,
          dropped,
          evidence_dropped: evidenceDropped,
          search_answered: restoredSearchAnswered + tally.answered,
        },
        '[evidence]',
      );
    }
  }

  // Отказ поиска на ВСЕХ запросах (или перманентный отказ где угодно):
  // доказательств не искали, а не «не нашли». Падаем до удаления прошлых
  // предложенных гипотез — иначе проект остался бы и без старых, и без новых.
  const searchFailure = heSearchStageFailure({ ...tally, answered: tally.answered + restoredSearchAnswered });
  if (searchFailure) {
    stageLog(
      ctx,
      `[evidence] поиск не обслужил ни одного запроса по ${candidates.length} кандидатам `
        + `(обслужено: ${tally.answered}) — стадия остановлена до записи: `
        + `${heIoFailureReason(searchFailure)}${heSearchFailureStatus(searchFailure)}`,
    );
    throw searchFailure;
  }

  // 4) Идемпотентная перезапись: сносим прошлые предложенные (ещё не
  //    кластеризованные) гипотезы проекта, вставляем свежие.
  //
  //    Снос — ТОЛЬКО если этому прогону есть чем заменить. Пустой accepted — это
  //    либо «модель забраковала всех кандидатов», либо «прогон не смог их
  //    проверить», и различить их здесь нечем; а снос в обоих случаях оставлял
  //    проект БЕЗ гипотез: хороший набор прошлой ночи молча заменялся ничем, и
  //    кабинет показывал завершившееся исследование с пустым списком.
  //    Идемпотентность от этого не страдает: дубли создаёт только вставка, а
  //    она в этой ветке не выполняется.
  if (accepted.length) {
    const { error: delError } = await ctx.supabase
      .from('he_hypotheses')
      .delete()
      .eq('project_id', job.project_id)
      .is('vertical_id', null)
      .eq('status', 'proposed');
    if (delError) throw new Error(`he_hypotheses cleanup: ${delError.message}`);

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
  } else {
    // Молчать нельзя: снаружи (и в кабинете) прогон выглядит завершившимся, а
    // гипотезы в нём — прошлой ночи. Флаг дублируется в result, чтобы это
    // читалось из he_jobs.result, а не только из лога прогона.
    stageLog(
      ctx,
      `[evidence] принятых гипотез нет (кандидатов ${candidates.length}, отброшено ${dropped}) — `
        + 'прошлые предложенные гипотезы проекта ОСТАВЛЕНЫ как есть',
    );
  }

  const result = {
    total_candidates: candidates.length,
    kept: accepted.length,
    merged,
    dropped,
    evidence_dropped: evidenceDropped,
    ...(accepted.length ? {} : { prior_proposed_kept: true }),
  };
  stageLog(ctx, `[evidence] итог: ${JSON.stringify(result)}`);
  return { result, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
