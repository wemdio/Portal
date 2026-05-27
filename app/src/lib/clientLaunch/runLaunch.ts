/**
 * Core client-launch service.
 *
 * Extracted from app/src/app/api/client/launches/route.ts so the same flow
 * (создать кампанию в Instantly + загрузить лидов + активировать + записать
 * в журнал + обновить каталог + дать клиенту доступ) можно вызвать из:
 *
 *   1. HTTP-роута `/api/client/launches` (когда клиент загружает CSV вручную).
 *   2. Bootstrap-эндпоинта в админке (когда мы один раз создаём кампании
 *      под score buckets для авто-пайплайна).
 *
 * Для ежедневного append'а лидов в уже живущую кампанию (auto-pipeline daily
 * delta) используется отдельная функция `appendLeadsToClientCampaign` —
 * она НЕ создаёт новую кампанию, а только подкладывает лидов в существующую.
 *
 * Контракты входа/выхода:
 *   - leads — это уже готовые LeadCreatePayload (валидация email сделана
 *     выше по стеку, нашему сервису не нужно знать о CSV/HH/чём-либо ещё).
 *   - sequence — уже собранная ClientLaunchSequence с шагами и вариантами.
 *   - возвращаем id записи в client_campaign_launches + instantly_campaign_id
 *     + статистику принятых/отклонённых лидов.
 */

