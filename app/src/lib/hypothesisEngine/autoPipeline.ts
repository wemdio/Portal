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
 *   3a. ПРЕДПОЛЁТ ЁМКОСТИ: сколько контактов ещё принимает воркспейс
 *      рассыльщика. Ноль — сборка НЕ ставится (и остальные вертикали проекта
 *      тоже: воркспейс у них общий), потому что платит сборка, а не долив:
 *      краул сайтов и SMTP-пробы каждого адреса уходят ДО того, как долив
 *      упрётся в «нет места», и оплаченные компании при этом выжигаются из
 *      будущих сборок проекта. Ёмкость не определилась — работаем как раньше
 *      (обязательный fail-open: слепой предполёт, угадавший ноль, остановил бы
 *      продукт на ровном месте);
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
 *
 * Тарифная асимметрия ЗАКРЫТА на стороне вызывающего: `stages/baseCollectRefill.ts`
 * зовёт `appendLeadsToClientCampaign` с `entitlementMode: 'managed_contract'`
 * (доверенный серверный оркестратор), поэтому self-serve гейт к ночному доливу
 * не применяется — у ENG-клиента строка тарифа либо неактивна
 * (`api/signup/route.ts` ставит `is_active=false`), либо отсутствует, и раньше
 * это давало 403 «Подписка не активна» уже ПОСЛЕ оплаченного сбора, тогда как
 * ручной запуск ENG-кампании гейта не имеет вовсе (`TODO(tariffs)` в
 * `api/client/eng/templates/[id]/launch/route.ts`). Объём долива режет не тариф,
 * а дневной кап проекта `he_auto_pipeline_configs.daily_leads_cap`. Ветка по
 * рынку внутри общего биллинг-кода при этом НЕ появилась — решение принимает
 * вызывающий. Альтернатива на будущее (если ENG-пресеты станут провижиниться
 * централизованно): `agency_managed=true` у ENG-пресета вместо флага в вызове.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getWorkspaceContactCapacity } from '@/lib/instantly/client';
import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';
import type { InstantlyRequestOptions } from '@/lib/instantly/accounts';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { enqueueHeBaseCollect } from './baseCollectEnqueue';
import { parseLaunchInfo } from './launchHandoff';

/** Лимит строк одной refill-сборки (на вертикаль за тик). */
export const HE_AUTO_REFILL_ROWS_LIMIT = 200;
/** Дефолт verticals_per_run — зеркало DEFAULT миграции 20260804_0005. */
export const HE_AUTO_DEFAULT_VERTICALS_PER_RUN = 3;

export type HeAutoPipelineDetailStatus =
  | 'enqueued'
  | 'existing'
  | 'no_campaign'
  | 'capacity_blocked'
  | 'failed';

/**
 * Текст отказа предполёта — БЛИЗНЕЦ REFILL_CAPACITY_NOTE в
 * stages/baseCollectRefill.ts (там тот же отказ, но на этапе долива). Общая
 * подстрока «лимит контактов воркспейса» — единственный якорь, по которому
 * причину узнаёт клиентский классификатор (clientErrors.classifyHeClientError);
 * менять формулировку — сразу в обоих местах и вместе с его правилом.
 * Импортом константу не тянем осознанно: stages/baseCollectRefill.ts тащит за
 * собой всю стадию сборки (коллекторы, конструктор) в бандл крона.
 */
const CAPACITY_REFUSAL_ERROR =
  'Instantly: лимит контактов воркспейса исчерпан — сборка не ставилась, деньги не потрачены';

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
  /**
   * Вертикалей, которым отказал предполёт ёмкости: у рассыльщика нет места под
   * новые контакты, сборка не поставлена и ничего не оплачено. НЕ считается
   * failed: это штатный отказ, а не сбой тика, и ронять exit code крона каждую
   * ночь переполненного воркспейса нечем полезным (причина видна в логе,
   * в he_auto_pipeline_runs и в счётчике ниже).
   */
  capacityBlocked: number;
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

/** Куда доливать вертикаль: кампания и пресет её последнего запуска. */
interface VerticalLaunchTarget {
  campaignId: string;
  /**
   * Пресет запуска: через него (client_user_id → instantly_account_id) ведёт
   * единственный путь к воркспейсу, в который долив реально пишет, — тот же,
   * что резолвит appendLeadsToClientCampaign. Предполёт ёмкости обязан спросить
   * ИМЕННО его, иначе он мерил бы чужой (дефолтный) воркспейс.
   */
  presetId: string;
}

/**
 * Карта «вертикаль → кампания и пресет» по шаблонам с launch_info: на вертикаль —
 * ПОСЛЕДНИЙ по дате запуска (force-перезапуск перезаписывает launch_info;
 * доливать надо в актуальную кампанию).
 */
function latestCampaignByVertical(
  templateRows: Array<Record<string, unknown>>,
): Map<string, VerticalLaunchTarget> {
  const best = new Map<string, VerticalLaunchTarget & { ts: number }>();
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
    if (!current || ts >= current.ts) {
      best.set(verticalId, { campaignId, presetId: launch.preset_id, ts });
    }
  }
  return new Map(
    [...best.entries()].map(([k, v]) => [k, { campaignId: v.campaignId, presetId: v.presetId }]),
  );
}

/**
 * Сколько контактов ещё принимает воркспейс рассыльщика: число — точный
 * остаток, null — «не знаем».
 */
type HeWorkspaceCapacityProbe = (presetId: string) => Promise<number | null>;

