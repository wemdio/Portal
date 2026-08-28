/**
 * «Отправить в запуск»: из готового шаблона «Движка вертикалей» создать
 * кампанию в Instantly НА ПАУЗЕ (никогда не активируем — сотрудник проверяет
 * её в Instantly сам) и загрузить лидов базы. Один запуск на шаблон: повтор
 * только с force (создаёт НОВУЮ paused-кампанию и перезаписывает launch_info).
 *
 * Ядро вынесено из POST api/tools/vertical-engine-v2/templates/[id]/launch.
 * Это только внутренний VE v2-контур; production ENG использует отдельный
 * hypothesisEngine backend и сюда не делегирует.
 *
 * Тарифных гейтов и журнала client_campaign_launches тут нет осознанно (см.
 * launchHandoff.ts): запуск HE-шаблона billing клиента не меняет.
 *
 * Материализация 15% (сегментные варианты) работает только по сохранённому
 * предзапускному аудиту. Запуск повторно не вызывает LLM: он валидирует, что
 * аудит относится к текущим шаблону и базе, полностью покрывает точную
 * launch-аудиторию, а затем использует проверенные назначения дословно.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { hasUsableCampaignSequences } from '@/lib/clientLaunch/campaignSequences';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError } from '@/lib/loggerServer';
import type { VeBase, VeSegmentationAudit, VeTemplate } from './types';
import {
  VE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  buildLaunchSequence,
  findEmailColumn,
  instantlyCampaignUrl,
  parseLaunchInfo,
  type VeTemplateLaunchCampaign,
  type VeTemplateLaunchInfo,
} from './launchHandoff';
import {
  buildSegmentationLaunchGroups,
} from './segmentationAudit';
import { reconcileExpiredLaunchReservation } from './launchReservation';
import { validateStoredAuditSnapshot } from './stages/segmentationAudit';

export type VeLaunchLocale = 'ru' | 'en';

interface VeLaunchMessages {
  templateNotFound: string;
  templateNotReady: string;
  alreadyLaunched: string;
  baseNotFound: string;
  presetLoadFailed: string;
  presetNotFound: string;
  noLetters: string;
  noEmailColumn: string;
  noValidEmails: string;
  tooManyLeads: (count: number) => string;
  segmentSplitInfo: (campaignsCount: number) => string;
  rowsSkippedNote: (invalid: number, irrelevant: number) => string;
  instantlyFailedFallback: string;
  zeroAccepted: string;
  launchInfoSaveWarning: string;
  segmentationAuditRequired: string;
  segmentationConfirmationRequired: string;
  segmentationAuditStale: string;
  segmentationAuditIncomplete: string;
  launchInProgress: string;
  launchUncertain: string;
}

const MESSAGES: Record<VeLaunchLocale, VeLaunchMessages> = {
  ru: {
    templateNotFound: 'Шаблон не найден',
    templateNotReady: 'Шаблон ещё не готов — запуск возможен после статуса «Готов»',
    alreadyLaunched: 'Шаблон уже отправлен в запуск. Повторный — только с force: true.',
    baseNotFound: 'База не найдена',
    presetLoadFailed: 'Не удалось загрузить пресет',
    presetNotFound: 'Пресет не найден',
    noLetters: 'У шаблона нет писем для запуска',
    noEmailColumn: 'В базе не найдена колонка с email',
    noValidEmails: 'В базе нет валидных email-адресов',
    tooManyLeads: (count) =>
      `Слишком много лидов для запуска из мастера: ${count.toLocaleString('ru-RU')}. Максимум — ${VE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}`,
    segmentSplitInfo: (campaignsCount) =>
      `Сегментные варианты материализованы: запуск разбит на ${campaignsCount} кампании по сегментам базы (у каждой сегментной — свои тексты писем). Все кампании на паузе.`,
    rowsSkippedNote: (invalid, irrelevant) =>
      `Пропущено строк базы: ${invalid.toLocaleString('ru-RU')} с невалидным email (верификация) и ${irrelevant.toLocaleString('ru-RU')} нерелевантных вертикали.`,
    instantlyFailedFallback: 'Не удалось создать кампанию',
    zeroAccepted: 'Система рассылки не приняла ни одного контакта. Кампания оставлена на паузе.',
    launchInfoSaveWarning:
      'Кампания создана, но запись о запуске не сохранилась в шаблон. Повторный запуск заблокирован до ручной проверки результата.',
    segmentationAuditRequired: 'Перед запуском выполните аудит сегментации.',
    segmentationConfirmationRequired: 'Подтвердите проверенную раскладку сегментов перед запуском.',
    segmentationAuditStale: 'Аудит сегментации устарел. Обновите проверку перед запуском.',
    segmentationAuditIncomplete: 'Аудит сегментации не завершён полностью. Повторите проверку.',
    launchInProgress: 'Для этого шаблона уже выполняется запуск. Дождитесь его завершения.',
    launchUncertain: 'Предыдущий запуск мог создать кампанию. Проверьте результат вручную перед повтором.',
  },
  en: {
    templateNotFound: 'Template not found',
    templateNotReady: 'Template is not ready — launch is possible once it reaches the ready status',
    alreadyLaunched: 'Template has already been sent to launch. Re-launch requires force: true.',
    baseNotFound: 'Base not found',
    presetLoadFailed: 'Failed to load the preset',
    presetNotFound: 'Preset not found',
    noLetters: 'The template has no letters to launch',
    noEmailColumn: 'No email column found in the collected base',
    noValidEmails: 'The base contains no valid email addresses',
    tooManyLeads: (count) =>
      `Too many leads for a wizard launch: ${count.toLocaleString('en-US')}. Maximum is ${VE_LAUNCH_MAX_LEADS.toLocaleString('en-US')}.`,
    segmentSplitInfo: (campaignsCount) =>
      `Segment variants materialized: the launch was split into ${campaignsCount} campaigns by base segment (each segment campaign carries its own letter texts). All campaigns are paused.`,
    rowsSkippedNote: (invalid, irrelevant) =>
      `Base rows skipped: ${invalid.toLocaleString('en-US')} with an invalid email (verification) and ${irrelevant.toLocaleString('en-US')} irrelevant to the vertical.`,
    instantlyFailedFallback: 'Failed to create the campaign',
    zeroAccepted: 'The mailing system did not accept any contacts. The campaign was left paused.',
    launchInfoSaveWarning:
      'The campaign was created, but its launch record was not saved to the template. Re-launch is blocked until the result is reviewed manually.',
    segmentationAuditRequired: 'Run the segmentation audit before launch.',
    segmentationConfirmationRequired: 'Confirm the reviewed segmentation before launch.',
    segmentationAuditStale: 'The segmentation audit is stale. Refresh it before launch.',
    segmentationAuditIncomplete: 'The segmentation audit is incomplete. Run it again before launch.',
    launchInProgress: 'A launch is already running for this template. Wait for it to finish.',
    launchUncertain: 'A previous launch may have created a campaign. Review it manually before retrying.',
  },
};

export interface VeTemplateLaunchInput {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  templateId: string;
  presetId: string;
  force: boolean;
  /** Сохранённый аудит, который специалист просмотрел в UI. */
  segmentationAuditId: string;
  /** Явное подтверждение именно показанной раскладки. */
  confirmSegmentation: boolean;
  /** Для аудита (userId инициатора). */
  userId: string;
  locale: VeLaunchLocale;
  /** Префикс событий логирования/аудита своего контура. */
  eventPrefix: string;
}

