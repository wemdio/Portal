/**
 * ENG auto-pipeline Движка вертикалей: ежедневный тик добора лидов в уже
 * запущенные кампании us-проектов (аналог RU autoPipelineRunner поверх
 * HE-машинерии).
 *
 * Вызывается one-shot кроном app/worker/heAutoPipelineCron.ts. Один тик:
 *   1. enabled-конфиги he_auto_pipeline_configs, проект market='us';
 *   2. вертикали проекта по created_at (стабильный порядок добора);
 *   3. вертикаль eligible, когда у неё есть шаблон с launch_info.campaign_id
 *      (последний по дате запуска) — есть куда доливать;
 *   4. постановка refill-сборки через общий enqueueHeBaseCollect (его же
 *      дедуп: уже собирающаяся auto-база / активная base_collect-джоба →
 *      'existing' и слот verticals_per_run НЕ расходуется): he_bases
 *      source='auto'/status='collecting' с filename «auto-refill: <вертикаль>
 *      · <дата>» и collect_info {limit, refill, campaign_id} + he_jobs
 *      base_collect с payload.refill;
 *   5. запись he_auto_pipeline_runs 'collecting' (финал запишет refill-ветка
 *      стадии по base_id); ошибка постановки — run 'failed' с base_id NULL;
 *   6. configs.last_run_at — по завершении обхода конфига (даже пустого).
 *
 * Дальше сборку и долив делает стадия base_collect (refill-ветка —
 * stages/baseCollectRefill.ts). Дедуп компаний при повторных сборах —
 * встроенный в HARVEST (исключение компаний других баз проекта), поэтому
 * refill поднимает только новые.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';
import { parseLaunchInfo } from './launchHandoff';

/** Лимит строк одной refill-сборки (на вертикаль за тик). */
export const HE_AUTO_REFILL_ROWS_LIMIT = 200;
/** Дефолт verticals_per_run — зеркало DEFAULT миграции 20260804_0005. */
export const HE_AUTO_DEFAULT_VERTICALS_PER_RUN = 3;

export type HeAutoPipelineDetailStatus = 'enqueued' | 'existing' | 'no_campaign' | 'failed';

export interface HeAutoPipelineTickDetail {
  configId: string;
  projectId: string;
  verticalId?: string;
  baseId?: string | null;
  status: HeAutoPipelineDetailStatus;
  message?: string;
}

export interface HeAutoPipelineTickSummary {
  /** Enabled-конфиги us-проектов, обработанные за тик. */
  configs: number;
  enqueued: number;
  /** Вертикаль уже собирается (дедуп enqueueHeBaseCollect) — слот не расходуется. */
  existing: number;
  /** У вертикали нет запущенной кампании — слот не расходуется. */
  noCampaign: number;
  failed: number;
  details: HeAutoPipelineTickDetail[];
}

interface ConfigRow {
  id: string;
  project_id: string;
  verticals_per_run: number | null;
}

interface VerticalRow {
  id: string;
  name: string;
  created_at: string | null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Карта «вертикаль → campaign_id» по шаблонам с launch_info: на вертикаль —
 * ПОСЛЕДНЯЯ по дате запуска кампания (force-перезапуск перезаписывает
 * launch_info; доливать надо в актуальную).
 */
function latestCampaignByVertical(templateRows: Array<Record<string, unknown>>): Map<string, string> {
  const best = new Map<string, { campaignId: string; ts: number }>();
  for (const row of templateRows) {
    const launch = parseLaunchInfo(row.launch_info);
    if (!launch) continue;
    const verticalId = asString(row.vertical_id);
    if (!verticalId) continue;
    const ts =
      Date.parse(launch.created_at) ||
      Date.parse(asString(row.created_at)) ||
      0;
    // При сплите запуска по сегментам долив идёт ТОЛЬКО в основную кампанию
    // (segment=null) — новые лиды refill по сегментам не классифицированы;
    // сплит без основной кампании вертикаль пропускает (доливать некуда).
    const campaignId = launch.campaigns?.length
      ? launch.campaigns.find((c) => c.segment === null)?.campaign_id
      : launch.campaign_id;
    if (!campaignId) continue;
    const current = best.get(verticalId);
    if (!current || ts >= current.ts) best.set(verticalId, { campaignId, ts });
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.campaignId]));
}

/** Запись журнала прогонов; ошибка вставки — фейл обхода конфига. */
async function insertRun(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('he_auto_pipeline_runs').insert(row);
  if (error) throw new Error(`he_auto_pipeline_runs insert: ${error.message}`);
}

