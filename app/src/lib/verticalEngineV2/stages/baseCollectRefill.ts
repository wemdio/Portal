/**
 * Refill-ветка стадии base_collect (ENG auto-pipeline Движка вертикалей):
 * ежедневный добор лидов в УЖЕ запущенную кампанию us-проекта.
 *
 * Срабатывает только при payload.refill джобы (такую джобу ставит крон
 * app/worker/heAutoPipelineCron.ts через enqueueVeBaseCollect с refill-полями).
 * Отличия от обычного пути base_collect:
 *   - base_analyze и template НЕ ставятся — собранные строки не идут в мастер,
 *     а мапятся в лиды и доливаются в существующую кампанию Instantly;
 *   - кампания: collect_info.campaign_id (снапшот на постановке), фолбэк —
 *     последний по дате запуска шаблон вертикали с launch_info; маппинг
 *     колонок → переменные — operator_mapping того же шаблона (как при
 *     первичном запуске, mapBaseRowsToLeads из launchHandoff);
 *   - лиды: только строки с email И вердиктом валидации 'ok' (колонка
 *     «Email Статус» сетки конструктора; catch_all/invalid/disposable
 *     исключаем — TODO: catch_all может дать часть рабочих адресов, пока
 *     сознательно не шлём). Если валидации не было (конструктор пропущен
 *     или не дошёл до validate_emails) — статус неизвестен, берём все
 *     строки с email: ровно так ведёт себя первичный запуск;
 *   - кап daily_leads_cap конфига — на ПРОЕКТ в сутки (UTC): уже долитое
 *     сегодня другими refill'ами вычитается;
 *   - blocklist владельца пресета и чанкование — внутри
 *     appendLeadsToClientCampaign (тот же путь, что у RU auto-pipeline);
 *   - терминальный статус базы — 'analyzed' (не 'analyzing': анализа не
 *     будет), итог — в collect_info.refill_result и ve_auto_pipeline_runs;
 *   - пустой harvest — ШТАТНЫЙ исход добора («новых компаний нет»): база
 *     НЕ failed, прогон 'no_new', джоба завершается успешно;
 *   - ошибка долива (Instantly/пресет/тарифный гейт) — НЕ валит джобу:
 *     собранная база сохраняется, прогон 'failed' с текстом ошибки, а
 *     завтрашний тик крона поставит новую refill-сборку. Повторный прогон
 *     ЭТОЙ базы невозможен — стадия работает только из статуса 'collecting'.
 */