/**
 * Предполёт ёмкости на один тик.
 *
 * Запрос к рассыльщику — ОДИН на воркспейс за тик (мемоизация по аккаунту), а
 * не один на вертикаль: все вертикали одного проекта живут в воркспейсе своего
 * клиента (пресет — один на client_user_id), и переспрашивать то же самое
 * значило бы тратить общий rate-limit ради одинакового ответа.
 *
 * null — «не знаем», и это ОБЯЗАТЕЛЬНО не «ноль»: ключ без права читать биллинг
 * воркспейса, таймаут, 429/5xx у провайдера, нечитаемый ответ, ненайденный
 * пресет и отсутствующая instantly-БД дают именно null, после чего тик работает
 * как до этой правки. Предполёт, который угадывает ноль, останавливает продукт;
 * предполёт, который угадывает «место есть», в худшем случае возвращает нас к
 * прежнему поведению (отказ на доливе, где его уже умеют ставить на паузу).
 */
function createHeWorkspaceCapacityProbe(): HeWorkspaceCapacityProbe {
  const optionsByPreset = new Map<string, Promise<InstantlyRequestOptions | null>>();
  const remainingByAccount = new Map<string, Promise<number | null>>();

  const optionsFor = (presetId: string): Promise<InstantlyRequestOptions | null> => {
    const cached = optionsByPreset.get(presetId);
    if (cached) return cached;
    const pending = (async () => {
      if (!supabaseInstantly) return null;
      const { data, error } = await supabaseInstantly
        .from('client_campaign_presets')
        .select('client_user_id')
        .eq('id', presetId)
        .maybeSingle();
      if (error) throw new Error(`client_campaign_presets read: ${error.message}`);
      const userId = (data as { client_user_id?: unknown } | null)?.client_user_id;
      if (typeof userId !== 'string' || !userId) return null;
      // Тот же резолв, которым долив выбирает аккаунт (DRY, по client_user_id).
      return resolveClientInstantlyRequestOptions(userId);
    })();
    optionsByPreset.set(presetId, pending);
    return pending;
  };

  return async (presetId) => {
    if (!presetId) return null;
    try {
      const options = await optionsFor(presetId);
      if (!options) return null;
      const accountKey = options.accountId ?? '';
      const cached = remainingByAccount.get(accountKey);
      if (cached) return await cached;
      const pending = getWorkspaceContactCapacity(options).then((c) => c?.remaining ?? null);
      remainingByAccount.set(accountKey, pending);
      return await pending;
    } catch {
      // Любая неопределённость — «не знаем». Текст ошибки не логируем здесь:
      // вызывающий и без него работает как раньше, а шумная строка каждую ночь
      // у клиентов без права на биллинг-чтение прятала бы настоящие отказы.
      return null;
    }
  };
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
  capacityProbe: HeWorkspaceCapacityProbe,
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

  let campaignByVertical = new Map<string, VerticalLaunchTarget>();
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
    const target = campaignByVertical.get(vertical.id);
    if (!target) {
      summary.noCampaign += 1;
      detail({ verticalId: vertical.id, status: 'no_campaign' });
      continue;
    }
    const { campaignId } = target;

    // ─── ПРЕДПОЛЁТ ЁМКОСТИ ВОРКСПЕЙСА (до постановки, до денег) ───
    // Платит СБОРКА: краул сайтов и SMTP-проба каждого адреса уходят задолго до
    // долива, и раньше «нет места у рассыльщика» обнаруживалось только на
    // append'е — после оплаты и с выжженными компаниями. Ноль остатка — не
    // ставим и не тратим; null («не знаем») — работаем как раньше, отказ поймает
    // пауза долива (stages/baseCollectRefill.ts).
    const remainingCapacity = await capacityProbe(target.presetId);
    if (remainingCapacity === 0) {
      summary.capacityBlocked += 1;
      detail({ verticalId: vertical.id, status: 'capacity_blocked' });
      await insertRun(supabase, {
        config_id: config.id,
        project_id: config.project_id,
        vertical_id: vertical.id,
        // base_id NULL — сбора не было. Это же отличает отказ ПОСТАНОВКИ от
        // отказа среза: серию отказов вертикали (refillFailStreak, решает,
        // возвращать ли компании в пул) считают только строки с base_id.
        base_id: null,
        status: 'failed',
        stats: { error_kind: 'instantly_capacity' },
        error: CAPACITY_REFUSAL_ERROR,
        completed_at: now.toISOString(),
      });
      // Остальные вертикали проекта — в том же воркспейсе: пресет один на
      // client_user_id, а все запуски проекта идут от одного клиента. Спрашивать
      // по каждой одно и то же и писать ей такую же строку журнала незачем.
      break;
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
    detail({
      verticalId: vertical.id,
      baseId,
      status: 'enqueued',
      // Остаток ёмкости в строке журнала крона — доказательство, что предполёт
      // действительно отработал (а не молча деградировал в «не знаем»): для
      // первой ночи под присмотром это единственный способ отличить одно от
      // другого, не заходя в рассыльщик.
      ...(remainingCapacity === null ? {} : { message: `workspace capacity ${remainingCapacity}` }),
    });
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
    capacityBlocked: 0,
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

  // Предполёт ёмкости — один на тик: мемоизация внутри держит один запрос к
  // рассыльщику на воркспейс, сколько бы конфигов и вертикалей тик ни обошёл.
  const capacityProbe = createHeWorkspaceCapacityProbe();

  for (const config of eligible) {
    try {
      await runForConfig(supabase, config, now, summary, capacityProbe);
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
