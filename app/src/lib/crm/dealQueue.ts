/**
 * Общая очередь «лид → сделка в amoCRM» для всех каналов.
 *
 * Каналы (TG-аутрич — `tg_outreach_crm_pushes`, email-аутрич —
 * `email_lead_crm_pushes`) держат свою таблицу со своими колонками лида, но
 * колонки очереди у них одинаковые: подключение, воронка, этап, карточка,
 * статус, попытки, id контакта и сделки. Этот модуль разбирает любую из них:
 * контакт (найти или создать), сделка, примечания с перепиской, повторы.
 *
 * Спеки: docs/superpowers/specs/2026-10-06-tg-outreach-crm-handoff-design.md,
 * docs/superpowers/specs/2026-10-06-email-outreach-polza-crm-design.md.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AmoHttpError,
  isAuthAmoError,
  isTransientAmoError,
  splitNoteText,
  type AmoClient,
  type AmoTelegramField,
} from './amoClient';
import { POLZA_CONNECTION, POLZA_SOURCE_FIELD_ID, resolveCrmConnection } from './connections';

export type CrmLogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export const CRM_PUSH_POLL_INTERVAL_MS = 15_000;
export const CRM_PUSH_RETRY_DELAY_MS = 5 * 60_000;
export const CRM_PUSH_MAX_ATTEMPTS = 5;
/** На сколько задача «занята» опросом — защита от двойной отправки. */
const CRM_PUSH_LEASE_MS = 10 * 60_000;
const CRM_PUSH_BATCH = 10;

/** Настройки передачи в CRM у кампании или проекта (jsonb `crm_settings`). */
export interface CrmSettings {
  enabled: boolean;
  /** `'polza'` — наша AMO, иначе id из `crm_connections`. */
  connection: string;
  pipeline_id: number | null;
  status_id: number | null;
}

/** Настройки канала (кампании, проекта), если передача в CRM включена и заполнена; иначе null. */
export function activeCrmSettings(raw: unknown): CrmSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<CrmSettings>;
  if (!s.enabled || typeof s.connection !== 'string' || !s.connection) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  return { enabled: true, connection: s.connection, pipeline_id: num(s.pipeline_id), status_id: num(s.status_id) };
}

/** Колонки очереди, общие для всех каналов. */
export interface CrmQueueRow {
  id: string;
  connection: string;
  pipeline_id: number | null;
  status_id: number | null;
  message_text: string;
  attempts: number;
  amo_lead_id: number | null;
  amo_contact_id: number | null;
}

export const CRM_QUEUE_COLUMNS = 'id, connection, pipeline_id, status_id, message_text, attempts, amo_lead_id, amo_contact_id';

/** Что создать в AMO по строке канала. */
export interface CrmDealSpec {
  contact: { name: string; telegram?: string | null; email?: string | null; phone?: string | null };
  leadName: string;
  tags: string[];
  /** Значение поля «Источник» — только в нашей AMO. */
  polzaSource: string;
  /** Кого создаём — в журнал. */
  label: string;
}

/** enum_id значения «Источника» — по адресу AMO и тексту, на жизнь процесса. */
const sourceEnumCache = new Map<string, number | null>();

async function polzaSourceEnumId(client: AmoClient, value: string): Promise<number | null> {
  const key = `${client.baseUrl}::${value}`;
  if (sourceEnumCache.has(key)) return sourceEnumCache.get(key) ?? null;
  const id = await client.findLeadFieldEnumId(POLZA_SOURCE_FIELD_ID, value);
  sourceEnumCache.set(key, id);
  return id;
}

/**
 * Поле Telegram у контактов — по адресу AMO, на жизнь процесса. Неудачный
 * запрос не кешируем и не валим им сделку: ник всё равно будет в имени.
 */
const telegramFieldCache = new Map<string, AmoTelegramField | null>();

async function telegramContactField(client: AmoClient): Promise<AmoTelegramField | null> {
  if (telegramFieldCache.has(client.baseUrl)) return telegramFieldCache.get(client.baseUrl) ?? null;
  try {
    const field = await client.findTelegramContactField();
    telegramFieldCache.set(client.baseUrl, field);
    return field;
  } catch {
    return null;
  }
}

/**
 * Создать сделку по одной задаче. Промежуточные id пишем сразу: если упадёт
 * на примечании, повтор не заведёт второй контакт и вторую сделку.
 */