import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import { filterBlockedLeads, getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { mapBaseRowsToLeads, parseLaunchInfo } from '../launchHandoff';
import type { VeJob, VeOperatorMapping } from '../types';
import { stageLog, type VeStageContext, type VeStageResult, type VeUsage } from './shared';
import {
  SAMPLE_ROWS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from './baseCollect';

/** Дефолт дневного капа лидов на проект — зеркало DEFAULT миграции 20260804_0005. */
export const VE_AUTO_DEFAULT_DAILY_LEADS_CAP = 50;

/** Статистика воронки долива (ve_auto_pipeline_runs.stats + refill_result). */
export interface VeRefillStats {
  /** Строк собрано сборкой (после импорта конструктора). */
  collected: number;
  /** Строк с непустым email. */
  with_email: number;
  /** Строк с email и вердиктом 'ok' (либо без валидации — см. шапку). */
  valid: number;
  /** Принято Instantly. */
  appended: number;
  /** Отрезано blocklist'ом владельца пресета. */
  skipped_blocklist: number;
  /** Отсеяно Instantly при загрузке (дубли кампании и пр.). */
  skipped_instantly: number;
  /** Не влезло в дневной кап daily_leads_cap (уйдёт в отчёт, не в кампанию). */
  capped: number;
}

/** Итог refill-ветки: он же collect_info.refill_result и (по полям) runs-запись. */
export interface VeRefillResult {
  status: 'appended' | 'no_new' | 'failed';
  campaign_id?: string;
  stats?: VeRefillStats;
  error?: string;
  completed_at: string;
}

interface RefillConfigRow {
  id: string;
  dailyLeadsCap: number;
}

/** Начало текущих UTC-суток — дневной бюджет daily_leads_cap считается по ним. */
function utcDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Конфиг auto-pipeline проекта. Best-effort: таблицы миграции может ещё не
 * быть на окружении (воркер выкатили раньше миграции) — тогда долив идёт с
 * дефолтным капом, а runs-запись пишется без config_id.
 */
async function loadRefillConfig(ctx: VeStageContext, projectId: string): Promise<RefillConfigRow | null> {
  try {
    const { data, error } = await ctx.supabase
      .from('ve_auto_pipeline_configs')
      .select('id, daily_leads_cap')
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { id?: unknown; daily_leads_cap?: unknown };
    const cap =
      typeof row.daily_leads_cap === 'number' && Number.isFinite(row.daily_leads_cap)
        ? row.daily_leads_cap
        : VE_AUTO_DEFAULT_DAILY_LEADS_CAP;
    return { id: String(row.id), dailyLeadsCap: cap };
  } catch (e) {
    stageLog(
      ctx,
      `[base_collect] refill: ve_auto_pipeline_configs read: ${e instanceof Error ? e.message : String(e)} — кап по умолчанию`,
    );
    return null;
  }
}

/**
 * Финал прогона в ve_auto_pipeline_runs: крон пишет строку 'collecting' при
 * постановке — обновляем её по base_id; не нашли (refill поставлен вручную) —
 * вставляем финальную строку целиком. Best-effort: журнал — аудит, падение
 * записи не должно валить стадию после уже случившегося долива.
 */
async function writeRefillRun(
  ctx: VeStageContext,
  write: {
    configId: string | null;
    projectId: string;
    verticalId: string;
    baseId: string;
    result: VeRefillResult;
  },
): Promise<void> {
  const patch = {
    status: write.result.status,
    stats: (write.result.stats ?? {}) as Record<string, unknown>,
    error: write.result.error ?? null,
    completed_at: write.result.completed_at,
  };
  try {
    const { data: existing, error: findErr } = await ctx.supabase
      .from('ve_auto_pipeline_runs')
      .select('id')
      .eq('base_id', write.baseId)
      .eq('status', 'collecting')
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (existing) {
      const { error } = await ctx.supabase
        .from('ve_auto_pipeline_runs')
        .update(patch)
        .eq('id', (existing as { id: string }).id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await ctx.supabase.from('ve_auto_pipeline_runs').insert({
        config_id: write.configId,
        project_id: write.projectId,
        vertical_id: write.verticalId,
        base_id: write.baseId,
        ...patch,
      });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    stageLog(
      ctx,
      `[base_collect] refill: запись ve_auto_pipeline_runs не удалась: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Терминальный апдейт refill-базы: строки как в обычном пути, но статус 'analyzed' + refill_result. */
async function persistRefillBase(
  ctx: VeStageContext,
  baseId: string,
  args: {
    columns: string[];
    rows: VeUnifiedRow[];
    info: VeCollectInfo;
    stats: VeCollectInfo['stats'];
    refillResult: VeRefillResult;
  },
): Promise<void> {
  const { error } = await ctx.supabase
    .from('ve_bases')
    .update({
      columns: args.columns,
      sample_rows: args.rows.slice(0, SAMPLE_ROWS),
      data: args.rows,
      row_count: args.rows.length,
      status: 'analyzed',
      collect_info: { ...args.info, stats: args.stats, refill_result: args.refillResult },
      updated_at: new Date().toISOString(),
    })
    .eq('id', baseId);
  if (error) throw new Error(`ve_bases refill update: ${error.message}`);
}

interface RefillTemplatePick {
  campaignId: string;
  presetId: string;
  operatorMapping: VeOperatorMapping[] | undefined;
}

/**
 * Шаблон для долива: среди шаблонов вертикали с launch_info — точное
 * совпадение по campaign_id из collect_info (снапшот постановки), иначе
 * последний по дате запуска (force-перезапуск создаёт НОВУЮ кампанию и
 * перезаписывает launch_info — доливать надо в неё).
 */
export function pickRefillTemplate(
  templates: Array<Record<string, unknown>>,
  preferredCampaignId: string | null,
): RefillTemplatePick | null {
  const launched = templates
    .map((t) => {
      const launch = parseLaunchInfo(t.launch_info);
      if (!launch) return null;
      const plan = t.personalization_plan as { operator_mapping?: VeOperatorMapping[] } | null;
      const ts =
        Date.parse(launch.created_at) ||
        Date.parse(typeof t.created_at === 'string' ? t.created_at : '') ||
        0;
      return { launch, operatorMapping: plan?.operator_mapping, ts };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
  if (launched.length === 0) return null;

  const toPick = (t: (typeof launched)[number]): RefillTemplatePick | null => {
    // При сплите запуска по сегментам доливаем ТОЛЬКО в основную кампанию
    // (segment=null): новые лиды refill не классифицированы по сегментам.
    // Сплит без основной кампании (все лиды попали в сегменты) → доливать
    // некуда: null, а не фолбэк на сегментную.
    if (t.launch.campaigns?.length) {
      const main = t.launch.campaigns.find((c) => c.segment === null);
      if (!main) return null;
      return { campaignId: main.campaign_id, presetId: t.launch.preset_id, operatorMapping: t.operatorMapping };
    }
    return {
      campaignId: t.launch.campaign_id,
      presetId: t.launch.preset_id,
      operatorMapping: t.operatorMapping,
    };
  };

  if (preferredCampaignId) {
    const exact = launched.find(
      (t) =>
        t.launch.campaign_id === preferredCampaignId ||
        (t.launch.campaigns ?? []).some((c) => c.campaign_id === preferredCampaignId),
    );
    if (exact) {
      const picked = toPick(exact);
      if (picked) return picked;
    }
  }
  for (const t of launched.slice().sort((a, b) => b.ts - a.ts)) {
    const picked = toPick(t);
    if (picked) return picked;
  }
  return null;
}

/**
 * Строки-кандидаты в лиды: непустой email И (вердикт валидации 'ok' ЛИБО
 * валидации не было — статус null). catch_all/invalid/disposable/unknown
 * отсекаем. Возвращает счётчики воронки для журнала.
 */
export function selectRefillLeadRows(
  rows: VeUnifiedRow[],
  emailStatuses: Array<string | null> | null,
): { leadRows: VeUnifiedRow[]; withEmail: number; valid: number } {
  const leadRows: VeUnifiedRow[] = [];
  let withEmail = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.email.trim() === '') continue;
    // Строки вне вертикали (релевант-гейт base_collect) в долив не идут.
    if ((row as { _low_relevance?: boolean })._low_relevance === true) continue;
    withEmail += 1;
    const status = emailStatuses?.[i] ?? null;
    // TODO(catch_all): catch_all-домены частично рабочие — пока не шлём (риск баунсов).
    if (status !== null && status !== 'ok') continue;
    leadRows.push(row);
  }
  return { leadRows, withEmail, valid: leadRows.length };
}

/**
 * Пустой harvest refill-сборки — штатный «no_new»: база в терминальный
 * 'analyzed' (НЕ failed), прогон 'no_new', джоба завершится успешно.
 */
export async function completeVeRefillNoNew(args: {
  ctx: VeStageContext;
  job: VeJob;
  baseId: string;
  verticalId: string;
  info: VeCollectInfo;
  stats: VeCollectInfo['stats'];
}): Promise<VeRefillResult> {
  const { ctx, job, baseId, verticalId, info, stats } = args;
  const refillResult: VeRefillResult = { status: 'no_new', completed_at: new Date().toISOString() };

  const { error } = await ctx.supabase
    .from('ve_bases')
    .update({
      status: 'analyzed',
      collect_info: { ...info, stats, refill_result: refillResult },
      updated_at: new Date().toISOString(),
    })
    .eq('id', baseId);
  if (error) throw new Error(`ve_bases refill no_new update: ${error.message}`);

  const config = await loadRefillConfig(ctx, job.project_id);
  await writeRefillRun(ctx, {
    configId: config?.id ?? null,
    projectId: job.project_id,
    verticalId,
    baseId,
    result: refillResult,
  });
  stageLog(ctx, '[base_collect] refill: новых компаний нет — прогон no_new, база analyzed');
  return refillResult;
}

/**
 * Долив собранной базы в запущенную кампанию (вызывается вместо финального
 * блока «analyzing + base_analyze»). Никогда не бросает refill-ошибки наружу
 * (см. шапку); бросает только ошибку финального апдейта самой базы — как
 * обычный путь стадии.
 */
export async function runVeRefillAppend(args: {
  ctx: VeStageContext;
  job: VeJob;
  base: { id: string; project_id: string; vertical_id: string };
  info: VeCollectInfo;
  stats: VeCollectInfo['stats'];
  finalRows: VeUnifiedRow[];
  finalColumns: string[];
  /** Вердикты валидации по строкам (null — валидации не было), по индексам finalRows. */
  emailStatuses: Array<string | null> | null;
  usage: VeUsage;
}): Promise<VeStageResult> {
  const { ctx, job, base, info, stats, finalRows, finalColumns, emailStatuses, usage } = args;

  const done = (refill: VeRefillResult): VeStageResult => ({
    result: { base_id: base.id, rows: finalRows.length, refill },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  });

  const config = await loadRefillConfig(ctx, job.project_id);
  const runStats: VeRefillStats = {
    collected: finalRows.length,
    with_email: 0,
    valid: 0,
    appended: 0,
    skipped_blocklist: 0,
    skipped_instantly: 0,
    capped: 0,
  };

  try {
    // 1. Кампания и маппинг — из запущенного шаблона вертикали.
    const { data: templateRows, error: tErr } = await ctx.supabase
      .from('ve_templates')
      .select('id, launch_info, personalization_plan, created_at')
      .eq('vertical_id', base.vertical_id)
      .not('launch_info', 'is', null);
    if (tErr) throw new Error(`ve_templates read: ${tErr.message}`);
    const preferredCampaignId =
      typeof info.campaign_id === 'string' && info.campaign_id ? info.campaign_id : null;
    const pick = pickRefillTemplate((templateRows ?? []) as Array<Record<string, unknown>>, preferredCampaignId);
    if (!pick) {
      throw new Error('у вертикали нет запущенной кампании (ve_templates.launch_info) — доливать некуда');
    }

    // 2. Владелец пресета — чей Instantly-аккаунт, blocklist и тариф (как у
    //    клиентского auto-pipeline: appendLeadsToClientCampaign по userId).
    if (!supabaseInstantly) {
      throw new Error('supabaseInstantly не сконфигурирован (INSTANTLY_SUPABASE_URL)');
    }
    const { data: presetRow, error: pErr } = await supabaseInstantly
      .from('client_campaign_presets')
      .select('client_user_id')
      .eq('id', pick.presetId)
      .maybeSingle();
    if (pErr) throw new Error(`client_campaign_presets read: ${pErr.message}`);
    const ownerUserId = (presetRow as { client_user_id?: unknown } | null)?.client_user_id;
    if (typeof ownerUserId !== 'string' || !ownerUserId) {
      throw new Error(`пресет ${pick.presetId} не найден — владелец кампании неизвестен`);
    }

    // 3. Лиды: email + вердикт 'ok', маппинг колонок → переменные шаблона.
    const { leadRows, withEmail, valid } = selectRefillLeadRows(finalRows, emailStatuses);
    runStats.with_email = withEmail;
    runStats.valid = valid;
    const { leads } = mapBaseRowsToLeads({
      rows: leadRows,
      columns: finalColumns,
      operatorMapping: pick.operatorMapping,
    });

    // 4. Blocklist владельца (сами считаем — число нужно в журнале;
    //    appendLeadsToClientCampaign продублирует фильтр внутри, это дёшево).
    const blockedSet = await getBlockedEmailSet(supabaseInstantly, ownerUserId);
    const { kept, blockedCount } = filterBlockedLeads(leads, blockedSet);
    runStats.skipped_blocklist = blockedCount;

    // 5. Дневной кап проекта: минус уже долитое сегодня (UTC) всеми refill'ами конфига.
    const cap = config?.dailyLeadsCap ?? VE_AUTO_DEFAULT_DAILY_LEADS_CAP;
    let spent = 0;
    if (config) {
      const { data: spentRows, error: spentErr } = await ctx.supabase
        .from('ve_auto_pipeline_runs')
        .select('stats')
        .eq('config_id', config.id)
        .eq('status', 'appended')
        .gte('completed_at', utcDayStart());
      if (spentErr) throw new Error(`ve_auto_pipeline_runs daily spent: ${spentErr.message}`);
      for (const row of spentRows ?? []) {
        const appended = (row as { stats?: { appended?: unknown } }).stats?.appended;
        if (typeof appended === 'number' && Number.isFinite(appended)) spent += appended;
      }
    }
    const remaining = Math.max(0, cap - spent);
    const toSend = kept.slice(0, remaining);
    runStats.capped = kept.length - toSend.length;

    // 6. Долив. valid===0 (нечего слать после фильтров) — 'no_new'; валидные
    //    были, но всё съели blocklist/кап — 'appended' с appended=0 (воронка в stats).
    if (toSend.length > 0) {
      const appended = await appendLeadsToClientCampaign({
        userId: ownerUserId,
        campaignId: pick.campaignId,
        leads: toSend,
        contextLabel: `HE auto-refill · ${base.id}`,
        skipIfInCampaign: true,
      });
      runStats.appended = appended.accepted;
      runStats.skipped_instantly = appended.skipped;
    }
    const outcome: VeRefillResult['status'] = valid === 0 ? 'no_new' : 'appended';

    const refillResult: VeRefillResult = {
      status: outcome,
      campaign_id: pick.campaignId,
      stats: runStats,
      completed_at: new Date().toISOString(),
    };
    await persistRefillBase(ctx, base.id, { columns: finalColumns, rows: finalRows, info, stats, refillResult });
    await writeRefillRun(ctx, {
      configId: config?.id ?? null,
      projectId: job.project_id,
      verticalId: base.vertical_id,
      baseId: base.id,
      result: refillResult,
    });
    stageLog(
      ctx,
      `[base_collect] refill ${outcome}: кампания ${pick.campaignId}, лидов ${runStats.appended} ` +
        `(valid ${runStats.valid}, blocklist ${runStats.skipped_blocklist}, кап-отрез ${runStats.capped})`,
    );
    return done(refillResult);
  } catch (e) {
    // Ошибка долива НЕ валит джобу (см. шапку): база сохраняется в 'analyzed'
    // с refill_result.error, прогон журналируется 'failed'.
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const refillResult: VeRefillResult = {
      status: 'failed',
      stats: runStats,
      error: message,
      completed_at: new Date().toISOString(),
    };
    await persistRefillBase(ctx, base.id, { columns: finalColumns, rows: finalRows, info, stats, refillResult });
    await writeRefillRun(ctx, {
      configId: config?.id ?? null,
      projectId: job.project_id,
      verticalId: base.vertical_id,
      baseId: base.id,
      result: refillResult,
    });
    stageLog(ctx, `[base_collect] refill failed: ${message}`);
    return done(refillResult);
  }
}
