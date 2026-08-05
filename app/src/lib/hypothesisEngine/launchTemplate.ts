/**
 * «Отправить в запуск»: из готового шаблона «Движка вертикалей» создать
 * кампанию в Instantly НА ПАУЗЕ (никогда не активируем — сотрудник проверяет
 * её в Instantly сам) и загрузить лидов базы. Один запуск на шаблон: повтор
 * только с force (создаёт НОВУЮ paused-кампанию и перезаписывает launch_info).
 *
 * Ядро вынесено из POST api/tools/hypothesis-engine/templates/[id]/launch —
 * клиентский ENG-контур (api/client/eng/templates/[id]/launch) делегирует
 * сюда же, отличия только в обвязке роута:
 *   - scopeClientUserId: пресет читается со скоупом владельца (у staff —
 *     service-level read любого пресета по id, см. launchHandoff.ts);
 *   - locale: тексты ошибок RU (staff-UI) / EN (клиентский кабинет);
 *   - eventPrefix: имена событий logAudit/logError своего контура.
 *
 * Тарифных гейтов и журнала client_campaign_launches тут нет осознанно (см.
 * launchHandoff.ts): запуск HE-шаблона billing клиента не меняет.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { hasUsableCampaignSequences } from '@/lib/clientLaunch/campaignSequences';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';
import { createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { logAudit, logError } from '@/lib/loggerServer';
import type { HeBase, HeTemplate } from './types';
import {
  HE_LAUNCH_MAX_LEADS,
  buildLaunchCampaignName,
  buildLaunchSequence,
  instantlyCampaignUrl,
  mapBaseRowsToLeads,
  parseLaunchInfo,
  segmentVariantsWarning,
  type HeTemplateLaunchInfo,
} from './launchHandoff';

export type HeLaunchLocale = 'ru' | 'en';

interface HeLaunchMessages {
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
  instantlyFailedSuffix: (campaignId: string) => string;
  instantlyFailedFallback: string;
  zeroAccepted: string;
  launchInfoSaveWarning: string;
  segmentVariantsWarning: (dropped: number, lettersCount: number) => string;
}

const MESSAGES: Record<HeLaunchLocale, HeLaunchMessages> = {
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
      `Слишком много лидов для запуска из мастера: ${count.toLocaleString('ru-RU')}. Максимум — ${HE_LAUNCH_MAX_LEADS.toLocaleString('ru-RU')}`,
    instantlyFailedSuffix: (campaignId) =>
      ` (кампания ${campaignId} уже создана в Instantly и осталась на паузе)`,
    instantlyFailedFallback: 'Не удалось создать кампанию',
    zeroAccepted: 'Система рассылки не приняла ни одного контакта. Кампания оставлена на паузе.',
    launchInfoSaveWarning:
      'Кампания создана, но запись о запуске не сохранилась в шаблон (вероятно, не применена миграция he_templates.launch_info) — повторный запуск не будет заблокирован.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Сегментные варианты (${dropped} шт. в ${lettersCount} письмах) не попали в кампанию: ` +
      'Instantly не умеет условные блоки — в рассылку ушёл основной текст писем.',
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
      `Too many leads for a wizard launch: ${count.toLocaleString('en-US')}. Maximum is ${HE_LAUNCH_MAX_LEADS.toLocaleString('en-US')}.`,
    instantlyFailedSuffix: (campaignId) =>
      ` (campaign ${campaignId} has already been created in the mailing system and left paused)`,
    instantlyFailedFallback: 'Failed to create the campaign',
    zeroAccepted: 'The mailing system did not accept any contacts. The campaign was left paused.',
    launchInfoSaveWarning:
      'The campaign was created, but the launch record was not saved to the template (the he_templates.launch_info migration is probably not applied) — a re-launch will not be blocked.',
    segmentVariantsWarning: (dropped, lettersCount) =>
      `Segment variants (${dropped} across ${lettersCount} letters) were not included in the campaign: ` +
      'the mailing system cannot run conditional blocks — the main letter text was used instead.',
  },
};

export interface HeTemplateLaunchInput {
  portalDb: SupabaseClient;
  instantlyDb: SupabaseClient;
  templateId: string;
  presetId: string;
  force: boolean;
  /** Для аудита (userId инициатора). */
  userId: string;
  /** Скоуп владельца пресета (клиентский контур); у staff — без скоупа. */
  scopeClientUserId?: string;
  locale: HeLaunchLocale;
  /** Префикс событий логирования/аудита своего контура. */
  eventPrefix: string;
}

