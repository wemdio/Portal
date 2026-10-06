/**
 * Переданный лид TG-аутрича → сделка в CRM (amoCRM: наша или клиента).
 *
 * Спека: `docs/superpowers/specs/2026-10-06-tg-outreach-crm-handoff-design.md`.
 *
 * Две половины:
 *  - `enqueueCrmPush` ставит задачу в `tg_outreach_crm_pushes`. Зовут её в
 *    момент, когда лид действительно передан (ручная передача отправлена или
 *    окончательно не ушла; автопередача по интересу случилась). Ошибок наружу
 *    не бросает: сбой CRM не должен мешать лиду дойти до менеджера в чат.
 *  - `processCrmPushes` раз в несколько секунд разбирает очередь в воркере
 *    tg-outreach: контакт `@ник`, сделка `@ник · кампания` с тегом оффера,
 *    примечания с перепиской.
 *
 * Очередь отдельная от передач в Telegram: у AMO свои повторы и свои отказы,
 * и живого соединения с Telegram ей не нужно — поэтому крутится на уровне
 * процесса, а не внутри запущенной кампании.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAuthAmoError, isTransientAmoError, splitNoteText, AmoHttpError, type AmoClient } from '@/lib/crm/amoClient';
import {
  POLZA_SOURCE_FIELD_ID,
  POLZA_SOURCE_TG_OUTREACH,
  resolveCrmConnection,
} from '@/lib/crm/connections';
import { buildLeadMessage } from './leadMessage';
import { loadLeadOrigin } from './leadOrigin';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface CrmSettings {
  enabled: boolean;
  /** `'polza'` — наша AMO, иначе id из `crm_connections`. */
  connection: string;
  pipeline_id: number | null;
  status_id: number | null;
}

export const CRM_PUSH_POLL_INTERVAL_MS = 15_000;
export const CRM_PUSH_RETRY_DELAY_MS = 5 * 60_000;
export const CRM_PUSH_MAX_ATTEMPTS = 5;
/** На сколько задача «занята» опросом — защита от двойной отправки. */
const CRM_PUSH_LEASE_MS = 10 * 60_000;
const CRM_PUSH_BATCH = 10;

/** Настройки кампании, если передача в CRM включена и заполнена; иначе null. */
export function activeCrmSettings(raw: unknown): CrmSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<CrmSettings>;
  if (!s.enabled || typeof s.connection !== 'string' || !s.connection) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  return { enabled: true, connection: s.connection, pipeline_id: num(s.pipeline_id), status_id: num(s.status_id) };
}

/** Имя контакта в CRM: ник с собачкой, а без ника — числовой id. */
export function crmContactName(username: string | null, tgUserId: number | null): string {
  const nick = (username ?? '').trim().replace(/^@/, '');
  if (nick) return `@${nick}`;
  return `TG ID ${tgUserId ?? '—'}`;
}

interface DialogRow {
  id: string;
  tg_user_id: number | null;
  tg_username: string | null;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> | null;
}

export type EnqueueResult = 'queued' | 'disabled' | 'duplicate' | 'error';

/**
 * Поставить лида в очередь CRM. Диалог ищется по id или по (кампания, tg_user_id).
 * `messageText` — карточка, ушедшая менеджеру; без неё соберём такую же.
 */
