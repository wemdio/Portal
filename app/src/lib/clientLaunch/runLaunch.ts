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
import { scrubBrand } from '@/lib/scrubBrand';
import { buildCampaignPayloadFromPreset } from './buildCampaignPayload';
import { validateClientLaunchInput } from './validateLaunchInput';
import type {
  ClientCampaignPreset,
  ClientLaunchBehaviorOverride,
  ClientLaunchColumnMapping,
  ClientLaunchScheduleOverride,
  ClientLaunchSequence,
} from './types';
import { activateCampaign, createCampaign, createLeads, getCampaign, updateCampaign } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { upsertInstantlyCatalogFromCampaign } from '@/lib/tools/instantlyCampaignCatalog';
import { getBlockedEmailSet, filterBlockedLeads } from '@/lib/clientBlocklist/blockedContacts';
import { filterClientDomainLeads } from '@/lib/clientBlocklist/domainPolicy';
import { hasUsableCampaignSequences } from './campaignSequences';
import {
  countClientContacts,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  resolveEffectiveLimits,
  isAwaitingFirstPayment,
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
  /**
   * Сколько лидов отрезано по чёрному списку клиента ДО загрузки в Instantly.
   * Входит в skipped_rows; отдельное поле — чтобы UI мог объяснить причину.
   */
  blocked_rows: number;
  /** Leads excluded by the client-scoped domain policy before provider delivery. */
  domain_policy_blocked_rows?: number;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const ACTIVATION_STATUS_POLL_DELAYS_MS = [0, 500, 1_500] as const;

async function readActiveCampaign(
  campaignId: string,
  requestOptions: { accountId: string },
  delaysMs: readonly number[],
) {
  const statusRequestOptions = {
    ...requestOptions,
    retryRateLimits: false,
    skipRateLimiter: true,
    timeoutMs: 5_000,
  };
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const current = await getCampaign(campaignId, statusRequestOptions);
      if (current.status === 1) return current;
    } catch {
      // A status read is best-effort. Try the next poll before deciding that
      // the activation really failed.
    }
  }
  return null;
}

/**
 * A timed-out activation is ambiguous: Instantly may have completed the
 * mutation after our 90s client timeout. Re-read the same campaign and retry
 * activation once only when it is still not active. This never deletes or
 * creates a replacement campaign.
 */