import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { buildCampaignPayloadFromPreset } from './buildCampaignPayload';
import { validateClientLaunchInput } from './validateLaunchInput';
import type {
  ClientCampaignPreset,
  ClientLaunchBehaviorOverride,
  ClientLaunchColumnMapping,
  ClientLaunchScheduleOverride,
  ClientLaunchSequence,
} from './types';
import { activateCampaign, createCampaign, createLeads, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { upsertInstantlyCatalogFromCampaign } from '@/lib/tools/instantlyCampaignCatalog';
import { hasUsableCampaignSequences } from './campaignSequences';
import {
  countClientContacts,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  resolveEffectiveLimits,
} from '@/lib/tariffs';
import type { LeadCreatePayload } from '@/lib/instantly/types';

export interface RunClientLaunchInput {
  /** Supabase auth user id of the client whose campaign is being launched. */
  userId: string;
  /** Pre-built sequence (subject/body/wait_days/variants). */
  sequence: ClientLaunchSequence;
  /** Pre-built leads (email is the only required field; rest is optional). */
  leads: LeadCreatePayload[];
  /** Optional schedule override; falls back to preset values. */
  scheduleOverride?: ClientLaunchScheduleOverride;
  /** Optional behavior override (open_tracking, stop_on_reply). */
  behaviorOverride?: ClientLaunchBehaviorOverride;
  /**
   * Optional per-launch subset of mailboxes. When present, validated as
   * a strict subset of `preset.email_account_ids` and used as Instantly's
   * `email_list` for this campaign. Used to run two parallel campaigns
   * on the same base with different mailbox pools. Undefined → full
   * preset pool (legacy behavior, default).
   */
  emailAccountIdsOverride?: string[];
  /**
   * Optional CSV stats for journaling. Pass only when source is CSV upload —
   * for auto-pipeline bootstrap we leave undefined and the journal records
   * uploaded_rows = leads.length.
   */
  uploadedRows?: number;
  /**
   * Optional column mapping for journaling. Only used by CSV-upload caller;
   * auto-pipeline passes undefined (we store {}).
   */
  columnMapping?: ClientLaunchColumnMapping;
}

export interface RunClientLaunchResult {
  launch_id: string;
  instantly_campaign_id: string;
  campaign_name: string;
  status: 'active';
  uploaded_rows: number;
  accepted_rows: number;
  skipped_rows: number;
}

export class ClientLaunchError extends Error {
  /** HTTP-style status code so the calling route can return it directly. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ClientLaunchError';
  }
}

/**
 * The full create-campaign + upload-leads + activate + journal flow.
 *
 * Throws ClientLaunchError on expected failures (missing preset, tariff
 * exhausted, validation error). Throws Error on unexpected failures
 * (Instantly API down, supabase down). Both cases also update the launch
 * row to status='failed' if it had been inserted.
 */
export async function runClientLaunch(input: RunClientLaunchInput): Promise<RunClientLaunchResult> {
  if (!supabaseInstantly) {
    throw new ClientLaunchError('Server misconfigured: supabaseInstantly is not available', 500);
  }

  const { userId, sequence, leads, scheduleOverride, behaviorOverride, emailAccountIdsOverride } = input;
  const logMeta = { userId };

  // 1. Загружаем пресет клиента — без него нельзя запустить ни одну кампанию.
  const { data: presetRow, error: presetErr } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('*')
    .eq('client_user_id', userId)
    .maybeSingle();

  if (presetErr) {
    await logError('client.launches.run.preset_load_failed', presetErr, {}, logMeta);
    throw new ClientLaunchError('Не удалось загрузить пресет', 500);
  }

  const preset = presetRow as ClientCampaignPreset | null;

  // 2. Валидация sequence + mapping (через существующую функцию). Для
  //    auto-pipeline mapping не нужен — передаём фиктивный с email-ключом,
  //    т.к. leads уже валидные. Валидация смотрит на mapping.email только
  //    как на признак «маппинг задан», содержание ей не критично.
  const validationMapping: ClientLaunchColumnMapping =
    input.columnMapping ?? { email: 'email' };

  const validation = validateClientLaunchInput({
    preset,
    sequence,
    mapping: validationMapping,
    rowCount: leads.length,
    scheduleOverride,
  });

  if (!validation.ok) {
    throw new ClientLaunchError(validation.error, 400);
  }

  if (leads.length === 0) {
    throw new ClientLaunchError('Нет валидных лидов для отправки', 400);
  }

  // 2b. Если клиент явно выбрал подмножество ящиков из пула пресета,
  // валидируем: каждый ID должен быть в presetEmailAccountIds, дублей
  // быть не должно (для журнала и для email_list в Instantly), и набор
  // не должен быть пустым (иначе Instantly создаст кампанию без ящиков
  // отправки — тихая поломка, лучше явно ругнуться 400). Если override
  // не задан — берём весь пул пресета (legacy default).
  const presetEmailAccountIds = new Set(preset!.email_account_ids);
  let validatedEmailAccountIdsOverride: string[] | null = null;
  if (emailAccountIdsOverride !== undefined) {
    const unique = Array.from(new Set(emailAccountIdsOverride));
    if (unique.length === 0) {
      throw new ClientLaunchError(
        'Выберите хотя бы один ящик отправки из пула в пресете.',
        400,
      );
    }
    const notInPool = unique.filter((id) => !presetEmailAccountIds.has(id));
    if (notInPool.length > 0) {
      throw new ClientLaunchError(
        `Ящики не из вашего пресета: ${notInPool.join(', ')}. ` +
          'Обновите страницу — возможно, пресет изменился.',
        400,
      );
    }
    validatedEmailAccountIdsOverride = unique;
  }

  // 3. Проверяем статус и тарифные лимиты клиента.
  const tariffRow = await getClientTariffRow(userId);
  const clientStatus = getClientStatus(tariffRow);
  if (clientStatus === 'setup') {
    throw new ClientLaunchError(
      'Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.',
      403,
    );
  }
  if (clientStatus !== 'active') {
    throw new ClientLaunchError(
      'Подписка не активна. Оплатите тариф для продолжения работы.',
      403,
    );
  }

  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedContacts = await countClientContacts(userId, periodStart);
  if (usedContacts + leads.length > limits.max_contacts) {
    const remaining = Math.max(0, limits.max_contacts - usedContacts);
    throw new ClientLaunchError(
      `Лимит контактов: ${limits.max_contacts.toLocaleString('ru-RU')} / мес. ` +
        `Использовано: ${usedContacts.toLocaleString('ru-RU')}. ` +
        `Попытка добавить: ${leads.length.toLocaleString('ru-RU')}. ` +
        `Осталось: ${remaining.toLocaleString('ru-RU')}.`,
      400,
    );
  }

  const instantlyAccountId = resolveInstantlyAccountId(preset!.instantly_account_id);
  const instantlyRequestOptions = { accountId: instantlyAccountId };

  // 4. Заводим запись в журнале запусков (status='uploading'). При сбое
  //    позже обновим её на 'failed'; при успехе — на 'active'.
  const uploadedRows = input.uploadedRows ?? leads.length;
  const journalColumnMapping = input.columnMapping ?? {};

  const { data: launchRow, error: insertErr } = await supabaseInstantly
    .from('client_campaign_launches')
    .insert({
      client_user_id: userId,
      preset_id: preset!.id,
      instantly_account_id: instantlyAccountId,
      campaign_name: sequence.name.trim(),
      sequence_steps: sequence.steps,
      column_mapping: journalColumnMapping,
      uploaded_rows: uploadedRows,
      accepted_rows: 0,
      skipped_rows: 0,
      status: 'uploading',
      // null = «использовать весь пул из пресета». Не-null = клиент явно
      // выбрал подмножество для этой кампании. Используется и для
      // Instantly create payload, и для admin-sync (где override
      // защищает живую кампанию от перетирания при правке пресета).
      email_account_ids: validatedEmailAccountIdsOverride,
    })
    .select()
    .single();

  if (insertErr || !launchRow) {
    await logError('client.launches.run.insert_failed', insertErr, {}, logMeta);
    throw new ClientLaunchError('Не удалось создать запись запуска', 500);
  }

  const launchId = (launchRow as { id: string }).id;
  let instantlyCampaignId: string | null = null;

  try {
    // 5. Создаём кампанию в Instantly.
    const payload = buildCampaignPayloadFromPreset({
      preset: preset!,
      sequence,
      scheduleOverride,
      behaviorOverride,
      emailAccountIdsOverride: validatedEmailAccountIdsOverride ?? undefined,
    });
    const created = await createCampaign(payload, instantlyRequestOptions);
    instantlyCampaignId = (created as { id?: string }).id ?? null;
    if (!instantlyCampaignId) throw new Error('Instantly returned campaign without id');

    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ instantly_campaign_id: instantlyCampaignId })
      .eq('id', launchId);

    if (!hasUsableCampaignSequences(created.sequences)) {
      await updateCampaign(
        instantlyCampaignId,
        { sequences: payload.sequences },
        instantlyRequestOptions,
      );
    }

    // 6. Грузим лидов. skip_if_in_workspace НЕ выставляем (иначе Instantly
    //    пропустит лида, который уже есть в воркспейсе из прошлых кампаний,
    //    и текущая кампания останется пустой). skip_if_in_campaign — да,
    //    дедуп внутри новой кампании безвреден.
    const leadResult = await createLeads(
      leads,
      { campaign_id: instantlyCampaignId, skip_if_in_campaign: true },
      instantlyRequestOptions,
    );

    const accepted = Number(
      (leadResult as { uploaded?: number; created?: number; total_uploaded?: number }).uploaded ??
        (leadResult as { created?: number }).created ??
        (leadResult as { total_uploaded?: number }).total_uploaded ??
        leads.length,
    );
    const skipped = leads.length - accepted;

    // 7. Активируем кампанию + обновляем каталог.
    const activatedCampaign = await activateCampaign(instantlyCampaignId, instantlyRequestOptions);
    await upsertInstantlyCatalogFromCampaign(activatedCampaign, instantlyAccountId);

    // 8. Даём клиенту доступ к ресурсу.
    await supabaseInstantly.from('client_instantly_access').upsert(
      {
        client_user_id: userId,
        resource_type: 'campaign',
        resource_id: instantlyCampaignId,
        instantly_account_id: instantlyAccountId,
        created_by: userId,
      },
      { onConflict: 'client_user_id,resource_type,resource_id' },
    );

    // 9. Финализируем запись журнала.
    await supabaseInstantly
      .from('client_campaign_launches')
      .update({
        status: 'active',
        accepted_rows: accepted,
        skipped_rows: skipped < 0 ? 0 : skipped,
      })
      .eq('id', launchId);

    await logAudit(
      'client.launches.run.success',
      'Client launched campaign',
      {
        instantlyCampaignId,
        accepted,
        skipped,
        totalLeads: leads.length,
        steps: sequence.steps.length,
      },
      logMeta,
    );

    return {
      launch_id: launchId,
      instantly_campaign_id: instantlyCampaignId,
      campaign_name: sequence.name.trim(),
      status: 'active',
      uploaded_rows: uploadedRows,
      accepted_rows: accepted,
      skipped_rows: skipped < 0 ? 0 : skipped,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось запустить кампанию';
    await logError('client.launches.run.launch_failed', err, { instantlyCampaignId }, logMeta);
    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', launchId);
    if (err instanceof ClientLaunchError) throw err;
    throw new ClientLaunchError(message, 500);
  }
}