async function runForConfig(
  supabase: SupabaseClient,
  config: ConfigRow,
  now: Date,
  summary: HeAutoPipelineTickSummary,
): Promise<void> {
  const detail = (d: Omit<HeAutoPipelineTickDetail, 'configId' | 'projectId'>) => {
    summary.details.push({ configId: config.id, projectId: config.project_id, ...d });
  };

  const { data: verticalRows, error: vErr } = await supabase
    .from('he_verticals')
    .select('id, name, created_at')
    .eq('project_id', config.project_id);
  if (vErr) throw new Error(`he_verticals read: ${vErr.message}`);
  // Сортировка в JS (created_at asc): стабильный порядок добора вертикалей.
  const verticals = ((verticalRows ?? []) as VerticalRow[])
    .slice()
    .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''));

  let campaignByVertical = new Map<string, string>();
  if (verticals.length > 0) {
    const { data: templateRows, error: tErr } = await supabase
      .from('he_templates')
      .select('vertical_id, launch_info, created_at')
      .in('vertical_id', verticals.map((v) => v.id))
      .not('launch_info', 'is', null);
    if (tErr) throw new Error(`he_templates read: ${tErr.message}`);
    campaignByVertical = latestCampaignByVertical((templateRows ?? []) as Array<Record<string, unknown>>);
  }

  const perRun = Math.max(1, config.verticals_per_run ?? HE_AUTO_DEFAULT_VERTICALS_PER_RUN);
  const dateTag = now.toISOString().slice(0, 10);
  let enqueued = 0;

  for (const vertical of verticals) {
    if (enqueued >= perRun) break;
    const campaignId = campaignByVertical.get(vertical.id);
    if (!campaignId) {
      summary.noCampaign += 1;
      detail({ verticalId: vertical.id, status: 'no_campaign' });
      continue;
    }

    const result = await enqueueHeBaseCollect(supabase, {
      verticalId: vertical.id,
      projectId: config.project_id,
      verticalName: vertical.name,
      limit: HE_AUTO_REFILL_ROWS_LIMIT,
      hypothesisIds: null,
      filename: `auto-refill: ${vertical.name} · ${dateTag}`,
      refill: { campaignId },
    });
    if (!result.ok) {
      summary.failed += 1;
      detail({ verticalId: vertical.id, status: 'failed', message: result.message });
      await insertRun(supabase, {
        config_id: config.id,
        project_id: config.project_id,
        vertical_id: vertical.id,
        base_id: null,
        status: 'failed',
        error: result.message.slice(0, 500),
        completed_at: now.toISOString(),
      });
      continue;
    }
    if (!result.created) {
      // Уже собирается (ручной запуск или вчерашний refill) — слот не ест.
      summary.existing += 1;
      detail({ verticalId: vertical.id, baseId: asString(result.base.id) || null, status: 'existing' });
      continue;
    }

    enqueued += 1;
    summary.enqueued += 1;
    const baseId = asString(result.base.id);
    await insertRun(supabase, {
      config_id: config.id,
      project_id: config.project_id,
      vertical_id: vertical.id,
      base_id: baseId,
      status: 'collecting',
    });
    detail({ verticalId: vertical.id, baseId, status: 'enqueued' });
  }

  // Тик по конфигу отработал (даже без новых постановок) — фиксируем.
  const { error: updErr } = await supabase
    .from('he_auto_pipeline_configs')
    .update({ last_run_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', config.id);
  if (updErr) throw new Error(`he_auto_pipeline_configs last_run_at: ${updErr.message}`);
}

/**
 * Один тик ENG auto-pipeline. Ошибки чтения конфигов/проектов — фатальны
 * (бросок, крон выйдет с кодом 1); ошибки обхода отдельного конфига изолированы
 * (summary.failed + detail), остальные конфиги продолжаются.
 */
export async function runHeAutoPipelineTick(
  supabase: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<HeAutoPipelineTickSummary> {
  const now = opts.now ?? new Date();
  const summary: HeAutoPipelineTickSummary = {
    configs: 0,
    enqueued: 0,
    existing: 0,
    noCampaign: 0,
    failed: 0,
    details: [],
  };

  const { data: configRows, error: configsErr } = await supabase
    .from('he_auto_pipeline_configs')
    .select('id, project_id, verticals_per_run')
    .eq('enabled', true);
  if (configsErr) throw new Error(`he_auto_pipeline_configs read: ${configsErr.message}`);
  const configs = ((configRows ?? []) as ConfigRow[])
    .map((c) => ({
      id: asString(c.id),
      project_id: asString(c.project_id),
      verticals_per_run:
        typeof c.verticals_per_run === 'number' && Number.isFinite(c.verticals_per_run)
          ? c.verticals_per_run
          : null,
    }))
    .filter((c) => c.id && c.project_id);
  if (configs.length === 0) return summary;

  // Только us-проекты: добор идёт в ENG-кампании (RU-поток покрывает
  // client_auto_pipeline_*).
  const { data: projectRows, error: projectsErr } = await supabase
    .from('he_projects')
    .select('id, market')
    .in('id', configs.map((c) => c.project_id));
  if (projectsErr) throw new Error(`he_projects read: ${projectsErr.message}`);
  const usProjectIds = new Set(
    ((projectRows ?? []) as Array<{ id?: unknown; market?: unknown }>)
      .filter((p) => p.market === 'us')
      .map((p) => asString(p.id)),
  );
  const eligible = configs.filter((c) => usProjectIds.has(c.project_id));
  summary.configs = eligible.length;

  for (const config of eligible) {
    try {
      await runForConfig(supabase, config, now, summary);
    } catch (e) {
      summary.failed += 1;
      summary.details.push({
        configId: config.id,
        projectId: config.project_id,
        status: 'failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}