export interface VeTemplateLaunchOutcome {
  status: number;
  body: Record<string, unknown>;
}

function conflict(code: string, error: string): VeTemplateLaunchOutcome {
  return { status: 409, body: { error, code } };
}

type LaunchReservationTerminal = 'succeeded' | 'failed' | 'uncertain';

async function reserveTemplateLaunch(input: {
  portalDb: SupabaseClient;
  audit: VeSegmentationAudit;
  templateId: string;
  force: boolean;
  reservationId: string;
  presetId: string;
}): Promise<{ state: 'reserved' } | { state: 'busy' } | { state: 'error'; error: string }> {
  const startedAt = new Date().toISOString();
  const reusableStates = input.force ? ['idle', 'failed', 'succeeded'] : ['idle', 'failed'];
  const { data, error } = await input.portalDb
    .from('ve_segmentation_audits')
    .update({
      launch_status: 'running',
      launch_reservation_id: input.reservationId,
      launch_preset_id: input.presetId,
      launch_started_at: startedAt,
      launch_heartbeat_at: startedAt,
      launch_completed_at: null,
      launch_error: null,
      launch_resolution_id: null,
      launch_resolved_by: null,
      launch_resolved_at: null,
      updated_at: startedAt,
    })
    .eq('id', input.audit.id)
    .eq('template_id', input.templateId)
    .eq('status', 'ready')
    .in('launch_status', reusableStates)
    .select('id')
    .maybeSingle();
  if (error) {
    return error.code === '23505'
      ? { state: 'busy' }
      : { state: 'error', error: error.message };
  }
  return data ? { state: 'reserved' } : { state: 'busy' };
}

