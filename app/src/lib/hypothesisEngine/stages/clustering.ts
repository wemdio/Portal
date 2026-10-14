/**
 * Стадия clustering: LLM выносит решения о слиянии гипотез в вертикали,
 * pure-функция applyClusteringDecisions детерминированно применяет их
 * (матчинг по точному title, агрегация %, ранжирование), результат пишется
 * в he_verticals + he_hypotheses.vertical_id. Проект → status 'researched'.
 *
 * Рынок 'us': в кластеризацию идут только неотклонённые гипотезы проекта
 * (proposed — предложенные evidence, accepted — уже выбранные человеком), и
 * привязка к вертикали отклонённые не трогает. Отклонённая гипотеза прошлого
 * прогона иначе снова собиралась бы в вертикаль со своим процентом — то есть
 * отклонённый рынок предлагался бы заново. Прошлые 'proposed' здесь могут
 * быть: evidence рынка 'us' сносит их (все, и привязанные к вертикалям тоже)
 * только когда его прогон принял хотя бы одну гипотезу, и тогда сразу вставляет
 * свежие. Принял ноль — прошлые 'proposed' остаются как есть (в результате
 * evidence prior_proposed_kept), и кластеризация собирает их снова; дублей при
 * этом нет, потому что evidence ничего не вставлял, а прошлые вертикали этот
 * прогон сносит и привязку пересобирает целиком (ниже). Рынок 'ru' кластеризует
 * все гипотезы проекта, как раньше.
 *
 * Рынок 'us', ЗАПУСК (аудит 14.10.2026): снос вертикалей уносит каскадом
 * he_templates.launch_info — единственный список кампаний запуска, по которому
 * их ставят на паузу клиент, «Выключить отправку», блокировка, engBlockedSweep
 * и по которому he_sending_pool_launched держит ящики пула за проектом. Живые
 * кампании остались бы у рассыльщика без паузы и блокировки («бан
 * останавливает всё» перестало бы быть правдой), а ящики ушли бы следующему
 * проекту. Поэтому до платного вызова модели и ещё раз прямо перед сносом —
 * та же проверка, что у staff-роута исследования
 * (readHeResearchRerunLaunchBlock ниже); запуск есть — стадия ничего не
 * трогает и отказывает терминально (HeResearchRerunLaunchedError). Это
 * страховка: повтор, который до неё дошёл, уже прошёл стадии до
 * кластеризации (бриф, гипотезы и доказательства переписаны); основная
 * защита — отказ роутов исследования до постановки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { stripUnstorableJsonChars } from '@/lib/jsonbSafe';

import { callLLMWithSchema, getHeModel } from '../llm';
import { HeClusteringSchema, type HeClusteringDecision } from '../schemas';
import { projectMarket } from '../market';
import { buildClusteringMessages } from '../prompts/clustering';
import { buildClusteringMessagesEn } from '../prompts/clustering.en';
import type { HeHypothesis, HeJob } from '../types';
import {
  HE_TEMPLATE_LAUNCH_MARK_COLUMNS,
  heTemplateLaunchMarked,
  type HeTemplateLaunchMark,
} from '../launchTemplate';
import { engResearchRerunBlockers } from '../researchJob';
import {
  addUsage,
  newUsage,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
} from './shared';

/* ───────────────── Pure-часть: применение решений ───────────────── */

export interface ClusterHypothesisInput {
  title: string;
  potential_pct: number;
  description?: string;
  /** Тир гипотезы (1–3) — используется только в тай-брейке ранжирования. */
  tier?: number;
}