export interface HeTemplateLaunchOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function runHeTemplateLaunch(input: HeTemplateLaunchInput): Promise<HeTemplateLaunchOutcome> {
  const { portalDb, instantlyDb, templateId, presetId, force, userId, scopeClientUserId, locale, eventPrefix } = input;
  const t = MESSAGES[locale];

  // 1. Шаблон.
  const { data: templateRow, error: tplErr } = await portalDb
    .from('he_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (tplErr) {
    return {
      status: tplErr.code === 'PGRST116' ? 404 : 500,
      body: { error: tplErr.code === 'PGRST116' ? t.templateNotFound : tplErr.message },
    };
  }
  const template = templateRow as HeTemplate & { launch_info?: unknown };

  if (template.status !== 'ready') {
    return { status: 409, body: { error: t.templateNotReady } };
  }

  const existingLaunch = parseLaunchInfo(template.launch_info);
  if (existingLaunch && !force) {
    return { status: 409, body: { error: t.alreadyLaunched, launch: existingLaunch } };
  }

  // 2. База шаблона.
  const { data: baseRow, error: baseErr } = await portalDb
    .from('he_bases')
    .select('id, filename, columns, data')
    .eq('id', template.base_id)
    .single();
  if (baseErr) {
    return {
      status: baseErr.code === 'PGRST116' ? 404 : 500,
      body: { error: baseErr.code === 'PGRST116' ? t.baseNotFound : baseErr.message },
    };
  }
  const base = baseRow as Pick<HeBase, 'id' | 'filename' | 'columns' | 'data'>;

  // 3. Пресет — service-level read по id (у staff); в клиентском контуре —
  //    со скоупом владельца (чужой пресет = «не найден»).
  let presetQuery = instantlyDb
    .from('client_campaign_presets')
    .select('*')
    .eq('id', presetId);
  if (scopeClientUserId) {
    presetQuery = presetQuery.eq('client_user_id', scopeClientUserId);
  }
  const { data: presetRow, error: presetErr } = await presetQuery.maybeSingle();
  if (presetErr) {
    await logError(`${eventPrefix}.preset_failed`, presetErr, { userId });
    return { status: 500, body: { error: t.presetLoadFailed } };
  }
  if (!presetRow) return { status: 404, body: { error: t.presetNotFound } };
  const preset = presetRow as ClientCampaignPreset;

  // 4. Sequence из писем шаблона (segment_variants выкидываем — см. warning).
  const sequence = buildLaunchSequence(template.letters);
  if (!sequence) return { status: 400, body: { error: t.noLetters } };

  // 5. Лиды из базы. Все проверки — ДО любого вызова Instantly.
  const rows = Array.isArray(base.data) ? (base.data as Array<Record<string, unknown>>) : [];
  const columns = Array.isArray(base.columns)
    ? base.columns.filter((c): c is string => typeof c === 'string')
    : [];
  const { leads, emailColumn } = mapBaseRowsToLeads({
    rows,
    columns,
    operatorMapping: template.personalization_plan?.operator_mapping,
  });
  if (!emailColumn) return { status: 400, body: { error: t.noEmailColumn } };
  if (leads.length === 0) return { status: 400, body: { error: t.noValidEmails } };
  if (leads.length > HE_LAUNCH_MAX_LEADS) {
    return { status: 413, body: { error: t.tooManyLeads(leads.length) } };
  }