async function settleTemplateLaunch(input: {
  portalDb: SupabaseClient;
  auditId: string;
  templateId: string;
  reservationId: string;
  status: LaunchReservationTerminal;
  launchInfo?: VeTemplateLaunchInfo | null;
  error?: string | null;
}): Promise<string | null> {
  const completedAt = new Date().toISOString();
  const { data, error } = await input.portalDb.rpc('ve_finalize_template_launch', {
    p_audit_id: input.auditId,
    p_template_id: input.templateId,
    p_launch_reservation_id: input.reservationId,
    p_launch_status: input.status,
    p_launch_info: input.launchInfo ?? null,
    p_error: input.error?.slice(0, 500) ?? null,
    p_now: completedAt,
  });
  if (error) return error.message;
  const result = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  return result?.finalized === true ? null : 'Резервирование запуска больше не активно';
}

async function heartbeatTemplateLaunch(input: {
  portalDb: SupabaseClient;
  auditId: string;
  reservationId: string;
}): Promise<void> {
  const heartbeatAt = new Date().toISOString();
  const { data, error } = await input.portalDb
    .from('ve_segmentation_audits')
    .update({ launch_heartbeat_at: heartbeatAt, updated_at: heartbeatAt })
    .eq('id', input.auditId)
    .eq('launch_reservation_id', input.reservationId)
    .eq('status', 'ready')
    .eq('launch_status', 'running')
    .select('id')
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message ?? 'Резервирование запуска больше не активно');
  }
}