async function pushOne(db: SupabaseClient, table: string, task: CrmQueueRow, spec: CrmDealSpec, log: CrmLogFn): Promise<void> {
  try {
    const { client, isPolza } = await resolveCrmConnection(db, task.connection);
    let warning: string | null = null;

    let contactId = task.amo_contact_id;
    let leadId = task.amo_lead_id;

    if (!leadId) {
      if (!contactId) {
        const { name, telegram, email, phone } = spec.contact;
        contactId = (await client.findContact({ name, telegram, email }))
          ?? (await client.createContact({
            name,
            telegram,
            telegramField: telegram ? await telegramContactField(client) : null,
            email,
            phone,
          }));
        await db.from(table).update({ amo_contact_id: contactId }).eq('id', task.id);
      }

      const customFields: Array<{ field_id: number; values: Array<{ enum_id: number }> }> = [];
      if (isPolza) {
        const enumId = await polzaSourceEnumId(client, spec.polzaSource).catch(() => null);
        if (enumId) customFields.push({ field_id: POLZA_SOURCE_FIELD_ID, values: [{ enum_id: enumId }] });
        else warning = `в поле «Источник» не найдено значение «${spec.polzaSource}» — проставьте руками`;
      }

      leadId = await client.createLead({
        name: spec.leadName,
        pipelineId: task.pipeline_id,
        statusId: task.status_id,
        contactId,
        tags: spec.tags.map((t) => t.slice(0, 100)).filter(Boolean),
        customFields,
      });
      await db
        .from(table)
        .update({ amo_lead_id: leadId, lead_url: `${client.baseUrl}/leads/detail/${leadId}` })
        .eq('id', task.id);
    }

    for (const part of splitNoteText(task.message_text)) {
      await client.addLeadNote(leadId, part);
    }

    await db
      .from(table)
      .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: warning })
      .eq('id', task.id);
    log('info', `CRM: сделка ${leadId} создана — ${spec.label}${warning ? ` — ${warning}` : ''}`);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = task.attempts + 1;
    // Ошибки вне AMO (подключение удалено, нет ключа шифрования) — не сетевые,
    // повтор их не вылечит.
    const transient = err instanceof AmoHttpError && isTransientAmoError(err);
    const delayMin = Math.round(CRM_PUSH_RETRY_DELAY_MS / 60_000);
    if (transient && attempts < CRM_PUSH_MAX_ATTEMPTS) {
      await db
        .from(table)
        .update({
          attempts,
          next_attempt_at: new Date(Date.now() + CRM_PUSH_RETRY_DELAY_MS).toISOString(),
          error_message: `Повторю через ${delayMin} мин: ${msg}`,
        })
        .eq('id', task.id);
      log('warning', `CRM: сделка не создана — ${spec.label} — ${msg}. Повторю через ${delayMin} мин.`);
      return;
    }
    await db.from(table).update({ status: 'failed', attempts, error_message: msg }).eq('id', task.id);
    if (isAuthAmoError(err) && task.connection !== POLZA_CONNECTION) {
      await db
        .from('crm_connections')
        .update({ status: 'error', last_error: msg, updated_at: new Date().toISOString() })
        .eq('id', task.connection);
    }
    log('error', `CRM: сделка НЕ создана — ${spec.label} — ${msg}`);
  }
}

/** Один проход по очереди канала. Ошибка одной задачи не мешает остальным. */
export async function processCrmQueue<R extends CrmQueueRow>(db: SupabaseClient, args: {
  table: string;
  /** Колонки канала сверх `CRM_QUEUE_COLUMNS`. */
  extraColumns: string;
  toDeal: (row: R) => CrmDealSpec;
  log: CrmLogFn;
}): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from(args.table)
    .select(`${CRM_QUEUE_COLUMNS}, ${args.extraColumns}`)
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(CRM_PUSH_BATCH);
  if (error) throw new Error(error.message);

  let handled = 0;
  for (const task of (data ?? []) as unknown as R[]) {
    // Занимаем задачу: если вдруг опросов два, второй её не возьмёт.
    const { data: claimed } = await db
      .from(args.table)
      .update({ next_attempt_at: new Date(Date.now() + CRM_PUSH_LEASE_MS).toISOString() })
      .eq('id', task.id)
      .eq('status', 'pending')
      .lte('next_attempt_at', nowIso)
      .select('id');
    if (!claimed?.length) continue;
    await pushOne(db, args.table, task, args.toDeal(task), args.log);
    handled++;
  }
  return handled;
}