export interface AppliedVertical {
  name: string;
  summary: string;
  synonyms: string[];
  memberTitles: string[];
  potential_pct: number;
  rank: number;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Детерминированный % вертикали по % её участников:
 * max участников + 2 п.п. за каждого дополнительного, кап 95 —
 * плато и вырожденное ранжирование исключены. Нефинитные значения = 0.
 * Используется и при кластеризации, и при пересчёте после ручной
 * разметки гипотез (см. reviewRecompute.ts).
 */
export function computeVerticalPct(memberPcts: number[]): number {
  const maxPct = memberPcts.reduce(
    (acc, p) => Math.max(acc, Number.isFinite(p) ? p : 0),
    0,
  );
  return Math.min(95, maxPct + 2 * (memberPcts.length - 1));
}

function uniquePush(list: string[], values: string[]): string[] {
  const seen = new Set(list.map(normKey));
  const out = [...list];
  for (const v of values) {
    const k = normKey(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Применяет решения LLM о слиянии к списку гипотез:
 *  - member_titles матчатся по точному title (регистронезависимо, без
 *    лишних пробелов); каждая гипотеза попадает максимум в одну вертикаль
 *    (выигрывает первая решившая её вертикаль);
 *  - решения с одинаковым именем вертикали сливаются в одну;
 *  - решения без единого совпавшего member_title отбрасываются;
 *  - нераспределённые гипотезы становятся вертикалями-одиночками;
 *  - potential_pct вертикали считается детерминированно в коде (LLM его не
 *    задаёт): min(95, max(% участников) + 2 × (число участников − 1)) —
 *    max плюс небольшой бонус за ширину; кап 95 делает плато невозможным;
 *  - rank — по убыванию potential_pct (1 = лучшая); тай-брейки: больше
 *    участников → наличие более низкого тира → имя.
 *  Отклонённые гипотезы сюда не попадают: стадия evidence пишет в
 *  he_hypotheses только принятые, поэтому функция работает со всем входом.
 */
export function applyClusteringDecisions(
  hypotheses: ClusterHypothesisInput[],
  decisions: HeClusteringDecision[],
): AppliedVertical[] {
  const byNorm = new Map<string, ClusterHypothesisInput>();
  for (const h of hypotheses) {
    const k = normKey(h.title);
    if (k && !byNorm.has(k)) byNorm.set(k, h);
  }

  interface MutableGroup extends AppliedVertical {
    members: ClusterHypothesisInput[];
  }
  const groups: MutableGroup[] = [];
  const assigned = new Set<string>();

  for (const d of decisions) {
    const members: ClusterHypothesisInput[] = [];
    for (const title of d.member_titles) {
      const k = normKey(title);
      const h = byNorm.get(k);
      if (!h || assigned.has(k)) continue;
      assigned.add(k);
      members.push(h);
    }
    if (!members.length) continue;

    const existing = groups.find((g) => normKey(g.name) === normKey(d.name));
    if (existing) {
      existing.members.push(...members);
      existing.memberTitles = uniquePush(existing.memberTitles, members.map((m) => m.title));
      existing.synonyms = uniquePush(existing.synonyms, d.synonyms);
      if (!existing.summary && d.summary) existing.summary = d.summary;
    } else {
      groups.push({
        name: d.name,
        summary: d.summary,
        synonyms: uniquePush([], d.synonyms),
        memberTitles: uniquePush([], members.map((m) => m.title)),
        members,
        potential_pct: 0,
        rank: 0,
      });
    }
  }

  // Нераспределённые гипотезы → вертикали-одиночки (ничего не теряем).
  for (const h of hypotheses) {
    const k = normKey(h.title);
    if (!k || assigned.has(k)) continue;
    assigned.add(k);
    groups.push({
      name: h.title,
      summary: h.description ?? '',
      synonyms: [h.title],
      memberTitles: [h.title],
      members: [h],
      potential_pct: 0,
      rank: 0,
    });
  }

  // Детерминированный %: max участников + 2 п.п. за каждого дополнительного,
  // кап 95 — плато и вырожденное ранжирование исключены.
  for (const g of groups) {
    g.potential_pct = computeVerticalPct(g.members.map((m) => m.potential_pct));
  }

  // Лучший (минимальный) тир среди участников — для тай-брейка ранжирования.
  const minTier = (g: MutableGroup): number =>
    g.members.reduce(
      (acc, m) =>
        Math.min(acc, typeof m.tier === 'number' && Number.isFinite(m.tier) ? m.tier : Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );

  groups.sort(
    (a, b) =>
      b.potential_pct - a.potential_pct ||
      b.members.length - a.members.length ||
      minTier(a) - minTier(b) ||
      a.name.localeCompare(b.name),
  );
  groups.forEach((g, i) => {
    g.rank = i + 1;
  });

  return groups.map((g) => ({
    name: g.name,
    summary: g.summary,
    synonyms: g.synonyms,
    memberTitles: g.memberTitles,
    potential_pct: g.potential_pct,
    rank: g.rank,
  }));
}

/* ───────────── us-проект с запуском: повтор исследования запрещён ───────────── */

export type HeResearchRerunLaunchCheck =
  | {
      ok: true;
      /** Запуск есть: шаблон с меткой запуска ИЛИ he_sending_pool_launched. */
      launched: boolean;
      /** Шаблонов проекта с меткой запуска (heTemplateLaunchMarked). */
      launchedTemplates: number;
      /** Ответ he_sending_pool_launched([проект]). */
      poolLaunched: boolean;
    }
  | { ok: false; error: string };

/**
 * Есть ли у проекта запуск, который повтор исследования стёр бы вместе с
 * вертикалями. Правило — то же, что у research-роута ENG-кабинета
 * (engResearchRerunBlockers, вердикт 'launched': шаблон вертикали проекта с
 * меткой heTemplateLaunchMarked — кампания в записи или живая аренда), и
 * вдобавок функция пула he_sending_pool_launched (20261011_0001: то же правило
 * в SQL, ещё и по шаблонам баз проекта, а неразборчивую аренду считает
 * запуском). Запуск — если любое из двух говорит «да».
 *
 * Зовут: staff-роут исследования (api/tools/hypothesis-engine/projects/[id]/
 * research) до постановки и эта стадия перед сносом вертикалей — обе только у
 * рынка 'us'. Не бросает; сбой любого чтения — { ok: false } (вызывающий
 * отказывает: «не знаю, есть ли запуск» не равно «запуска нет»).
 */
export async function readHeResearchRerunLaunchBlock(
  db: SupabaseClient,
  projectId: string,
): Promise<HeResearchRerunLaunchCheck> {
  const fail = (what: string, error: { code?: unknown; message?: unknown } | null | undefined) => ({
    ok: false as const,
    error: `${what}: ${String(error?.code ?? 'error')} ${String(error?.message ?? '').slice(0, 200)}`.trim(),
  });
  try {
    const [verticalsRes, poolRes] = await Promise.all([
      db.from('he_verticals').select('id').eq('project_id', projectId),
      db.rpc('he_sending_pool_launched', { p_project_ids: [projectId] }),
    ]);
    if (verticalsRes.error) return fail('he_verticals read', verticalsRes.error);
    if (poolRes.error) return fail('he_sending_pool_launched rpc', poolRes.error);
    const verticalIds = (verticalsRes.data ?? [])
      .map((v) => (v as { id?: unknown }).id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    let marks: HeTemplateLaunchMark[] = [];
    if (verticalIds.length > 0) {
      const { data, error } = await db
        .from('he_templates')
        .select(HE_TEMPLATE_LAUNCH_MARK_COLUMNS)
        .in('vertical_id', verticalIds);
      if (error) return fail('he_templates read', error);
      marks = (data ?? []) as HeTemplateLaunchMark[];
    }
    const now = Date.now();
    // Снимок только с шаблонами: из вердиктов engResearchRerunBlockers здесь
    // важен лишь 'launched' — staff-повтор при 'busy' и 'confirm' идёт, как
    // раньше (он не спрашивает подтверждения и не ждёт работу по вертикалям).
    const { verdict, consequences } = engResearchRerunBlockers({
      bases: [],
      templates: marks.map((row) => ({ launched: heTemplateLaunchMarked(row, now) })),
      letterSequences: 0,
      activeWork: 0,
    });
    const poolLaunched = poolRes.data === true;
    return {
      ok: true,
      launched: verdict === 'launched' || poolLaunched,
      launchedTemplates: consequences.launched_templates,
      poolLaunched,
    };
  } catch (e) {
    return { ok: false, error: `launch check threw: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}` };
  }
}

/**
 * Кластеризация us-проекта с запуском отказала до сноса вертикалей. Класс
 * ТЕРМИНАЛЬНЫЙ (дискриминант heJobTerminal читает воркер, isHeJobTerminal):
 * повтор стадии упрётся в тот же запуск. Текст — he_jobs.error, его читает
 * сотрудник.
 */
export class HeResearchRerunLaunchedError extends Error {
  /** Дискриминант: instanceof ложен, если в бандле окажется две копии модуля. */
  readonly heJobTerminal = true as const;
  readonly code = 'research_rerun_launched' as const;

  constructor(check: { launchedTemplates: number; poolLaunched: boolean }) {
    super(
      'Кластеризация остановлена до удаления рынков: из этого проекта английского кабинета уже запускали ' +
        `отправку (шаблонов с записью о запуске: ${check.launchedTemplates}` +
        `${check.poolLaunched ? '; пул ящиков тоже считает проект запущенным' : ''}). Повтор исследования удалил бы ` +
        'рынки вместе с записями о запуске, и живые кампании остались бы без паузы клиента, выключения отправки ' +
        'и блокировки. Рынки, письма и записи о запуске не тронуты.',
    );
    this.name = 'HeResearchRerunLaunchedError';
  }
}

/**
 * Проверка стадии (только рынок 'us'). Сбой чтения — обычная ошибка: воркер
 * повторит стадию, ничего не удалено. Запуск есть — проект возвращается в
 * 'researched' (рынки и запуски на месте; CAS по 'researching' — отмену не
 * затираем): тогда воркер не пишет проекту 'failed' (он пишет его только из
 * 'researching'), кабинет клиента показывает прежние рынки, а не упавшее
 * исследование, и письма «research stopped» клиенту нет. Джоба — 'failed' с
 * текстом для сотрудника (HeResearchRerunLaunchedError, терминальный).
 */
async function refuseIfLaunched(job: HeJob, ctx: HeStageContext): Promise<void> {
  const launch = await readHeResearchRerunLaunchBlock(ctx.supabase, job.project_id);
  if (!launch.ok) throw new Error(`launch check before clustering: ${launch.error}`);
  if (!launch.launched) return;
  const { error: restoreError } = await ctx.supabase
    .from('he_projects')
    .update({ status: 'researched', updated_at: new Date().toISOString() })
    .eq('id', job.project_id)
    .eq('status', 'researching');
  if (restoreError) stageLog(ctx, `[clustering] project status restore: ${restoreError.message}`);
  stageLog(
    ctx,
    `[clustering] у us-проекта есть запуск (шаблонов: ${launch.launchedTemplates}, пул: ${launch.poolLaunched}) — вертикали не трогаем`,
  );
  throw new HeResearchRerunLaunchedError(launch);
}

/* ───────────────── Стадия ───────────────── */

export async function runClusteringStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();

  // Рынок: ctx.market (воркер), фолбэк — колонка he_projects.market (читаем
  // проект только в фолбэке: остальное стадии нужно из he_hypotheses).
  const market = ctx.market ?? projectMarket(await readProject(ctx.supabase, job.project_id));

  const { data: hyps, error } = market === 'us'
    ? await ctx.supabase
      .from('he_hypotheses')
      .select('*')
      .eq('project_id', job.project_id)
      .in('status', ['proposed', 'accepted'])
      .order('potential_pct', { ascending: false })
    : await ctx.supabase
      .from('he_hypotheses')
      .select('*')
      .eq('project_id', job.project_id)
      .order('potential_pct', { ascending: false });
  if (error) throw new Error(`he_hypotheses read: ${error.message}`);
  const hypotheses = (hyps ?? []) as HeHypothesis[];
  if (!hypotheses.length) {
    throw new Error('Нет верифицированных гипотез: сначала выполните стадию evidence');
  }

  // us-проект с запуском — отказ ДО платного вызова модели (шапка файла):
  // запуск, который был до старта исследования, виден уже здесь.
  if (market === 'us') await refuseIfLaunched(job, ctx);

  const llm = await callLLMWithSchema(
    (market === 'us' ? buildClusteringMessagesEn : buildClusteringMessages)({
      hypotheses: hypotheses.map((h) => ({
        title: h.title,
        tier: h.tier,
        description: h.description,
        potential_pct: h.potential_pct,
        evidence_count: Array.isArray(h.evidence) ? h.evidence.length : 0,
      })),
    }),
    HeClusteringSchema,
    { model: getHeModel('research'), maxTokens: 8192 },
  );
  addUsage(usage, llm);

  const verticals = applyClusteringDecisions(hypotheses, llm.data.verticals);
  stageLog(ctx, `[clustering] вертикалей: ${verticals.length} из ${hypotheses.length} гипотез`);

  // us-проект с запуском: ни отвязки, ни сноса (шапка файла). Вторая проверка —
  // прямо перед перезаписью: запуск, начатый, пока шёл вызов модели, тоже
  // виден (окно до удаления — одно чтение).
  if (market === 'us') await refuseIfLaunched(job, ctx);

  // Идемпотентная перезапись: отвязываем гипотезы, сносим старые вертикали.
  const { error: unlinkError } = await ctx.supabase
    .from('he_hypotheses')
    .update({ vertical_id: null })
    .eq('project_id', job.project_id);
  if (unlinkError) throw new Error(`he_hypotheses unlink: ${unlinkError.message}`);
  const { error: delError } = await ctx.supabase
    .from('he_verticals')
    .delete()
    .eq('project_id', job.project_id);
  if (delError) throw new Error(`he_verticals cleanup: ${delError.message}`);

  const written: Array<AppliedVertical & { id: string }> = [];
  for (const v of verticals) {
    // name/summary/synonyms — текст модели: один NUL или одиночный UTF-16
    // суррогат, и PostgREST отвергает вставку уже после оплаченного вызова и
    // после сноса прошлых вертикалей выше. Чистка трогает только эти два
    // символа: текст без них (вся кириллица и латиница) ложится байт-в-байт тем
    // же. Привязка гипотез ниже идёт по memberTitles — заголовкам из he_hypotheses,
    // а не по тексту модели, и чистка её не задевает.
    const { data: inserted, error: insError } = await ctx.supabase
      .from('he_verticals')
      .insert(stripUnstorableJsonChars({
        project_id: job.project_id,
        name: v.name,
        summary: v.summary,
        synonyms: v.synonyms,
        potential_pct: v.potential_pct,
        rank: v.rank,
      }))
      .select('id')
      .single();
    if (insError || !inserted) throw new Error(`he_verticals insert: ${insError?.message ?? 'unknown'}`);
    written.push({ ...v, id: (inserted as { id: string }).id });

    const { error: linkError } = market === 'us'
      ? await ctx.supabase
        .from('he_hypotheses')
        .update({ vertical_id: (inserted as { id: string }).id })
        .eq('project_id', job.project_id)
        .in('title', v.memberTitles)
        .neq('status', 'rejected')
      : await ctx.supabase
        .from('he_hypotheses')
        .update({ vertical_id: (inserted as { id: string }).id })
        .eq('project_id', job.project_id)
        .in('title', v.memberTitles);
    if (linkError) throw new Error(`he_hypotheses link: ${linkError.message}`);
  }

  const { error: projError } = await ctx.supabase
    .from('he_projects')
    .update({ status: 'researched', updated_at: new Date().toISOString() })
    .eq('id', job.project_id);
  if (projError) stageLog(ctx, `[clustering] project status update: ${projError.message}`);

  return { result: { verticals: written }, tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
}