async function activateCampaignWithTimeoutRecovery(
  campaignId: string,
  requestOptions: { accountId: string },
) {
  try {
    return await activateCampaign(campaignId, requestOptions);
  } catch (error) {
    if (!isAbortError(error)) throw error;

    const current = await readActiveCampaign(campaignId, requestOptions, [0]);
    if (current) return current;

    try {
      return await activateCampaign(campaignId, requestOptions);
    } catch (retryError) {
      // The retry can also time out or report "already active" after Instantly
      // completed the mutation. Poll only this same campaign before surfacing
      // an error; never create or delete a replacement here.
      const activated = await readActiveCampaign(
        campaignId,
        requestOptions,
        ACTIVATION_STATUS_POLL_DELAYS_MS,
      );
      if (activated) return activated;
      throw retryError;
    }
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

  // 1b. Apply the client-scoped domain policy, then the email blocklist,
  //     before validation, tariff accounting, campaign creation, or upload.
  //     A blocklist read failure remains fail-closed.
  const {
    kept: domainAllowedLeads,
    blockedCount: domainPolicyBlockedCount,
  } = filterClientDomainLeads(leads, userId);
  const blockedSet = await getBlockedEmailSet(supabaseInstantly, userId);
  const {
    kept: allowedLeads,
    blockedCount: emailBlockedCount,
  } = filterBlockedLeads(domainAllowedLeads, blockedSet);
  const excludedCount = domainPolicyBlockedCount + emailBlockedCount;

  if (allowedLeads.length === 0) {
    const excludedReason = [
      domainPolicyBlockedCount > 0
        ? `${domainPolicyBlockedCount.toLocaleString('ru-RU')} — доменной политикой (.com)`
        : null,
      emailBlockedCount > 0
        ? `${emailBlockedCount.toLocaleString('ru-RU')} — чёрным списком`
        : null,
    ].filter(Boolean).join(', ');
    throw new ClientLaunchError(
      excludedCount > 0
        ? `Все ${excludedCount.toLocaleString('ru-RU')} лидов из загрузки исключены: ${excludedReason}.`
        : 'Нет валидных лидов для отправки',
      400,
    );
  }

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
    rowCount: allowedLeads.length,
    scheduleOverride,
  });

  if (!validation.ok) {
    throw new ClientLaunchError(validation.error, 400);
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
      'Идёт прогрев почт. Запуск кампаний станет доступен после завершения прогрева (15 дней с момента оплаты). До этого вы можете пользоваться остальными инструментами портала.',
      403,
    );
  }
  if (clientStatus !== 'active') {
    throw new ClientLaunchError(
      'Подписка не активна. Оплатите тариф для продолжения работы.',
      403,
    );
  }
  // Защита от эскалации: неоплаченный клиент после прогрева навсегда становится
  // 'active' (paid_until пуст → 'expired' не срабатывает), поэтому одной проверки
  // статуса мало — режем ещё и «оформил, но не оплатил».
  if (isAwaitingFirstPayment(tariffRow)) {
    throw new ClientLaunchError(
      'Оформлена подписка, но оплата ещё не поступила. Запуск станет доступен после оплаты.',
      403,
    );
  }

  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedContacts = await countClientContacts(userId, periodStart);
  if (usedContacts + allowedLeads.length > limits.max_contacts) {
    const remaining = Math.max(0, limits.max_contacts - usedContacts);
    throw new ClientLaunchError(
      `Лимит контактов: ${limits.max_contacts.toLocaleString('ru-RU')} / мес. ` +
        `Использовано: ${usedContacts.toLocaleString('ru-RU')}. ` +
        `Попытка добавить: ${allowedLeads.length.toLocaleString('ru-RU')}. ` +
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
    if (!instantlyCampaignId) throw new Error('Система рассылки вернула кампанию без идентификатора');

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

    // 6. Грузим лидов. Все workspace-wide skip-флаги явно выключены: по
    //    контракту Instantly `skip_if_in_campaign=true` означает «есть в ЛЮБОЙ
    //    кампании воркспейса», а не только в текущей. Дубли внутри входной базы
    //    уже удалены локально; Instantly отдельно сообщает duplicated_leads для
    //    самой целевой кампании.
    const leadResult = await createLeads(
      allowedLeads,
      {
        campaign_id: instantlyCampaignId,
        skip_if_in_workspace: false,
        skip_if_in_campaign: false,
        skip_if_in_list: false,
      },
      instantlyRequestOptions,
    );

    const accepted = leadResult.leads_uploaded;
    // uploadedRows — число строк в исходной базе. Всё, что не было фактически
    // принято Instantly (невалидные email, локальные дубли, доменная политика,
    // чёрный список и отсев самого Instantly), считаем пропущенным. Обе
    // клиентские причины сохраняем отдельно, чтобы UI их не смешивал.
    const skipped = Math.max(0, uploadedRows - accepted);

    // Сохраняем фактические счётчики сразу после импорта. Если активация ниже
    // оборвётся, журнал всё равно покажет частичный успех вместо ложных 0/0.
    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ accepted_rows: accepted, skipped_rows: skipped })
      .eq('id', launchId);

    if (accepted === 0) {
      throw new ClientLaunchError(
        'Система рассылки не загрузила ни одного контакта. Кампания оставлена в черновиках и не активирована.',
        500,
      );
    }

    // 7. Активируем кампанию + обновляем каталог.
    const activatedCampaign = await activateCampaignWithTimeoutRecovery(
      instantlyCampaignId,
      instantlyRequestOptions,
    );
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
        skipped_rows: skipped,
      })
      .eq('id', launchId);

    await logAudit(
      'client.launches.run.success',
      'Client launched campaign',
      {
        instantlyCampaignId,
        accepted,
        skipped,
        blocked: excludedCount,
        domainPolicyBlocked: domainPolicyBlockedCount,
        emailBlocked: emailBlockedCount,
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
      skipped_rows: skipped,
      blocked_rows: emailBlockedCount,
      domain_policy_blocked_rows: domainPolicyBlockedCount,
    };
  } catch (err) {
    const message = scrubBrand(err instanceof Error ? err.message : 'Не удалось запустить кампанию');
    await logError('client.launches.run.launch_failed', err, { instantlyCampaignId }, logMeta);
    await supabaseInstantly
      .from('client_campaign_launches')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', launchId);
    if (err instanceof ClientLaunchError) throw err;
    throw new ClientLaunchError(message, 500);
  }
}