  const instantlyRequestOptions = { accountId: resolveInstantlyAccountId(preset.instantly_account_id) };
  const campaignName = buildLaunchCampaignName(base.filename);

  // 6. Instantly: кампания (НЕ активируем!) + лиды. Текст ошибки идёт без
  //    scrubBrand — staff-UI нужна точная формулировка API; клиентский роут
  //    скрабит бренд на своей стороне.
  let instantlyCampaignId: string | null = null;
  let accepted = 0;
  try {
    const payload = buildCampaignPayloadFromPreset({
      preset,
      sequence: { name: campaignName, steps: sequence.steps },
    });
    const created = await createCampaign(payload, instantlyRequestOptions);
    instantlyCampaignId = (created as { id?: string }).id ?? null;
    if (!instantlyCampaignId) {
      throw new Error('Instantly вернул кампанию без идентификатора');
    }

    // Как в клиентском запуске: если Instantly не сохранил sequences при
    // создании — досылаем PATCH'ем.
    if (!hasUsableCampaignSequences(created.sequences)) {
      await updateCampaign(instantlyCampaignId, { sequences: payload.sequences }, instantlyRequestOptions);
    }

    const leadResult = await createLeads(
      leads,
      {
        campaign_id: instantlyCampaignId,
        skip_if_in_workspace: false,
        skip_if_in_campaign: false,
        skip_if_in_list: false,
      },
      instantlyRequestOptions,
    );
    accepted = leadResult.leads_uploaded;
  } catch (err) {
    const message = err instanceof Error ? err.message : t.instantlyFailedFallback;
    await logError(`${eventPrefix}.failed`, err, {
      userId,
      templateId,
      instantlyCampaignId,
    });
    // Если кампания уже создана — говорим об этом явно, чтобы слепой ретрай
    // не плодил дубли (лиды можно долить в Instantly вручную).
    return {
      status: 500,
      body: {
        error: `${message.slice(0, 300)}${instantlyCampaignId ? t.instantlyFailedSuffix(instantlyCampaignId) : ''}`,
      },
    };
  }

  if (accepted === 0) {
    return { status: 500, body: { error: t.zeroAccepted, campaign_id: instantlyCampaignId } };
  }

  // 7. Запись о запуске в шаблон.
  const launchInfo: HeTemplateLaunchInfo = {
    campaign_id: instantlyCampaignId,
    campaign_name: campaignName,
    campaign_url: instantlyCampaignUrl(instantlyCampaignId),
    leads_count: accepted,
    preset_id: presetId,
    created_at: new Date().toISOString(),
  };
  const warnings: string[] = [];
  const segWarning =
    locale === 'en'
      ? (sequence.droppedSegmentVariants > 0
          ? t.segmentVariantsWarning(sequence.droppedSegmentVariants, sequence.lettersWithSegmentVariants)
          : null)
      : segmentVariantsWarning(sequence);
  if (segWarning) warnings.push(segWarning);

  const { error: updErr } = await portalDb
    .from('he_templates')
    .update({ launch_info: launchInfo })
    .eq('id', templateId);
  if (updErr) {
    // Кампания уже создана — не превращаем ответ в ошибку (иначе слепой
    // ретрай плодит дубли), но честно предупреждаем, что дедуп-записи нет.
    await logError(`${eventPrefix}.info_save_failed`, updErr, {
      userId,
      templateId,
      instantlyCampaignId,
    });
    warnings.push(t.launchInfoSaveWarning);
  }

  await logAudit(
    `${eventPrefix}.success`,
    'Hypothesis engine template sent to Instantly (paused)',
    {
      userId,
      templateId,
      baseId: base.id,
      presetId,
      instantlyCampaignId,
      accepted,
      totalLeads: leads.length,
      force,
    },
  );

  return { status: 200, body: { ok: true, launch: launchInfo, warnings } };
}