export async function runVeTemplateLaunch(input: VeTemplateLaunchInput): Promise<VeTemplateLaunchOutcome> {
  const {
    portalDb,
    instantlyDb,
    templateId,
    presetId,
    force,
    segmentationAuditId,
    confirmSegmentation,
    userId,
    locale,
    eventPrefix,
  } = input;
  const t = MESSAGES[locale];

  // Предзапускной gate обязателен даже для force-релонча: новый запуск должен
  // быть привязан к явно просмотренному снимку аудитории.
  if (!segmentationAuditId) {
    return conflict('SEGMENTATION_AUDIT_REQUIRED', t.segmentationAuditRequired);
  }
  if (!confirmSegmentation) {
    return conflict('SEGMENTATION_CONFIRMATION_REQUIRED', t.segmentationConfirmationRequired);
  }

  // 1. Шаблон.
  const { data: templateRow, error: tplErr } = await portalDb
    .from('ve_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (tplErr) {
    return {
      status: tplErr.code === 'PGRST116' ? 404 : 500,
      body: { error: tplErr.code === 'PGRST116' ? t.templateNotFound : tplErr.message },
    };
  }
  const template = templateRow as VeTemplate & { launch_info?: unknown };

  if (template.status !== 'ready') {
    return { status: 409, body: { error: t.templateNotReady } };
  }

  const existingLaunch = parseLaunchInfo(template.launch_info);
  if (existingLaunch && !force) {
    return { status: 409, body: { error: t.alreadyLaunched, launch: existingLaunch } };
  }

  // 2. База шаблона.
  const { data: baseRow, error: baseErr } = await portalDb
    .from('ve_bases')
    .select('id, project_id, filename, columns, data, source')
    .eq('id', template.base_id)
    .single();
  if (baseErr) {
    return {
      status: baseErr.code === 'PGRST116' ? 404 : 500,
      body: { error: baseErr.code === 'PGRST116' ? t.baseNotFound : baseErr.message },
    };
  }
  const base = baseRow as Pick<
    VeBase,
    'id' | 'project_id' | 'filename' | 'columns' | 'data' | 'source'
  >;

  // 3. Письма шаблона + условия сегментных вариантов (when) для сплита запуска.
  const templateLetters = Array.isArray(template.letters) ? template.letters : [];
  if (!buildLaunchSequence(templateLetters)) return { status: 400, body: { error: t.noLetters } };

  // 4. Сохранённый аудит — единственный источник назначений. Не доверяем
  //    одному status='ready': заново проверяем полноту и hash текущего входа.
  const { data: auditRow, error: auditErr } = await portalDb
    .from('ve_segmentation_audits')
    .select('*')
    .eq('id', segmentationAuditId)
    .maybeSingle();
  if (auditErr) {
    await logError(`${eventPrefix}.audit_load_failed`, auditErr, { userId, templateId });
    return { status: 500, body: { error: auditErr.message } };
  }
  if (!auditRow) {
    return conflict('SEGMENTATION_AUDIT_STALE', t.segmentationAuditStale);
  }
  let audit = auditRow as VeSegmentationAudit;
  const validation = validateStoredAuditSnapshot({ audit, template, base });
  if (validation.state === 'incomplete') {
    return conflict('SEGMENTATION_AUDIT_INCOMPLETE', t.segmentationAuditIncomplete);
  }
  if (validation.state === 'stale') {
    return conflict('SEGMENTATION_AUDIT_STALE', t.segmentationAuditStale);
  }
  if (audit.launch_status === 'running') {
    const reconciled = await reconcileExpiredLaunchReservation(portalDb, audit);
    if (reconciled.error) {
      await logError(
        `${eventPrefix}.reservation_reconcile_failed`,
        new Error(reconciled.error),
        { userId, templateId, auditId: audit.id },
      );
      return { status: 500, body: { error: reconciled.error } };
    }
    audit = reconciled.audit;
  }
  if (audit.launch_status === 'uncertain') {
    return conflict('TEMPLATE_LAUNCH_UNCERTAIN', t.launchUncertain);
  }
  if (audit.launch_status === 'running') {
    return conflict('TEMPLATE_LAUNCH_IN_PROGRESS', t.launchInProgress);
  }

  // 5. Точная launch-аудитория и назначения пришли из единого validator-а,
  //    который использует тот же pure-путь, что worker и GET freshness.
  const { audience, segments: segmentWhens } = validation.snapshot;
  const { assignments } = validation;
  const { leads } = audience;
  const columns = Array.isArray(base.columns)
    ? base.columns.filter((column): column is string => typeof column === 'string')
    : [];
  const emailColumn = findEmailColumn(columns, audience.rows);
  if (!emailColumn) return { status: 400, body: { error: t.noEmailColumn } };
  if (leads.length === 0) return { status: 400, body: { error: t.noValidEmails } };
  if (leads.length > VE_LAUNCH_MAX_LEADS) {
    return { status: 413, body: { error: t.tooManyLeads(leads.length) } };
  }
  const currentInputHash = audit.input_hash as string;

  const classification = {
    assignments,
    unclassifiedRows: [] as number[],
    failedBatches: 0,
    totalBatches: 0,
    usage: { tokensUsed: 0, costUsd: 0 },
  };
  interface LeadGroup {
    segment: string | null;
    leadIdx: number[];
  }
  const groups: LeadGroup[] = buildSegmentationLaunchGroups({
    segments: segmentWhens,
    leadCount: leads.length,
    classification,
  }).map((group) => ({ segment: group.segment, leadIdx: group.leadIndices }));
  const segmentsMaterialized = groups.some((group) => group.segment !== null);

  // 6. Пресет — только после fail-closed аудита. До этой точки нет ни одного
  //    внешнего Instantly-вызова и тем более мутаций кампаний.
  const { data: presetRow, error: presetErr } = await instantlyDb
    .from('client_campaign_presets')
    .select('*')
    .eq('id', presetId)
    .maybeSingle();
  if (presetErr) {
    await logError(`${eventPrefix}.preset_failed`, presetErr, { userId });
    return { status: 500, body: { error: t.presetLoadFailed } };
  }
  if (!presetRow) return { status: 404, body: { error: t.presetNotFound } };
  const preset = presetRow as ClientCampaignPreset;

  const instantlyRequestOptions = { accountId: resolveInstantlyAccountId(preset.instantly_account_id) };

  // 7. DB-reservation closes the check-then-launch race across both repeated
  //    requests for one audit and different current audits of one template.
  //    The partial unique index is the cross-row guard; the CAS predicates
  //    below are the same-row guard. Reservation happens before the first
  //    Instantly call and remains `uncertain` after any ambiguous mutation.
  const reservationId = randomUUID();
  const reservation = await reserveTemplateLaunch({
    portalDb,
    audit,
    templateId,
    force,
    reservationId,
    presetId,
  });
  if (reservation.state === 'error') {
    await logError(`${eventPrefix}.reservation_failed`, new Error(reservation.error), {
      userId,
      templateId,
      auditId: audit.id,
    });
    return { status: 500, body: { error: reservation.error } };
  }
  if (reservation.state === 'busy') {
    return conflict('TEMPLATE_LAUNCH_IN_PROGRESS', t.launchInProgress);
  }
  if (!force) {
    // Request B may have read launch_info before request A reserved another
    // ready audit. The template-level reservation index serializes them; this
    // second read happens after B acquires it, so A's successful launch_info
    // is now visible and B fails closed instead of duplicating campaigns.
    const { data: latestTemplate, error: latestTemplateError } = await portalDb
      .from('ve_templates')
      .select('launch_info')
      .eq('id', templateId)
      .single();
    if (latestTemplateError || !latestTemplate) {
      await settleTemplateLaunch({
        portalDb,
        auditId: audit.id,
        templateId,
        reservationId,
        status: 'failed',
        error: latestTemplateError?.message ?? t.templateNotFound,
      });
      return {
        status: latestTemplateError?.code === 'PGRST116' ? 404 : 500,
        body: {
          error:
            latestTemplateError?.code === 'PGRST116'
              ? t.templateNotFound
              : latestTemplateError?.message ?? t.templateNotFound,
        },
      };
    }
    const concurrentLaunch = parseLaunchInfo(
      (latestTemplate as { launch_info?: unknown }).launch_info,
    );
    if (concurrentLaunch) {
      await settleTemplateLaunch({
        portalDb,
        auditId: audit.id,
        templateId,
        reservationId,
        status: 'failed',
        error: t.alreadyLaunched,
      });
      return {
        status: 409,
        body: { error: t.alreadyLaunched, launch: concurrentLaunch },
      };
    }
  }

  // 8. Instantly: по кампании на группу (НЕ активируем!) + лиды группы. Текст
  //    ошибки идёт без scrubBrand — staff-UI нужна точная формулировка API;
  //    клиентский роут скрабит бренд на своей стороне. Основная кампания
  //    (segment=null) создаётся первой — её id уходит в скалярные поля
  //    launch_info (их читает refill-долив и старый UI).
  const campaigns: VeTemplateLaunchCampaign[] = [];
  const groupErrors: string[] = [];
  let accepted = 0;
  let externalMutationAttempted = false;
  let ambiguousGroupFailure = false;
  for (const group of groups) {
    const sequence = buildLaunchSequence(templateLetters, { segmentWhen: group.segment });
    if (!sequence) {
      if (campaigns.length > 0) {
        ambiguousGroupFailure = true;
        groupErrors.push(`${group.segment ?? 'default'}: ${t.noLetters}`);
        continue;
      }
      await settleTemplateLaunch({
        portalDb,
        auditId: audit.id,
        templateId,
        reservationId,
        status: 'failed',
        error: t.noLetters,
      });
      return { status: 400, body: { error: t.noLetters } };
    }
    const campaignName = buildLaunchCampaignName(base.filename, new Date(), group.segment);
    let groupMutationAttempted = false;
    try {
      const payload = buildCampaignPayloadFromPreset({
        preset,
        sequence: { name: campaignName, steps: sequence.steps },
      });
      await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });
      // Even a timed-out request can have committed remotely. From this point
      // onward a blind retry is unsafe until the result is inspected.
      groupMutationAttempted = true;
      externalMutationAttempted = true;
      const created = await createCampaign(payload, instantlyRequestOptions);
      const campaignId = (created as { id?: string }).id ?? null;
      if (!campaignId) {
        throw new Error('Instantly вернул кампанию без идентификатора');
      }
      const campaignRecord: VeTemplateLaunchCampaign = {
        campaign_id: campaignId,
        campaign_name: campaignName,
        campaign_url: instantlyCampaignUrl(campaignId),
        segment: group.segment,
        leads_count: 0,
      };
      campaigns.push(campaignRecord);
      await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });

      // Как в клиентском запуске: если Instantly не сохранил sequences при
      // создании — досылаем PATCH'ем.
      if (!hasUsableCampaignSequences(created.sequences)) {
        await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });
        await updateCampaign(campaignId, { sequences: payload.sequences }, instantlyRequestOptions);
        await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });
      }

      await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });
      const leadResult = await createLeads(
        group.leadIdx.map((i) => leads[i]),
        {
          campaign_id: campaignId,
          skip_if_in_workspace: false,
          skip_if_in_campaign: false,
          skip_if_in_list: false,
        },
        instantlyRequestOptions,
      );
      await heartbeatTemplateLaunch({ portalDb, auditId: audit.id, reservationId });
      accepted += leadResult.leads_uploaded;
      campaignRecord.leads_count = leadResult.leads_uploaded;
    } catch (err) {
      // До первой успешно записанной группы весь запрос завершается ошибкой.
      // Если внешний вызов уже предпринимался, его исход может быть неясен:
      // reservation остаётся `uncertain`, и слепой ретрай блокируется.
      // Поздние группы — частичный успех с warning; созданное не удаляем.
      if (campaigns.length === 0) {
        const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
        await settleTemplateLaunch({
          portalDb,
          auditId: audit.id,
          templateId,
          reservationId,
          status: externalMutationAttempted ? 'uncertain' : 'failed',
          error: message,
        });
        await logError(`${eventPrefix}.failed`, err, { userId, templateId });
        return {
          status: 500,
          body: {
            error: message.slice(0, 300),
            ...(externalMutationAttempted ? { code: 'TEMPLATE_LAUNCH_UNCERTAIN' } : {}),
          },
        };
      }
      const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
      if (groupMutationAttempted) ambiguousGroupFailure = true;
      groupErrors.push(`${group.segment ?? 'default'}: ${message.slice(0, 200)}`);
      await logError(`${eventPrefix}.group_failed`, err, {
        userId,
        templateId,
        segment: group.segment,
      });
    }
  }

  const zeroAccepted = accepted === 0;
  if (zeroAccepted && campaigns.length === 0) {
    await settleTemplateLaunch({
      portalDb,
      auditId: audit.id,
      templateId,
      reservationId,
      status: externalMutationAttempted ? 'uncertain' : 'failed',
      error: t.zeroAccepted,
    });
    return {
      status: 500,
      body: {
        error: t.zeroAccepted,
        campaign_id: campaigns[0]?.campaign_id ?? null,
        ...(externalMutationAttempted ? { code: 'TEMPLATE_LAUNCH_UNCERTAIN' } : {}),
      },
    };
  }
  if (zeroAccepted) {
    ambiguousGroupFailure = true;
    groupErrors.push(t.zeroAccepted);
  }

  // 9. Запись о запуске в шаблон. Скалярные поля — первая кампания;
  //    полный список — campaigns[].
  const primary = campaigns[0];
  const launchInfo: VeTemplateLaunchInfo = {
    campaign_id: primary.campaign_id,
    campaign_name: primary.campaign_name,
    campaign_url: primary.campaign_url,
    leads_count: accepted,
    preset_id: presetId,
    created_at: new Date().toISOString(),
    segmentation_audit_id: audit.id,
    segmentation_audit_input_hash: currentInputHash,
    ...(ambiguousGroupFailure ? { reconciliation_required: true } : {}),
    campaigns,
  };
  const warnings: string[] = [];
  if (audience.excluded.invalidEmailStatus > 0 || audience.excluded.lowRelevance > 0) {
    warnings.push(
      t.rowsSkippedNote(
        audience.excluded.invalidEmailStatus,
        audience.excluded.lowRelevance,
      ),
    );
  }
  if (segmentsMaterialized && campaigns.length > 1) {
    warnings.push(t.segmentSplitInfo(campaigns.length));
  }
  for (const ge of groupErrors) {
    warnings.push(
      locale === 'en' ? `Segment campaign failed: ${ge}` : `Кампания сегмента не создана: ${ge}`,
    );
  }

  // launch_info and the terminal reservation state commit together under a
  // template advisory lock. An old process cannot overwrite a reconciliation.
  const settleError = await settleTemplateLaunch({
    portalDb,
    auditId: audit.id,
    templateId,
    reservationId,
    status: ambiguousGroupFailure ? 'uncertain' : 'succeeded',
    launchInfo,
    error: ambiguousGroupFailure ? groupErrors.join('; ') : null,
  });
  if (settleError) {
    await logError(`${eventPrefix}.reservation_settle_failed`, new Error(settleError), {
      userId,
      templateId,
      auditId: audit.id,
      instantlyCampaignId: primary.campaign_id,
    });
    // If the RPC itself failed before it could acquire the lock, keep the
    // exact reservation blocked. If a resolver already won, this CAS is a no-op.
    const failedAt = new Date().toISOString();
    await portalDb
      .from('ve_segmentation_audits')
      .update({
        launch_status: 'uncertain',
        launch_error: settleError.slice(0, 500),
        launch_completed_at: failedAt,
        updated_at: failedAt,
      })
      .eq('id', audit.id)
      .eq('launch_reservation_id', reservationId)
      .eq('launch_status', 'running');
    return {
      status: 500,
      body: {
        error: t.launchInfoSaveWarning,
        code: 'TEMPLATE_LAUNCH_UNCERTAIN',
      },
    };
  }

  await logAudit(
    `${eventPrefix}.success`,
    'Vertical Engine v2 template sent to Instantly (paused)',
    {
      userId,
      templateId,
      baseId: base.id,
      presetId,
      instantlyCampaignId: primary.campaign_id,
      campaigns: campaigns.length,
      segmentsMaterialized,
      segmentationAuditId: audit.id,
      segmentationAuditInputHash: currentInputHash,
      launchReservationId: reservationId,
      accepted,
      totalLeads: leads.length,
      force,
    },
  );

  return {
    status: zeroAccepted ? 500 : 200,
    body: {
      ok: !zeroAccepted,
      launch: launchInfo,
      warnings,
      ...(zeroAccepted ? { error: t.zeroAccepted } : {}),
      ...(ambiguousGroupFailure ? { code: 'TEMPLATE_LAUNCH_UNCERTAIN' } : {}),
    },
  };
}