export async function enqueueCrmPush(db: SupabaseClient, args: {
  campaignId: string;
  dialogId?: string;
  tgUserId?: number;
  messageText?: string | null;
  log?: LogFn;
}): Promise<EnqueueResult> {
  const log = args.log ?? (() => {});
  try {
    const { data: campaign, error: campErr } = await db
      .from('tg_outreach_campaigns')
      .select('id, name, crm_settings')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (campErr) throw new Error(campErr.message);
    const settings = activeCrmSettings((campaign as { crm_settings?: unknown } | null)?.crm_settings);
    if (!campaign || !settings) return 'disabled';
    const campaignName = (campaign as { name: string }).name ?? '';

    let dialogQuery = db
      .from('tg_outreach_dialogs')
      .select('id, tg_user_id, tg_username, messages')
      .eq('campaign_id', args.campaignId);
    if (args.dialogId) dialogQuery = dialogQuery.eq('id', args.dialogId);
    else if (args.tgUserId !== undefined) dialogQuery = dialogQuery.eq('tg_user_id', args.tgUserId);
    else throw new Error('не указан диалог');
    const { data: dialogData, error: dlgErr } = await dialogQuery.maybeSingle();
    if (dlgErr) throw new Error(dlgErr.message);
    const dialog = dialogData as DialogRow | null;
    if (!dialog) throw new Error('диалог не найден');

    const origin = await loadLeadOrigin(db, args.campaignId, dialog.tg_username).catch(() => null);
    const messageText = (args.messageText ?? '').trim()
      ? String(args.messageText)
      : buildLeadMessage({
          kind: 'lead',
          campaignName,
          username: dialog.tg_username,
          tgUserId: dialog.tg_user_id,
          baseName: origin?.baseName ?? null,
          sourceChat: origin?.sourceChat ?? null,
          messages: dialog.messages ?? [],
        });

    const { error: insErr } = await db.from('tg_outreach_crm_pushes').insert({
      campaign_id: args.campaignId,
      dialog_id: dialog.id,
      connection: settings.connection,
      pipeline_id: settings.pipeline_id,
      status_id: settings.status_id,
      campaign_name: campaignName,
      username: dialog.tg_username,
      tg_user_id: dialog.tg_user_id,
      offer: origin?.baseName ?? null,
      message_text: messageText,
    });
    if (insErr) {
      // Уникальный индекс: этот человек уже в CRM или в очереди — вторую сделку не заводим.
      if (insErr.code === '23505') return 'duplicate';
      throw new Error(insErr.message);
    }
    log('info', `CRM: ${crmContactName(dialog.tg_username, dialog.tg_user_id)} поставлен в очередь на создание сделки`);
    return 'queued';
  } catch (err) {
    log('warning', `CRM: не смог поставить лида в очередь — ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

interface PushRow {
  id: string;
  campaign_id: string;
  connection: string;
  pipeline_id: number | null;
  status_id: number | null;
  campaign_name: string;
  username: string | null;
  tg_user_id: number | null;
  offer: string | null;
  message_text: string;
  attempts: number;
  amo_lead_id: number | null;
  amo_contact_id: number | null;
}

/** enum_id «Telegram Outreach» в поле «Источник» — по адресу AMO, на жизнь процесса. */
const sourceEnumCache = new Map<string, number | null>();

async function polzaSourceEnumId(client: AmoClient): Promise<number | null> {
  if (sourceEnumCache.has(client.baseUrl)) return sourceEnumCache.get(client.baseUrl) ?? null;
  const id = await client.findLeadFieldEnumId(POLZA_SOURCE_FIELD_ID, POLZA_SOURCE_TG_OUTREACH);
  sourceEnumCache.set(client.baseUrl, id);
  return id;
}

/**
 * Создать сделку по одной задаче. Промежуточные id пишем сразу: если упадёт
 * на примечании, повтор не заведёт второй контакт и вторую сделку.
 */
async function pushOne(db: SupabaseClient, task: PushRow, log: LogFn): Promise<void> {
  const who = crmContactName(task.username, task.tg_user_id);
  try {
    const { client, isPolza } = await resolveCrmConnection(db, task.connection);
    let warning: string | null = null;

    let contactId = task.amo_contact_id;
    let leadId = task.amo_lead_id;

    if (!leadId) {
      if (!contactId) {
        contactId = (await client.findContactByName(who)) ?? (await client.createContact(who));
        await db.from('tg_outreach_crm_pushes').update({ amo_contact_id: contactId }).eq('id', task.id);
      }

      const customFields: Array<{ field_id: number; values: Array<{ enum_id: number }> }> = [];
      if (isPolza) {
        const enumId = await polzaSourceEnumId(client).catch(() => null);
        if (enumId) customFields.push({ field_id: POLZA_SOURCE_FIELD_ID, values: [{ enum_id: enumId }] });
        else warning = `в поле «Источник» не найдено значение «${POLZA_SOURCE_TG_OUTREACH}» — проставьте руками`;
      }

      const name = task.campaign_name ? `${who} · ${task.campaign_name}` : who;
      leadId = await client.createLead({
        name,
        pipelineId: task.pipeline_id,
        statusId: task.status_id,
        contactId,
        tags: task.offer ? [task.offer.slice(0, 100)] : [],
        customFields,
      });
      await db
        .from('tg_outreach_crm_pushes')
        .update({ amo_lead_id: leadId, lead_url: `${client.baseUrl}/leads/detail/${leadId}` })
        .eq('id', task.id);
    }

    for (const part of splitNoteText(task.message_text)) {
      await client.addLeadNote(leadId, part);
    }

    await db
      .from('tg_outreach_crm_pushes')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: warning })
      .eq('id', task.id);
    log('info', `CRM: сделка ${leadId} создана для ${who} (${task.campaign_name})${warning ? ` — ${warning}` : ''}`);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = task.attempts + 1;
    // Ошибки вне AMO (подключение удалено, нет ключа шифрования) — не сетевые,
    // повтор их не вылечит.
    const transient = err instanceof AmoHttpError && isTransientAmoError(err);
    if (transient && attempts < CRM_PUSH_MAX_ATTEMPTS) {
      await db
        .from('tg_outreach_crm_pushes')
        .update({
          attempts,
          next_attempt_at: new Date(Date.now() + CRM_PUSH_RETRY_DELAY_MS).toISOString(),
          error_message: `Повторю через ${Math.round(CRM_PUSH_RETRY_DELAY_MS / 60_000)} мин: ${msg}`,
        })
        .eq('id', task.id);
      log('warning', `CRM: сделка для ${who} не создана — ${msg}. Повторю через ${Math.round(CRM_PUSH_RETRY_DELAY_MS / 60_000)} мин.`);
      return;
    }
    await db
      .from('tg_outreach_crm_pushes')
      .update({ status: 'failed', attempts, error_message: msg })
      .eq('id', task.id);
    if (isAuthAmoError(err) && task.connection !== 'polza') {
      await db
        .from('crm_connections')
        .update({ status: 'error', last_error: msg, updated_at: new Date().toISOString() })
        .eq('id', task.connection);
    }
    log('error', `CRM: сделка для ${who} НЕ создана (${task.campaign_name}) — ${msg}`);
  }
}

/** Один проход по очереди CRM. Ошибка одной задачи не мешает остальным. */
export async function processCrmPushes(db: SupabaseClient, log: LogFn): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from('tg_outreach_crm_pushes')
    .select('id, campaign_id, connection, pipeline_id, status_id, campaign_name, username, tg_user_id, offer, message_text, attempts, amo_lead_id, amo_contact_id')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(CRM_PUSH_BATCH);
  if (error) throw new Error(error.message);

  let handled = 0;
  for (const task of (data ?? []) as PushRow[]) {
    // Занимаем задачу: если вдруг опросов два, второй её не возьмёт.
    const { data: claimed } = await db
      .from('tg_outreach_crm_pushes')
      .update({ next_attempt_at: new Date(Date.now() + CRM_PUSH_LEASE_MS).toISOString() })
      .eq('id', task.id)
      .eq('status', 'pending')
      .lte('next_attempt_at', nowIso)
      .select('id');
    if (!claimed?.length) continue;
    await pushOne(db, task, log);
    handled++;
  }
  return handled;
}
