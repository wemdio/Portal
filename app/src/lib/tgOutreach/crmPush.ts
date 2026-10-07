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
 *    tg-outreach: контакт `@ник` (ник и в поле Telegram контакта), сделка `@ник · кампания` с тегом оффера,
 *    примечания с перепиской.
 *
 * Очередь отдельная от передач в Telegram: у AMO свои повторы и свои отказы,
 * и живого соединения с Telegram ей не нужно — поэтому крутится на уровне
 * процесса, а не внутри запущенной кампании.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  POLZA_CONTOUR_FIELD_ID,
  POLZA_CONTOUR_TG_OUTREACH,
  POLZA_SOURCE_FIELD_ID,
  POLZA_SOURCE_TG_OUTREACH,
} from '@/lib/crm/connections';
import {
  CRM_PUSH_POLL_INTERVAL_MS,
  activeCrmSettings,
  processCrmQueue,
  type CrmQueueRow,
  type CrmSettings,
} from '@/lib/crm/dealQueue';
import { buildLeadMessage } from './leadMessage';
import { loadLeadOrigin } from './leadOrigin';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export { CRM_PUSH_POLL_INTERVAL_MS, activeCrmSettings, type CrmSettings };

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

interface PushRow extends CrmQueueRow {
  campaign_name: string;
  username: string | null;
  tg_user_id: number | null;
  offer: string | null;
}

/** Один проход по очереди CRM TG-аутрича — общей машиной `lib/crm/dealQueue.ts`. */
export async function processCrmPushes(db: SupabaseClient, log: LogFn): Promise<number> {
  return processCrmQueue<PushRow>(db, {
    table: 'tg_outreach_crm_pushes',
    extraColumns: 'campaign_name, username, tg_user_id, offer',
    log,
    toDeal: (row) => {
      const who = crmContactName(row.username, row.tg_user_id);
      return {
        contact: { name: who, telegram: (row.username ?? '').trim().replace(/^@/, '') || null },
        leadName: row.campaign_name ? `${who} · ${row.campaign_name}` : who,
        tags: row.offer ? [row.offer] : [],
        polzaSelects: [
          { fieldId: POLZA_SOURCE_FIELD_ID, fieldName: 'Источник', value: POLZA_SOURCE_TG_OUTREACH },
          { fieldId: POLZA_CONTOUR_FIELD_ID, fieldName: 'Контур', value: POLZA_CONTOUR_TG_OUTREACH },
        ],
        label: `${who} (${row.campaign_name})`,
      };
    },
  });
}
